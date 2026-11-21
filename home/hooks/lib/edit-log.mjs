// Per-agent log of edited files, written by post-edit.mjs (Edit, Write) and bash-writes.mjs (Bash), read by typecheck-gate.mjs; and the
// per-user hook temp root all post-edit state lives in (edit logs, agent and lead Bash counters, Bash before-records, build info).
// Exports: tempRoot(), checkedTempRoot(), editLogPath(sessionId, agentId), recordEdit(logPath, file), readEdits(logPath), MAX_EDIT_LOG_BYTES.
// The root: `<os.tmpdir()>/claude-post-edit` when the temp folder is private to this user (owned by the uid, no group or other write bit:
// macOS's per-user TMPDIR, a test's own temp folder; Windows always, where %TEMP% is per user), else `claude-post-edit-<uid>` (Linux's
// shared /tmp): two names so the existing folder and the tests that build the old name keep working where the temp folder is private.
// checkedTempRoot() checks it before every use (POSIX): made 0700 when missing, opened without following a link or waiting, and kept only
// when it is a folder owned by this uid with no group or other write bit. One with group or other read or search bits only (0755, what
// earlier versions made) is tightened to 0700: nobody else could write it, so it holds nothing another user put there. One others may
// write is refused, not repaired. Refused: nothing is kept there and one guard-log line per process says so (`temp-root-refused`).
// Invariants: ids are validated before they become part of a path; every write fails silently (a hook must never block an edit because
// the temp dir is unwritable); a log holds one absolute path per line and may repeat paths.
// Both sides open the log through lib/plain-file.mjs: a link, FIFO or device planted at the log path is never followed, written, read or
// waited on (a hook that waits is a hook that times out). A log the reader cannot use (anything but a plain file within the cap) is
// reported in the guard log, one line per read, outcome `edit-log-unreadable`: the typecheck gate checks nothing for that session then.
// One size cap for the writer and the reader: a log at the cap takes no more lines, so the reader never meets a larger one it wrote.
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { logDecision } from './guard-log.mjs';
import { appendPlainFile, readPlainFile } from './plain-file.mjs';

const SAFE_ID = /^[\w-]{1,128}$/;
const MAIN_AGENT = 'main';
/** The most an edit log holds, for the writer and the reader alike: 4 MB is about 40,000 paths, far more than one session edits. */
export const MAX_EDIT_LOG_BYTES = 4 * 1024 * 1024;

const ROOT_NAME = 'claude-post-edit';
const ROOT_MODE = 0o700;
const OTHERS_WRITE = 0o022;
const OTHERS_ANY = 0o077;
const IS_WINDOWS = process.platform === 'win32';
const ROOT_OPEN_FLAGS = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** True when the temp folder is this user's alone (owned by the uid, no group or other write bit); false when shared or unreadable. */
function privateTempFolder(dir) {
  try {
    const stat = statSync(dir);
    return stat.uid === process.getuid() && (stat.mode & OTHERS_WRITE) === 0;
  } catch {
    return false; // unreadable: treated as shared, so the root gets the uid name
  }
}

/**
 * Root of everything the post-edit hooks keep in the temp dir. Not checked: build a path with it only under a root checkedTempRoot()
 * already passed in this process, or call checkedTempRoot().
 * @returns {string} `<tmp>/claude-post-edit` where the temp folder is private (and on Windows), `<tmp>/claude-post-edit-<uid>` where shared
 */
export function tempRoot() {
  const dir = tmpdir();
  return IS_WINDOWS || privateTempFolder(dir) ? join(dir, ROOT_NAME) : join(dir, `${ROOT_NAME}-${process.getuid()}`);
}

/** Why the root at `root` may not be used, or null when it may (a 0755 one is tightened to 0700 on the opened descriptor). */
function rootProblem(root) {
  try {
    mkdirSync(root, { mode: ROOT_MODE });
  } catch (error) {
    if (error?.code !== 'EEXIST') return `not creatable (${error?.code ?? 'error'})`;
  }
  if (IS_WINDOWS) return lstatSync(root).isDirectory() ? null : 'not a folder'; // a link is not a directory to lstat; no uid, no mode bits
  let fd;
  try {
    fd = openSync(root, ROOT_OPEN_FLAGS);
  } catch (error) {
    if (error?.code !== 'ELOOP' && error?.code !== 'ENOTDIR') return `not openable (${error?.code ?? 'error'})`;
    return lstatSync(root).isSymbolicLink() ? 'a link' : 'not a folder'; // macOS gives ENOTDIR for a link opened with O_DIRECTORY
  }
  try {
    const stat = fstatSync(fd);
    if (stat.uid !== process.getuid()) return 'owned by another user';
    if (stat.mode & OTHERS_WRITE) return 'writable by other users';
    if (stat.mode & OTHERS_ANY) fchmodSync(fd, ROOT_MODE);
    return null;
  } finally {
    closeSync(fd);
  }
}

const refusedRoots = new Set();

/**
 * The temp root after its check (module header): the path to use, or null when it is refused. A refusal writes one guard-log line per
 * process and root; the root path, last in it so the log's 200-character cut takes only the path, comes from the environment.
 * @returns {string | null}
 */
export function checkedTempRoot() {
  const root = tempRoot();
  let why;
  try {
    why = rootProblem(root);
  } catch (error) {
    why = `not checkable (${error?.code ?? 'error'})`;
  }
  if (why === null) return root;
  if (!refusedRoots.has(root)) {
    refusedRoots.add(root);
    const reason = `hook temp folder refused, ${why}: no edit log, counter or Bash-write record is kept there; remove it if it is yours: ${root}`;
    logDecision({ hook: 'edit-log', tool: 'temp-root', decision: 'skip', outcome: 'temp-root-refused', reason, command: '' });
  }
  return null;
}

/**
 * Log file for one (session, agent) pair; the main session has no agent id.
 * @param {unknown} sessionId hook input `session_id`
 * @param {unknown} agentId hook input `agent_id` (absent for the main session)
 * @returns {string | null} path, or null when an id is not a safe file name part or the temp root is refused
 */
export function editLogPath(sessionId, agentId) {
  const agent = agentId ?? MAIN_AGENT;
  if (typeof sessionId !== 'string' || typeof agent !== 'string') return null;
  if (!SAFE_ID.test(sessionId) || !SAFE_ID.test(agent)) return null;
  const root = checkedTempRoot();
  return root === null ? null : join(root, 'edits', `${sessionId}--${agent}`);
}

/** Appends `file` to the log; never throws. */
export function recordEdit(logPath, file) {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendPlainFile(logPath, `${file}\n`, { maxBytes: MAX_EDIT_LOG_BYTES });
  } catch {
    // unwritable temp dir: the gate then has nothing to check, which is better than blocking the edit
  }
}

const MISSING_FILE = 'ENOENT';

/** One guard-log line for a log path that holds something the reader will not open or read (the file name is two validated ids). */
function reportUnreadable(logPath, error) {
  const reason = `the edit log ${basename(logPath)} is not a plain file within ${MAX_EDIT_LOG_BYTES} bytes (${error?.code ?? 'unreadable'}): its edits are not checked`;
  logDecision({ hook: 'typecheck-gate', tool: 'edit-log', decision: 'skip', outcome: 'edit-log-unreadable', reason, command: '' });
}

/**
 * Distinct logged paths in first-seen order; [] when there is no log. A path that holds anything but a plain file within the cap (a link,
 * a FIFO, a folder, a larger file) gives [] as well, and is reported in the guard log.
 */
export function readEdits(logPath) {
  let text;
  try {
    text = readPlainFile(logPath, MAX_EDIT_LOG_BYTES);
  } catch (error) {
    if (error?.code !== MISSING_FILE) reportUnreadable(logPath, error);
    return []; // no log, or not a log this hook wrote: nothing was recorded there
  }
  return [...new Set(text.split(/\r?\n/).filter(Boolean))];
}
