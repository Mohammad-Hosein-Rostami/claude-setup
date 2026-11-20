// Per-agent log of edited files shared by post-edit.mjs (writer) and typecheck-gate.mjs (reader).
// Exports: tempRoot(), editLogPath(sessionId, agentId), recordEdit(logPath, file), readEdits(logPath), MAX_EDIT_LOG_BYTES.
// Invariants: ids are validated before they become part of a path; every write fails silently (a hook must never
// block an edit because the temp dir is unwritable); a log holds one absolute path per line and may repeat paths.
// The log sits in the shared temp dir, so both sides open it through lib/plain-file.mjs: a link, FIFO or device planted at the log path
// is never followed, written, read or waited on (the Bash guard writes this log too, and a hook that waits is a hook that times out).
// One size cap for the writer and the reader: a log at the cap takes no more lines, so the reader never meets a larger one it wrote.
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

/** Distinct logged paths in first-seen order; [] when there is no log, or when the path holds anything but a plain file within the cap. */
export function readEdits(logPath) {
  let text;
  try {
    text = readPlainFile(logPath, MAX_EDIT_LOG_BYTES);
  } catch {
    return []; // no log, or not a log this hook wrote: nothing was recorded there
  }
  return [...new Set(text.split(/\r?\n/).filter(Boolean))];
}
