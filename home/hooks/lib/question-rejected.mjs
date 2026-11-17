// Notices that the owner turned an AskUserQuestion down in the terminal ("Chat about this", or Esc): the tool then never runs, so the
// PostToolUse hook (question-answered.mjs) never leaves its mark and the popups would keep opening one after the other.
// Exports: watchTerminalRejection(transcriptPath) -> () => boolean.
// How: Claude Code appends every turned-down tool call to the session transcript (JSONL, `transcript_path` of the hook input) as a `user`
// entry with the top-level field toolDenialKind "user-rejected" (stated in the CLI's own transcript notes, read from 2.1.326); "Chat about
// this" sends the tool result "The user wants to clarify these questions." The returned check reads only what was appended since the
// watch started, and only complete lines, and once it has seen a rejection it keeps answering true.
// Invariants: never throws; an unreadable transcript or a damaged line means "not rejected" (the popups then simply stay as they were).
// A wrong "true" only hands the question to the terminal, which is where it already is, so this fails safe.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

const MAX_READ_BYTES = 1024 * 1024; // one look at the transcript never reads more than this
const NEWLINE = 0x0a;
const USER_REJECTED = 'user-rejected';
const TURNED_DOWN_TEXT = /The user wants to clarify these questions|The user doesn't want to proceed with this tool use/;

/** @returns {boolean} true for a transcript line that records a turned-down tool call */
function isRejection(text) {
  try {
    const entry = JSON.parse(text);
    return entry?.type === 'user' && (entry.toolDenialKind === USER_REJECTED || TURNED_DOWN_TEXT.test(JSON.stringify(entry.message?.content ?? '')));
  } catch {
    return false; // not JSON: a damaged line is not a rejection
  }
}

/** @returns {{size: number, bytes: Buffer} | undefined} the file size and up to MAX_READ_BYTES from `offset`; undefined when the file cannot be read */
function readFrom(path, offset) {
  let descriptor;
  try {
    descriptor = openSync(path, 'r');
    const { size } = fstatSync(descriptor);
    const bytes = Buffer.alloc(Math.min(Math.max(size - offset, 0), MAX_READ_BYTES));
    const bytesRead = readSync(descriptor, bytes, 0, bytes.length, offset);
    return { size, bytes: bytes.subarray(0, bytesRead) };
  } catch {
    return undefined; // missing or unreadable: the check answers false
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * @param {unknown} transcriptPath `transcript_path` of the hook input
 * @returns {() => boolean} a check that is true once a turned-down tool call was appended to the transcript after this call
 */
export function watchTerminalRejection(transcriptPath) {
  if (typeof transcriptPath !== 'string' || transcriptPath === '') return () => false;
  let offset = readFrom(transcriptPath, 0)?.size;
  if (offset === undefined) return () => false;
  let rejected = false;
  return () => {
    if (rejected) return true;
    const found = readFrom(transcriptPath, offset);
    if (!found) return false;
    const lastLineEnd = found.bytes.lastIndexOf(NEWLINE);
    // a line still being written is read next time; one longer than the limit is skipped, or the watch would never move on
    const consumed = lastLineEnd >= 0 ? lastLineEnd + 1 : found.bytes.length === MAX_READ_BYTES ? found.bytes.length : 0;
    offset += consumed;
    rejected = found.bytes.subarray(0, consumed).toString('utf8').split('\n').some(isRejection);
    return rejected;
  };
}
