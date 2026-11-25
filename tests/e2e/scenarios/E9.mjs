// E9, long-run resume (plan section 9): a one-step job whose boss starts a background lex that waits for a file; the runner
// kills the driver's tree once the lex transcript appears (a lost driver, not a clean pause), creates the file and resumes the
// run. Events must come in order, the resumed boss must get a RESUME-STATE note naming the unfinished lex, and `seen` once.
// Needs `--real-home` (plan-change): long-run reads the token from the account store, which refuses a HOME that is not the
// real one, so under the temp HOME this scenario is NOT RUN. Its state stays in the run root (LONG_RUN_STATE_DIR).
// lex has no Monitor tool (home/agents/lex.md), so its brief waits with a foreground Bash loop instead (plan-change).
// Exports the scenario interface (run.mjs): id, title, model, minutes, needsShims, setup(ctx), run(ctx), check(ctx).
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkLine, fableModels, LIMITS } from '../lib/checks.mjs';
import { eventsInOrder } from '../lib/logs.mjs';
import { assertModel } from '../lib/models.mjs';
import { finalText, readJsonl, sessionsInFolder, userTexts } from '../lib/transcripts.mjs';
import { makeLibrary } from '../lib/repo.mjs';

export const id = 'E9';
export const title = 'long-run: a lost driver, then resume with the unfinished lex';
export const model = 'sonnet';
export const minutes = LIMITS.defaultScenarioMinutes;
export const needsShims = true;

const JOB_MODEL = assertModel('claude-sonnet-5-5'); // long-run takes full ids only; the allowlist still applies
const JOB_NAME = 'e2e-e9';
const STEP = 'wait';
const LEX_WAIT_MS = 15 * 60_000;
const POLL_MS = 5_000;
const WAIT_TIMEOUT_MS = 600_000;
const ORDER = ['run-started', 'step-started', ['driver-lost', 'run-stopped'], 'resumed', 'step-done', 'run-done'];
const SEEN = /\bseen\b/i;
// the word lex alone: not the lex inside lex-web or lex-scout (review round 2, R3)
const LEX_WORD = /(?<![\w-])lex(?![\w-])/;
const NEEDS_REAL_HOME = 'long-run reads its token from the account store, which refuses a temp HOME: run with --real-home (owner opt-in)';
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const namesIn = (dir) => { try { return readdirSync(dir); } catch { return []; } };

const signalFile = (ctx) => join(ctx.dir, 'go-signal');
const jobFile = (ctx) => join(ctx.dir, 'job.json');

export function setup(ctx) {
  makeLibrary(ctx);
  const brief = `Wait until the file ${signalFile(ctx)} exists: run the Bash command until [ -e '${signalFile(ctx)}' ]; do sleep 2; done `
    + `in the foreground with the Bash timeout ${WAIT_TIMEOUT_MS}, again if it times out. Then reply seen.`;
  const job = { name: JOB_NAME, model: JOB_MODEL, cwd: ctx.repo, loopGuards: { maxAttempts: 1, maxStarts: 4 }, stepTimeoutMinutes: 30,
    steps: [{ id: STEP, prompt: `Start one lex agent in the background with this brief: "${brief}" When the lex has replied, end with STEP-RESULT: done.` }] };
  ctx.write(jobFile(ctx), `${JSON.stringify(job, null, 2)}\n`, { label: `one step, model ${JOB_MODEL}` });
}

/** @returns {boolean} true once a lex subagent of a session in the repo's project folder has a meta file */
const lexAppeared = (ctx) => sessionsInFolder(ctx.paths.projectsDir, ctx.repo).some((session) => session.agents.some((agent) => agent.type === 'lex'));

export async function run(ctx) {
  if (!ctx.realHomeMode) {
    ctx.skip(NEEDS_REAL_HOME);
    if (!ctx.dry) return;
  }
  const longRun = ctx.tool('long-run', 'long-run.mjs');
  const driver = ctx.background('long-run-start', process.execPath, [longRun, 'start', jobFile(ctx), '--foreground']);
  ctx.record(`(wait until a lex transcript appears under ${ctx.paths.projectsDir}, at most ${LEX_WAIT_MS / 60_000} min, then SIGKILL the driver's tree)`);
  if (!ctx.dry) {
    for (let waited = 0; waited < LEX_WAIT_MS && !lexAppeared(ctx) && !ctx.run.stopped(); waited += POLL_MS) await pause(POLL_MS);
    ctx.notes.lexSeen = lexAppeared(ctx);
    if (driver.pid() !== null) ctx.notes.killed = ctx.run.registry.killTree(driver.pid());
    ctx.notes.driverExit = await driver.done;
  }
  ctx.write(signalFile(ctx), 'go\n', { label: 'the file the lex waits for' });
  const runId = namesIn(ctx.paths.longRunState).find((name) => name.startsWith(`${JOB_NAME}-`)) ?? '<run-id>';
  ctx.notes.runId = runId;
  const resumed = ctx.background('long-run-resume', process.execPath, [longRun, 'resume', runId, '--foreground']);
  ctx.notes.resumeExit = await resumed.done;
}

export function check(ctx) {
  if (ctx.notRun) return [];
  const events = readJsonl(join(ctx.paths.longRunState, ctx.notes.runId ?? '-', 'events.jsonl'));
  const order = eventsInOrder(events, ORDER);
  const sessions = sessionsInFolder(ctx.paths.projectsDir, ctx.repo);
  const notes = sessions.flatMap((session) => userTexts(session.lines)).filter(({ text }) => text.includes('RESUME-STATE'));
  const lexReplies = sessions.flatMap((session) => session.agents).filter((agent) => agent.type === 'lex')
    .filter((agent) => SEEN.test(finalText(agent.lines)?.text ?? ''));
  return [
    checkLine('the lex transcript appeared before the driver was killed', 'seen', ctx.notes.lexSeen ? 'seen' : 'not seen', ctx.notes.lexSeen === true),
    checkLine('events in order', ORDER.map((step) => [step].flat().join('/')).join(', '), order.ok ? order.seen.join(', ') : `missing ${order.missing}; seen ${order.seen.join(', ') || 'none'}`, order.ok),
    checkLine('the resume note names the unfinished lex', 'a RESUME-STATE note that names lex', notes.length === 0 ? 'no RESUME-STATE note' : `${notes.length} note(s)`,
      notes.some(({ text }) => LEX_WORD.test(text))),
    checkLine('seen appears once', '1 lex reply seen', `${lexReplies.length}`, lexReplies.length === 1),
    checkLine('no Fable model in the job sessions', 'none', [...new Set(sessions.flatMap((session) => fableModels(session)))].join(', ') || 'none',
      sessions.length > 0 && sessions.every((session) => fableModels(session).length === 0)),
    checkLine('the resumed run ended', 'resume exit 0', `exit ${ctx.notes.resumeExit?.code ?? '?'}`, ctx.notes.resumeExit?.code === 0),
  ];
}
