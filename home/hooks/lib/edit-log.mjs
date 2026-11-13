// Per-agent log of edited files shared by post-edit.mjs (writer) and typecheck-gate.mjs (reader).
// Exports: tempRoot(), editLogPath(sessionId, agentId), recordEdit(logPath, file), readEdits(logPath).
// Invariants: ids are validated before they become part of a path; every write fails silently (a hook must never
// block an edit because the temp dir is unwritable); a log holds one absolute path per line and may repeat paths.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SAFE_ID = /^[\w-]{1,128}$/;
const MAIN_AGENT = 'main';

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
    appendFileSync(logPath, `${file}\n`);
  } catch {
    // unwritable temp dir: the gate then has nothing to check, which is better than blocking the edit
  }
}

/** Distinct logged paths in first-seen order; [] when there is no log. */
export function readEdits(logPath) {
  if (!existsSync(logPath)) return [];
  return [...new Set(readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean))];
}
