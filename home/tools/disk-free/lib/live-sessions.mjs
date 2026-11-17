// Which Claude Code sessions are running right now. Exports: liveSessionIds.
// Claude Code writes ~/.claude/sessions/<pid>.json ({ pid, sessionId, ... }) for each running session. A session whose process is
// alive owns its scratchpad folder, however old its transcript is (a resumed session writes into a folder the transcript no longer shows).
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { entriesOf } from './clean-scan.mjs';

const MAX_SESSION_FILE_BYTES = 1 << 16;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0; // not defined on Windows
const NO_BLOCK = constants.O_NONBLOCK ?? 0;

function isAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 only tests that the process exists
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // exists, owned by someone else: still alive
  }
}

/** The text of a plain file of at most MAX_SESSION_FILE_BYTES; null for a link, FIFO, device or bigger file (never followed, never waited on). */
function readPlainFile(file) {
  const fd = openSync(file, constants.O_RDONLY | NO_FOLLOW | NO_BLOCK);
  try {
    if (!fstatSync(fd).isFile()) return null;
    const buffer = Buffer.alloc(MAX_SESSION_FILE_BYTES + 1);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    return length > MAX_SESSION_FILE_BYTES ? null : buffer.toString('utf8', 0, length);
  } finally {
    closeSync(fd);
  }
}

function sessionOf(file) {
  try {
    const text = readPlainFile(file);
    if (text === null) return null;
    const { pid, sessionId } = JSON.parse(text);
    return Number.isInteger(pid) && pid > 0 && typeof sessionId === 'string' && isAlive(pid) ? sessionId : null;
  } catch {
    return null; // unreadable or half-written: another file or the next look will tell
  }
}

/**
 * @param {string | undefined} sessionsFolder usually ~/.claude/sessions; undefined means none are known
 * @returns {Promise<Set<string>>} the ids of the sessions whose process is alive
 */
export async function liveSessionIds(sessionsFolder) {
  const ids = new Set();
  if (sessionsFolder === undefined) return ids;
  for await (const entry of entriesOf(sessionsFolder)) {
    const id = entry.name.endsWith('.json') ? sessionOf(join(sessionsFolder, entry.name)) : null;
    if (id !== null) ids.add(id);
  }
  return ids;
}
