// The text the lead gets at SessionStart (and from `wf-resume.mjs list`): the workflow runs that did not finish, what is done and what is
// left, the git worktrees and branches they own, and exactly how to continue each one.
// Exports: resumeNotice(params, deps) -> string ('' when no run is unfinished), continueCall(record), fullCall(record), MAX_RUNS_LISTED.
// params: { sessionId (null when unknown), cwd, sessionFolder (this session's folder, or null), source: 'startup' | 'resume' | 'compact', nowMs }.
// deps: { registryDir, projectsRoot, estimateStateDir, projectDir (CLAUDE_PROJECT_DIR) }.
// Which runs: this session's (registry file of the session id) plus, unless source is `compact`, the latest other session that launched a run
// in the same cwd (a new session after an exit, a fork, an account switch); a run this session already holds under the same run id (a resume or
// an adopted run) is not listed from the other session. A run whose summary json exists is finished and not listed.
// Continue: the same session -> Workflow({scriptPath, resumeFromRunId, args}); another session -> `wf-resume.mjs adopt` first (it copies the
// journal into this session's folder, the only way the Workflow tool finds it), then the same call. Why the args: a resumed run caches an
// agent only when its prompt is identical, so the args must be the original ones; the notice carries their digest, `wf-resume.mjs call` prints them.
// Liveness: a journal written within LIVE_WINDOW_MIN of now may belong to a run that is still going (another terminal, or this very session
// after a compaction), so it is marked "may still be running"; the exception is a resumed session's own run: its old process is gone.
// Invariants: output is at most MAX_NOTICE_CHARS and MAX_RUNS_LISTED runs; every name comes from a validated record or from git, labels from
// the journal lose control characters; the args text and the prompts never appear; never throws.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { statusFileOf } from '../../../hooks/lib/status-file-of.mjs';
import { latestOtherSession, launchedWithoutArgs, runsOfSession } from './registry.mjs';
import { ownedGit } from './owned-git.mjs';
import { inspectRun } from './run-state.mjs';

export const MAX_RUNS_LISTED = 5;
const MAX_NOTICE_CHARS = 4000;
const RUNS_INSPECTED_PER_SESSION = 10;
const LIVE_WINDOW_MS = 30 * 60_000;
const MS_PER_MINUTE = 60_000;
const TOOL = 'node ~/.claude/tools/wf-resume/wf-resume.mjs';

/** The Workflow call that continues a run (the args stay a placeholder: they are printed only by `wf-resume.mjs call`). */
export const continueCall = (record) => `Workflow({scriptPath: ${JSON.stringify(record.scriptPath)}, resumeFromRunId: ${JSON.stringify(record.runId)}, args: <the same args>})`;

/** The same call with the stored args, for `wf-resume.mjs call` and `adopt` (the lead's own arguments, printed only on request). */
export function fullCall(record) {
  const args = record.args !== undefined ? JSON.stringify(record.args) : launchedWithoutArgs(record) ? null : `<args not stored (digest ${record.argsDigest}): take them from the original call in the old transcript>`;
  const argsPart = args === null ? '' : `, args: ${args}`;
  return `Workflow({scriptPath: ${JSON.stringify(record.scriptPath)}, resumeFromRunId: ${JSON.stringify(record.runId)}${argsPart}})`;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const newestFirst = (runs) => [...runs].sort((a, b) => b.started.localeCompare(a.started));

/** The unfinished runs to show: this session's first, then the other session's; each with the journal state read now. */
function unfinishedEntries(params, deps) {
  const own = params.sessionId === null ? [] : newestFirst(runsOfSession(deps.registryDir, params.sessionId));
  const prior = params.source === 'compact' ? null : latestOtherSession(deps.registryDir, { cwd: params.cwd, exceptSession: params.sessionId });
  const held = new Set(own.map((run) => run.runId));
  const others = prior === null ? [] : newestFirst(prior.runs).filter((run) => !held.has(run.runId));
  const toEntry = (record, isOwn) => ({ record, isOwn, state: inspectRun(join(deps.projectsRoot, record.projectDir, record.sessionId), record, params.nowMs) });
  return [...own.slice(0, RUNS_INSPECTED_PER_SESSION).map((run) => toEntry(run, true)), ...others.slice(0, RUNS_INSPECTED_PER_SESSION).map((run) => toEntry(run, false))]
    .filter((entry) => entry.state.state !== 'finished' && entry.state.state !== 'gone');
}

const mayBeRunning = (entry, params) => entry.state.state === 'unfinished' && entry.state.ageMs < LIVE_WINDOW_MS && !(params.source === 'resume' && entry.isOwn);

function progressLine(state) {
  if (state.state === 'lost') return 'journal not found: nothing to resume from; re-run the script with the same args (a saved workflow skips finished work when given `resume: true`)';
  const cut = state.interruptedCount === 0 ? 'no agent was cut off' : `interrupted: ${state.interrupted.join(', ')}${state.interruptedCount > state.interrupted.length ? ` and ${state.interruptedCount - state.interrupted.length} more` : ''}`;
  return `done: ${plural(state.done, 'agent')}; ${cut}; not reached: ${state.notReached.length === 0 ? 'none known' : state.notReached.join(', ')}`;
}

function gitLine(record) {
  const { worktrees, branches } = ownedGit(record);
  const parts = [...worktrees.map((tree) => `worktree ${tree.path}${tree.branch === null ? '' : ` (${tree.branch})`}`), ...branches.map((branch) => `branch ${branch}`)];
  return parts.length === 0 ? null : `owns: ${parts.join('; ')}`;
}

function entryLines(entry, at, params) {
  const { record, state } = entry;
  const where = entry.isOwn ? 'this session' : `session ${record.sessionId}`;
  const status = state.state === 'lost' ? 'journal lost' : mayBeRunning(entry, params)
    ? `may still be running (journal written ${Math.round(state.ageMs / MS_PER_MINUTE)} min ago): check /workflows before relaunching, a relaunch is refused while its agents live`
    : 'stopped';
  const adopt = entry.isOwn ? '' : `${TOOL} adopt ${record.runId} --into ${JSON.stringify(params.sessionFolder ?? '<this session\'s folder>')}, then `;
  return [
    `${at}. ${record.name} | run ${record.runId} | ${record.row === null ? 'no STATUS row' : `row ${record.row}`} | started ${record.started.slice(0, 16)}Z | ${where} | ${status}`,
    `   ${progressLine(state)}`,
    ...(gitLine(record) === null ? [] : [`   ${gitLine(record)}`]),
    `   script: ${record.scriptPath}${existsSync(record.scriptPath) ? '' : ' (file is gone: start the saved script again)'}; args digest ${record.argsDigest}`,
    `   continue: ${state.state === 'lost' ? 're-run the script' : `${adopt}${continueCall(record)}`}; the exact call with the args: ${TOOL} call ${record.runId}`,
  ];
}

/** The STATUS.md the session (or, for a new session, the other session) last used with status.mjs: its link, after status-deliver's checks. */
function statusLine(entries, params, deps) {
  const sessions = [params.sessionId, ...entries.map((entry) => entry.record.sessionId)].filter((id) => id !== null);
  for (const session_id of new Set(sessions)) {
    const found = statusFileOf({ session_id, cwd: params.cwd }, { stateDir: deps.estimateStateDir, projectDir: deps.projectDir });
    if (found?.path !== undefined) return `STATUS.md last used: ${found.path} (read its Work items and Standing rules first)`;
  }
  return null;
}

/**
 * @param {{ sessionId: string | null, cwd: string, sessionFolder: string | null, source: string, nowMs: number }} params
 * @param {{ registryDir: string, projectsRoot: string, estimateStateDir: string, projectDir?: string }} deps
 * @returns {string} the notice wrapped in <workflow-resume> tags, or '' when no run is unfinished
 */
export function resumeNotice(params, deps) {
  try {
    const entries = unfinishedEntries(params, deps);
    if (entries.length === 0) return '';
    const shown = entries.slice(0, MAX_RUNS_LISTED);
    const status = statusLine(entries, params, deps);
    const lines = [
      '<workflow-resume>',
      `Unfinished workflow runs: ${entries.length}. The process that started them ended first. Continue them before new work: an agent that finished comes back from the journal, one that was cut off restarts from scratch, so use the same script and args. Run /wf-resume to do it for every run.`,
      ...(status === null ? [] : [status]),
      ...(params.sessionFolder === null ? [] : [`This session's folder: ${params.sessionFolder}`]),
      ...shown.flatMap((entry, at) => entryLines(entry, at + 1, params)),
      ...(entries.length > shown.length ? [`and ${entries.length - shown.length} more: ${TOOL} list`] : []),
      '</workflow-resume>',
    ];
    return lines.join('\n').slice(0, MAX_NOTICE_CHARS);
  } catch {
    return '';
  }
}
