// Purpose: what the owner (or a controller session) reads about runs: the run status word, short `status` lines, `--json`, and the
//   summary file `summary.md` (M3) rewritten at every hold and at the end.
// Exports: RUN_STATES, runState, runView, statusLines, writeSummary, formatWhen.
// Invariants: reads only; one line per run, step or session (spec 19.4); a question text is shown on the owner's own machine
//   (status, summary) and never leaves it (notify.mjs sends no text); times are shown in local time with Intl, stored as UTC ISO.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRIVATE_FILE_MODE } from '../../account/lib/private-fs.mjs';
import { units } from './job.mjs';
import { driverAlive, readJournal, readJson, readRunJob } from './run-store.mjs';

/** Every status word of a run (spec 7.9). */
export const RUN_STATES = ['running', 'waiting-limit', 'waiting-retry', 'held', 'paused', 'taken-over', 'done', 'stopped', 'stale', 'abandoned'];
const SETTLED = new Set(['done', 'abandoned', 'stopped']);
const MS_PER_MINUTE = 60 * 1000;
const HOLD_WORDS = { paused: 'paused', 'taken-over': 'taken-over' };

/** A UTC ISO time as local date and time, e.g. `Mon 24 Nov, 15:47`. */
export function formatWhen(iso, locale = undefined) {
  if (!iso) return '-';
  return new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

function liveState(driver) {
  const states = Object.values(driver.live ?? {}).map((entry) => entry.state);
  if (states.length > 0 && states.every((state) => state === 'waiting-limit')) return 'waiting-limit';
  if (states.length > 0 && states.every((state) => state === 'waiting-retry')) return 'waiting-retry';
  return 'running';
}

/**
 * The status word of a run (spec 7.9).
 * @param {Record<string, string>} paths runPaths().
 * @param {Date} now the current time.
 * @returns {string} one of RUN_STATES.
 */
export function runState(paths, now = new Date()) {
  const driver = readJson(paths.driver);
  if (!driver) return 'stale';
  if (SETTLED.has(driver.status)) return driver.status;
  if (driver.status === 'held') return HOLD_WORDS[driver.hold?.status] ?? 'held';
  if (driver.status === 'paused') return 'paused';
  return driverAlive(paths, now) ? liveState(driver) : 'stale';
}

function sessionOf(paths, unit, journal, driver) {
  const live = driver?.live?.[unit.id];
  const held = journal?.final?.status;
  const takenOver = journal?.last === 'taken-over' && !journal.running ? 'taken-over' : null;
  const state = live ? live.state : takenOver ?? (held === 'paused' ? held : null);
  if (!state || !journal?.sessionId) return null;
  const log = journal.startsLog.at(-1)?.log;
  return { step: unit.id, state, account: journal.account, sessionId: journal.sessionId, folder: journal.folder, log: log ? join(paths.dir, log) : null, since: live?.since ?? journal.startsLog.at(-1)?.at ?? null, until: live?.until ?? null };
}

/**
 * Everything `status <run>` shows, as data.
 * @param {Record<string, string>} paths runPaths().
 * @param {Date} now the current time.
 * @returns {object} `{ runId, name, state, account, steps: [...], sessions: [...], hold }`.
 */
export function runView(paths, now = new Date()) {
  const job = readRunJob(paths);
  const run = readJson(paths.run) ?? {};
  const driver = readJson(paths.driver);
  const alive = driverAlive(paths, now);
  const steps = [];
  const sessions = [];
  for (const unit of units(job)) {
    const journal = readJournal(paths, unit.id);
    steps.push({
      id: unit.id, kind: unit.kind, status: journal?.final?.status ?? (journal ? (journal.running && alive ? 'running' : 'started') : 'not started'),
      starts: journal?.totalStarts ?? 0, attempts: journal?.attempts ?? 0, waitUntil: journal?.waitUntil ?? journal?.nextAttemptAt ?? null,
      question: journal?.final?.question ?? null, reason: journal?.final?.reason ?? null,
    });
    const session = sessionOf(paths, unit, journal, alive ? driver : null);
    if (session) sessions.push(session);
  }
  return { runId: paths.runId, name: job.name, state: runState(paths, now), account: run.account ?? null, startedBy: run.startedBy ?? null, steps, sessions, hold: driver?.hold ?? null };
}

const stepLine = (step) => [
  `  ${step.id}`, step.status, `starts=${step.starts}`, step.attempts ? `attempts=${step.attempts}` : '',
  step.waitUntil && !['done', 'skipped'].includes(step.status) ? `resumes ${formatWhen(step.waitUntil)}` : '',
  step.reason ? `(${step.reason})` : '', step.question ? `question: ${step.question}` : '',
].filter(Boolean).join(' ');

const sessionLine = (session) => [
  `  session ${session.step}`, session.state, `account=${session.account}`, `id=${session.sessionId}`, session.until ? `until ${formatWhen(session.until)}` : '',
  `since ${formatWhen(session.since)}`, `log=${session.log}`,
].filter(Boolean).join(' ');

/**
 * The short lines of `status`.
 * @param {object[]} views runView() of each run.
 * @param {boolean} detailed one run: a line per step and per session; all runs: one line per run.
 * @returns {string[]}
 */
export function statusLines(views, detailed) {
  if (views.length === 0) return ['no runs'];
  if (!detailed) {
    return views.map((view) => {
      const done = view.steps.filter((step) => step.status === 'done').length;
      const live = view.sessions.length > 0 ? ` sessions=${view.sessions.length}` : '';
      return `${view.runId} ${view.state} account=${view.account} done=${done}/${view.steps.length}${live}`;
    });
  }
  const [view] = views;
  const hold = view.hold ? [`  held at ${view.hold.stepId}: ${view.hold.status}${view.hold.question ? ` - ${view.hold.question}` : ''}`] : [];
  return [`${view.runId} ${view.state} account=${view.account}`, ...view.steps.map(stepLine), ...view.sessions.map(sessionLine), ...hold];
}

function minutes(ms) {
  return `${Math.round((ms ?? 0) / MS_PER_MINUTE)} min`;
}

function summaryRow(paths, unit) {
  const journal = readJournal(paths, unit.id);
  if (!journal) return `| ${unit.id} | not started | 0 | 0 | - | - | - | - |`;
  const tokens = journal.tokens ?? {};
  const tokenText = `in ${tokens.input ?? 0}, cache write ${tokens.cacheCreation ?? 0}, cache read ${tokens.cacheRead ?? 0}, out ${tokens.output ?? 0}`;
  const where = journal.branch ? `${journal.branch} at ${journal.worktree}` : journal.folder;
  const status = journal.final ? `${journal.final.status}${journal.final.reason ? ` (${journal.final.reason})` : ''}` : journal.last ?? 'started';
  return `| ${unit.id} | ${status} | ${journal.totalStarts} | ${journal.attempts} | ${minutes(journal.wallMs)} | ${tokenText} | ${journal.headBefore ?? '-'} -> ${journal.headAfter ?? '-'} | ${where} |`;
}

/**
 * Rewrites `<run>/summary.md` (M3).
 * @param {Record<string, string>} paths runPaths().
 * @param {{nextCommand: string, now?: Date}} context the command that continues the run (or `none`).
 */
export function writeSummary(paths, { nextCommand, now = new Date() }) {
  const view = runView(paths, now);
  const job = readRunJob(paths);
  const questions = view.steps.filter((step) => step.question && step.status === 'needs-owner').map((step) => `- ${step.id}: ${step.question}`);
  const lines = [
    `# long-run ${view.runId}`, '', `Status: ${view.state}. Account: ${view.account}. Written ${formatWhen(now.toISOString())}.`, '',
    '| Step | Outcome | Starts | Attempts | Wall time | Tokens (information only) | HEAD before -> after | Branch and folder |',
    '|---|---|---|---|---|---|---|---|', ...units(job).map((unit) => summaryRow(paths, unit)), '',
    '## Questions for you', '', ...(questions.length > 0 ? questions : ['none']), '',
    '## Next', '', `\`${nextCommand}\``, '',
    'Item branches of parallel groups are never landed by the runner: land each with the usual land script.',
    'Windows: a scheduled start missed while the machine slept is not run later (spec U13).',
  ];
  writeFileSync(paths.summary, `${lines.join('\n')}\n`, { mode: PRIVATE_FILE_MODE });
}
