// The call-window log: one append-only record per session of when each tool call of the session (and of its agents) was open, and how
// big each watched branch reflog was then. commit-gate.mjs writes it on every tool and stop event; the gates read it to tell own changes
// from changes only another session can have made (lib/change-owner.mjs). Exports: recordCallEdge, watchFolder, addWatch,
//   readCallWindows(env, session, deadlineMs) -> {usable, missing?, lines, windows, watches, folders, firstAt, postHookMs}, parseLog,
//   buildWindows, logFolderOf, reflogPathOf, reflogRealPath, lastReflogLine, the caps, EDGE_SLACK_MS, NO_WINDOW_TOOLS, FILE_TOOLS.
// Store: <HOME>/.claude/state/call-windows/<session>.jsonl (open, close, batch, quiet, watch lines: spec-p1-gates-fix 2.2) and
//   <session>--watch.json ({reflogs: [real path by index k], folders: [folders already resolved]}) under withSessionLock.
// Invariants: never throws; never runs git (`.git` entries are read); every write goes through appendPlainFile (no link followed, no
//   FIFO waited on); a lost line only widens own windows; one cap for writer and reader (P6): a log within MAX_EDGE_LINE_BYTES of
//   MAX_WINDOW_LOG_BYTES may have refused a line, so it reads as unusable.
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { gitDirOf, nearestGitEntry, readFileHead, sharedGitDir } from './agent-brief.mjs';
import { realPathOf } from './own-edits.mjs';
import { appendPlainFile, readPlainFile } from './plain-file.mjs';
import { withSessionLock } from './session-lock.mjs';
import { isPrivateFile, isSessionId, lstatOrNull, privateFolder, READ_FLAGS, readSessionFile, writeSessionFile } from './session-store.mjs';
import { buildWindows, parseLog } from './call-window-build.mjs';

export { buildWindows, parseLog };
export const MAX_WINDOW_LOG_BYTES = 8 * 1024 * 1024;
export const MAX_EDGE_LINE_BYTES = 16 * 1024; // the longest line the writer sends (ids, types and paths are capped below)
export const EDGE_SLACK_MS = 2000; // coarse file-system clocks
export const NO_WINDOW_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'AskUserQuestion', 'ToolSearch', 'Agent', 'Task']);
export const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const BG_TOOLS = new Set(['Workflow', 'Monitor']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const BASH_DEFAULT_TIMEOUT_MS = 120_000; // Claude Code's default when neither the call nor BASH_DEFAULT_TIMEOUT_MS sets one
const HOOK_DEFAULT_TIMEOUT_S = 600; // the documented default of a command hook without `timeout`
const LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_WATCHED_REFLOGS = 12;
const MAX_WATCHED_FOLDERS = 50;
const MAX_ID_CHARS = 200;
const MAX_PATH_CHARS = 1024; // a longer file path is not kept: the call then counts as a program call (wider)
const MAX_BATCH_IDS = 100;
const MAX_TYPES = 20; // task entries kept from one stop; more add 'unknown' (closes no background call)
const MAX_STATE_BYTES = 64 * 1024;
const MAX_SETTINGS_BYTES = 1024 * 1024;
const REFLOG_TAIL_BYTES = 4096;
const BASE_NAMES = ['main', 'master', 'develop'];
const BRANCH_NAME = /^[\w./-]{1,200}$/;
const REFLOG_LINE = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) /;
const HEADS = `${sep}logs${sep}refs${sep}heads${sep}`;

export const logFolderOf = (env) => join(env.HOME || env.USERPROFILE || homedir(), '.claude', 'state', 'call-windows');
const watchId = (session) => `${session}--watch`;
const text = (value, max) => (typeof value === 'string' && value.length <= max ? value : null);

/** The real path of the folder holding `path`, plus its last part: a link or FIFO at the last part stays itself (it is refused when read). */
export function reflogRealPath(path) {
  try {
    return join(realpathSync.native(dirname(path)), basename(path));
  } catch {
    return realPathOf(path);
  }
}

/** The git folders of the worktree holding `folder`, found without git; null when there is none or it cannot be read. */
function gitFoldersOf(folder) {
  try {
    const found = nearestGitEntry(folder);
    const gitDir = found ? gitDirOf(found.top, found.entry) : undefined;
    const shared = gitDir === undefined ? undefined : sharedGitDir(gitDir);
    return shared === undefined ? null : { top: realPathOf(found.top), gitDir, shared };
  } catch {
    return null;
  }
}

/** @returns {string | null} the reflog path of `branch` in the repository holding `folder` (not checked to exist), or null */
export function reflogPathOf(folder, branch) {
  if (typeof branch !== 'string' || !BRANCH_NAME.test(branch) || branch.includes('..')) return null;
  const folders = gitFoldersOf(folder);
  return folders === null ? null : reflogRealPath(join(folders.shared, 'logs', 'refs', 'heads', ...branch.split('/')));
}

/** The branch a worktree's HEAD file names, or null (detached, a link, unreadable). */
function headBranch(gitDir) {
  try {
    if (!lstatOrNull(join(gitDir, 'HEAD'))?.isFile()) return null;
    const found = /^ref: refs\/heads\/(\S+)\s*$/.exec(readFileHead(join(gitDir, 'HEAD'), 512, READ_FLAGS) ?? '');
    return found === null ? null : found[1];
  } catch {
    return null;
  }
}

/**
 * The size of a plain reflog file and the new sha of its last line, read without following a link or waiting on a FIFO.
 * @returns {{size: number, tip: string} | null} null when it is no plain file, does not end in a line break or its last line does not parse
 */
export function lastReflogLine(path) {
  let fd;
  try {
    fd = openSync(path, READ_FLAGS);
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size === 0) return null;
    const length = Math.min(stats.size, REFLOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const tail = buffer.toString('utf8', 0, readSync(fd, buffer, 0, length, stats.size - length));
    if (!tail.endsWith('\n')) return null;
    const found = REFLOG_LINE.exec(tail.slice(0, -1).split('\n').at(-1));
    return found === null ? null : { size: stats.size, tip: found[2] };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The watch record {reflogs, folders}; null when the store is unusable (a link, a FIFO, a damaged file). */
function readWatchState(dir, session) {
  try {
    const raw = readSessionFile(dir, watchId(session), MAX_STATE_BYTES);
    if (raw === undefined) return null;
    const state = raw === null ? {} : JSON.parse(raw);
    const strings = (list) => (Array.isArray(list) ? list.filter((item) => typeof item === 'string') : []);
    return { reflogs: strings(state.reflogs), folders: strings(state.folders) };
  } catch {
    return null;
  }
}

/** Appends one line to the session's log; false when it was not written. */
function appendLine(env, session, line) {
  try {
    const dir = logFolderOf(env);
    const lineText = `${JSON.stringify(line)}\n`;
    if (privateFolder(dir) === undefined || Buffer.byteLength(lineText) > MAX_EDGE_LINE_BYTES) return false;
    return appendPlainFile(join(dir, `${session}.jsonl`), lineText, { maxBytes: MAX_WINDOW_LOG_BYTES });
  } catch {
    return false; // a link (ELOOP), a FIFO nobody reads (ENXIO), no permission: the line is lost, which only widens own windows
  }
}

/** Removes this user's logs untouched for LOG_MAX_AGE_MS (plain files of this folder only). */
function sweepOldLogs(dir, now) {
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.jsonl'))) {
    try {
      const stats = lstatSync(join(dir, name));
      if (isPrivateFile(stats) && now - stats.mtimeMs > LOG_MAX_AGE_MS) unlinkSync(join(dir, name));
    } catch {
      // gone or busy: the next sweep tries again
    }
  }
}

/**
 * Watches a reflog: on its first sight, or `settled` (a gate saw a suite PASS at its tip), writes a `watch` line with its size and tip.
 * @returns {boolean} true when a line was written
 */
export function addWatch(env, session, reflogPath, settled) {
  if (!isSessionId(session) || typeof reflogPath !== 'string') return false;
  const dir = logFolderOf(env);
  return withSessionLock(dir, watchId(session), () => {
    const state = readWatchState(dir, session);
    const real = reflogRealPath(reflogPath);
    const last = state === null ? null : lastReflogLine(real);
    if (last === null || real.length > MAX_PATH_CHARS) return false;
    let k = state.reflogs.indexOf(real);
    if (k >= 0 && !settled) return false;
    if (k < 0) {
      if (state.reflogs.length >= MAX_WATCHED_REFLOGS) return false;
      k = state.reflogs.length;
      if (!writeSessionFile(dir, watchId(session), JSON.stringify({ ...state, reflogs: [...state.reflogs, real] }))) return false;
    }
    sweepOldLogs(dir, Date.now());
    return appendLine(env, session, { t: 'watch', k, reflog: real, bytes: last.size, tip: last.tip, settled: settled === true, at: Date.now() });
  }) === true;
}

/** Resolves `folder` once: a `watch` line naming its worktree, then a watch of main, master, develop and its HEAD branch. */
export function watchFolder(env, session, folder) {
  if (!isSessionId(session) || typeof folder !== 'string' || !isAbsolute(folder) || folder.length > MAX_PATH_CHARS) return;
  const dir = logFolderOf(env);
  const known = readWatchState(dir, session);
  if (known === null || known.folders.includes(folder) || known.folders.length >= MAX_WATCHED_FOLDERS) return;
  const found = withSessionLock(dir, watchId(session), () => {
    const state = readWatchState(dir, session);
    if (state === null || state.folders.includes(folder)) return null;
    if (!writeSessionFile(dir, watchId(session), JSON.stringify({ ...state, folders: [...state.folders, folder] }))) return null;
    const folders = gitFoldersOf(folder);
    if (folders !== null) appendLine(env, session, { t: 'watch', top: folders.top, at: Date.now() });
    return folders;
  });
  if (found === null || found === undefined || typeof found !== 'object') return;
  const branches = new Set([...BASE_NAMES, headBranch(found.gitDir)].filter((name) => name !== null));
  for (const branch of branches) {
    const reflog = reflogPathOf(folder, branch);
    if (reflog !== null && lastReflogLine(reflog) !== null) addWatch(env, session, reflog, false);
  }
}

/** The line one hook event writes (without `b`), or null for an event that writes nothing. */
function edgeLine(input, env) {
  const agent = text(input.agent_id, MAX_ID_CHARS) ?? '';
  const tool = text(input.tool_name, MAX_ID_CHARS) ?? '';
  const id = text(input.tool_use_id, MAX_ID_CHARS);
  const at = Date.now();
  switch (input.hook_event_name) {
    case 'PreToolUse':
      return NO_WINDOW_TOOLS.has(tool) ? null : openLine({ id, agent, tool, at }, input.tool_input ?? {}, env);
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return id === null || NO_WINDOW_TOOLS.has(tool) ? null : { t: 'close', id, agent, at, bg: movedToBackground(input.tool_response) };
    case 'PostToolBatch': {
      const calls = Array.isArray(input.tool_calls) ? input.tool_calls : [];
      const ids = calls.filter((call) => !NO_WINDOW_TOOLS.has(call?.tool_name)).map((call) => text(call?.tool_use_id, MAX_ID_CHARS));
      return { t: 'batch', agent, ids: ids.filter((one) => one !== null).slice(0, MAX_BATCH_IDS), at };
    }
    case 'Stop':
    case 'SubagentStop':
      return Array.isArray(input.background_tasks) ? { t: 'quiet', agent, types: taskTypes(input.background_tasks), at } : null;
    default:
      return null;
  }
}

function openLine(base, toolInput, env) {
  const line = { t: 'open', ...base, bg: toolInput.run_in_background === true || BG_TOOLS.has(base.tool) };
  if (SHELL_TOOLS.has(base.tool)) {
    const own = Number(toolInput.timeout);
    const fallback = Number(env.BASH_DEFAULT_TIMEOUT_MS);
    line.lim = own > 0 ? own : fallback > 0 ? fallback : BASH_DEFAULT_TIMEOUT_MS;
  }
  const file = typeof toolInput.file_path === 'string' ? toolInput.file_path : toolInput.notebook_path;
  if (FILE_TOOLS.has(base.tool) && typeof file === 'string' && isAbsolute(file) && file.length <= MAX_PATH_CHARS) {
    const real = realPathOf(file);
    if (!real.split(sep).includes('.git')) line.path = real;
  }
  return line;
}

const movedToBackground = (response) => response !== null && typeof response === 'object'
  && ((response.backgroundTaskId !== undefined && response.backgroundTaskId !== null && response.backgroundTaskId !== '') || response.timedOutAfterMs !== undefined);

function taskTypes(tasks) {
  const types = tasks.slice(0, MAX_TYPES).map((task) => text(task?.type, MAX_ID_CHARS) ?? 'unknown');
  return tasks.length > MAX_TYPES ? [...types, 'unknown'] : types;
}

const sizeOrNull = (path) => {
  const stats = lstatOrNull(path);
  return stats?.isFile() ? stats.size : null;
};

/**
 * Writes the line of one hook event (PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, Stop, SubagentStop) with the size of
 * each watched reflog, after resolving CLAUDE_PROJECT_DIR and the input's cwd once each.
 * @returns {boolean} true when a line was written
 */
export function recordCallEdge(input, env = process.env) {
  try {
    if (input === null || typeof input !== 'object' || !isSessionId(input.session_id)) return false;
    const line = edgeLine(input, env);
    if (line === null) return false;
    for (const folder of [env.CLAUDE_PROJECT_DIR, input.cwd]) watchFolder(env, input.session_id, folder);
    const reflogs = readWatchState(logFolderOf(env), input.session_id)?.reflogs ?? [];
    if (line.path !== undefined && reflogs.some((reflog) => line.path.startsWith(reflog.slice(0, reflog.indexOf(HEADS) + 1)))) delete line.path;
    return appendLine(env, input.session_id, { ...line, b: reflogs.map(sizeOrNull) });
  } catch {
    return false;
  }
}

/** The largest command-hook timeout (ms) of the given events in <HOME>/.claude/settings.json; the documented default when unreadable. */
function largestHookTimeoutMs(env, events) {
  try {
    const settings = JSON.parse(readPlainFile(join(env.HOME || env.USERPROFILE || homedir(), '.claude', 'settings.json'), MAX_SETTINGS_BYTES));
    const entries = events.flatMap((event) => settings.hooks?.[event] ?? []).flatMap((group) => group.hooks ?? []).filter((hook) => hook.type === 'command');
    const seconds = entries.map((hook) => (Number(hook.timeout) > 0 ? Number(hook.timeout) : HOOK_DEFAULT_TIMEOUT_S));
    return (seconds.length === 0 ? HOOK_DEFAULT_TIMEOUT_S : Math.max(...seconds)) * 1000;
  } catch {
    return HOOK_DEFAULT_TIMEOUT_S * 1000;
  }
}

const UNUSABLE = Object.freeze({ usable: false, lines: [], windows: [], watches: [], folders: [], firstAt: Infinity, postHookMs: 0 });

/**
 * This session's windows as lib/call-window-build.mjs builds them from its log.
 * @param {number} deadlineMs epoch ms: a read that ends later is unusable
 * @returns {{usable: boolean, missing?: boolean, lines: object[], windows: object[], watches: object[], folders: object[], firstAt: number, postHookMs: number}}
 */
export function readCallWindows(env, session, deadlineMs) {
  try {
    const path = join(logFolderOf(env), `${session}.jsonl`);
    const stats = isSessionId(session) ? lstatOrNull(path) : undefined;
    if (stats === null) return { ...UNUSABLE, missing: true };
    if (!stats || !isPrivateFile(stats) || stats.size > MAX_WINDOW_LOG_BYTES - MAX_EDGE_LINE_BYTES) return UNUSABLE;
    const lines = parseLog(readPlainFile(path, MAX_WINDOW_LOG_BYTES - MAX_EDGE_LINE_BYTES));
    if (lines === null || Date.now() > deadlineMs) return UNUSABLE;
    const stopHookMs = largestHookTimeoutMs(env, ['Stop', 'SubagentStop']);
    const postHookMs = largestHookTimeoutMs(env, ['PostToolUse', 'PostToolUseFailure']);
    return { usable: true, lines, firstAt: lines[0]?.at ?? Infinity, postHookMs, ...buildWindows(lines, { stopHookMs }) };
  } catch {
    return UNUSABLE;
  }
}
