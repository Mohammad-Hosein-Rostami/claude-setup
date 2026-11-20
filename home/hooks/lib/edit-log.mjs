// Per-agent log of edited files shared by post-edit.mjs (writer) and typecheck-gate.mjs (reader).
// Exports: tempRoot(), editLogPath(sessionId, agentId), recordEdit(logPath, file), readEdits(logPath), MAX_EDIT_LOG_BYTES.
// Invariants: ids are validated before they become part of a path; every write fails silently (a hook must never
// block an edit because the temp dir is unwritable); a log holds one absolute path per line and may repeat paths.
// The log sits in the shared temp dir, so both sides open it through lib/plain-file.mjs: a link, FIFO or device planted at the log path
// is never followed, written, read or waited on (the Bash guard writes this log too, and a hook that waits is a hook that times out).
// A log the reader cannot use (anything but a plain file within the cap) is reported in the guard log, one line per read, outcome
// `edit-log-unreadable`: the typecheck gate checks nothing for that session then, and that must not pass unseen.
// One size cap for the writer and the reader: a log at the cap takes no more lines, so the reader never meets a larger one it wrote.
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { logDecision } from './guard-log.mjs';
import { appendPlainFile, readPlainFile } from './plain-file.mjs';

const SAFE_ID = /^[\w-]{1,128}$/;
const MAIN_AGENT = 'main';
/** The most an edit log holds, for the writer and the reader alike: 4 MB is about 40,000 paths, far more than one session edits. */
export const MAX_EDIT_LOG_BYTES = 4 * 1024 * 1024;

/** Root of everything the post-edit hooks keep in the temp dir. */
export const tempRoot = () => join(tmpdir(), 'claude-post-edit');

/**
 * Log file for one (session, agent) pair; the main session has no agent id.
 * @param {unknown} sessionId hook input `session_id`
 * @param {unknown} agentId hook input `agent_id` (absent for the main session)
 * @returns {string | null} path, or null when an id is not a safe file name part
 */
export function editLogPath(sessionId, agentId) {
  const agent = agentId ?? MAIN_AGENT;
  if (typeof sessionId !== 'string' || typeof agent !== 'string') return null;
  if (!SAFE_ID.test(sessionId) || !SAFE_ID.test(agent)) return null;
  return join(tempRoot(), 'edits', `${sessionId}--${agent}`);
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
