// The lead transcript lines the agent-ends tests write: Claude Code's task notification for a background agent's end (the shape
// home/hooks/lib/agent-ends.mjs reads) and filler lines. Exports: TAIL_BYTES, noticeLine, junkText, writeTranscript.
// Invariant: writes only the file it is given.
import { writeFileSync } from 'node:fs';

/** The tail lib/agent-ends.mjs reads (its MAX_READ_BYTES, not exported). */
export const TAIL_BYTES = 16 * 1024 * 1024;
const JUNK_LINE_BYTES = 1024;

/**
 * One task notification line as the lead's transcript holds it.
 * @param {string} id the agent id
 * @param {string} status completed, failed, killed, stopped (an end) or any other status
 * @param {number} at epoch ms of the notice
 * @param {object} [fields] fields that replace the line's own (type, operation, content)
 */
export function noticeLine(id, status, at, fields = {}) {
  const content = `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n</task-notification>`;
  return JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(at).toISOString(), content, ...fields });
}

/** `bytes` of filler, whole lines of JUNK_LINE_BYTES each and a shorter last line; every line ends with a newline. */
export function junkText(bytes) {
  const whole = Math.floor(bytes / JUNK_LINE_BYTES);
  const rest = bytes - whole * JUNK_LINE_BYTES;
  const line = (length) => `${'x'.repeat(length - 1)}\n`;
  return line(JUNK_LINE_BYTES).repeat(whole) + (rest > 0 ? line(rest) : '');
}

/** Writes `lines` (strings, each written with a newline after it) to `path`; returns the path. */
export function writeTranscript(path, lines) {
  writeFileSync(path, lines.map((line) => `${line}\n`).join(''));
  return path;
}
