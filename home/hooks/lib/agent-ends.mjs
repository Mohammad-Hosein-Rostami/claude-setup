// When the main session's transcript shows that a background agent ended. Why: an agent that dies on an API error (a usage limit)
// gets no SubagentStop, so agent-budget.mjs kept counting it in the main-agent cap until its stale age (seen on Claude Code 2.1.330,
// 2026-11-24: a dead dev held a slot and the next dev was denied). Claude Code still queues a task notification for it in the
// lead's transcript, one JSON line per end:
//   {"type":"queue-operation","operation":"enqueue","timestamp":"<ISO time>","content":"<task-notification>\n<task-id>ID</task-id>
//    ... <status>failed</status> ..."}
// with the status completed, failed, killed or stopped. Only the harness's own structure counts: the content starts with the
// notice tag, then the task id, then only the header fields Claude Code writes before the status (tool-use-id, output-file), then
// the status. A queued message that quotes such text anywhere else (a user's or an agent's message) is no end. This shape is
// Claude Code's own and undocumented: a transcript that cannot be read, or a line in another shape, shows no end, so the caller
// falls back to its stale age.
// Exports: agentEndTimes(transcriptPath, agentIds).
// Invariants: read-only; at most MAX_READ_BYTES from the end of the file are read (the ends that matter are the recent ones);
// never throws.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

const MAX_READ_BYTES = 16 * 1024 * 1024; // the tail read: a day of heavy lead work wrote about 8 MB (2026-11-24), and an end that
// matters is newer than the running launch it frees; a bigger read only slows the gate
const ENDED_STATUSES = ['completed', 'failed', 'killed', 'stopped'];
const NOTICE_MARK = '<task-notification>';
// The notice header as Claude Code 2.1.330 writes it: `<task-notification>\n<task-id>ID</task-id>\n<tool-use-id>..</tool-use-id>\n
// <output-file>..</output-file>\n<status>S</status>\n` (the two middle fields may be absent), anchored at the start of the content.
const NOTICE_HEADER = /^<task-notification>\n<task-id>([\w-]+)<\/task-id>\n(?:<(tool-use-id|output-file)>[^<\n]*<\/\2>\n)*<status>([a-z_]+)<\/status>\n/;

/**
 * The last MAX_READ_BYTES of a regular file as text, whole lines only, or '' when it cannot be read. One byte more is read before
 * the tail: when it is a newline the tail starts on a line and is kept whole; otherwise the cut first line is dropped.
 */
function transcriptTail(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const info = fstatSync(fd);
    if (!info.isFile()) return '';
    if (info.size <= MAX_READ_BYTES) return readBytes(fd, info.size, 0);
    const text = readBytes(fd, MAX_READ_BYTES + 1, info.size - MAX_READ_BYTES - 1);
    return text.slice(text.indexOf('\n') + 1); // from the first whole line (index 0: the byte before the tail ends a line)
  } catch {
    return ''; // no transcript to read: the caller keeps its stale age
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** `length` bytes of an open file from `position`, as text. */
function readBytes(fd, length, position) {
  const bytes = Buffer.alloc(length);
  readSync(fd, bytes, 0, length, position);
  return bytes.toString('utf8');
}

/** The agent id and end time (epoch ms) of one transcript line, or null when the line is no agent's end notice. */
function endOfLine(line) {
  if (!line.includes(NOTICE_MARK) || !line.includes('"queue-operation"')) return null; // cheap test before the parse
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    return null; // a line in another shape shows no end
  }
  if (row?.type !== 'queue-operation' || row.operation !== 'enqueue' || typeof row.content !== 'string') return null;
  const header = NOTICE_HEADER.exec(row.content);
  const at = Date.parse(row.timestamp);
  if (header === null || !ENDED_STATUSES.includes(header[3]) || !Number.isFinite(at)) return null;
  return { id: header[1], at };
}

/**
 * The time each of `agentIds` last ended, as the lead's transcript shows it (see the header).
 * @param {unknown} transcriptPath the hook input's transcript_path (the main session's transcript)
 * @param {string[]} agentIds the agent ids to look for
 * @returns {Map<string, number>} agent id -> epoch ms of its latest end notice; an agent with none is absent
 */
export function agentEndTimes(transcriptPath, agentIds) {
  const ends = new Map();
  if (typeof transcriptPath !== 'string' || transcriptPath === '' || agentIds.length === 0) return ends;
  const wanted = new Set(agentIds);
  for (const line of transcriptTail(transcriptPath).split('\n')) {
    const end = endOfLine(line);
    if (end !== null && wanted.has(end.id) && end.at > (ends.get(end.id) ?? 0)) ends.set(end.id, end.at);
  }
  return ends;
}
