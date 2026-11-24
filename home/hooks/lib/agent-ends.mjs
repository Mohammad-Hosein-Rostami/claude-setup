// When the main session's transcript shows that a background agent ended. Why: an agent that dies on an API error (a usage limit)
// gets no SubagentStop, so agent-budget.mjs kept counting it in the main-agent cap until its stale age (seen on Claude Code 2.1.330,
// 2026-11-24: a dead dev held a slot and the next dev was denied). Claude Code still queues a task notification for it in the
// lead's transcript, one JSON line per end:
//   {"type":"queue-operation","operation":"enqueue","timestamp":"<ISO time>","content":"<task-notification>\n<task-id>ID</task-id>
//    ... <status>failed</status> ..."}
// with the status completed, failed, killed or stopped. This shape is Claude Code's own and undocumented: a transcript that cannot
// be read, or a line in another shape, shows no end, so the caller falls back to its stale age (never a wrong free slot).
// Exports: agentEndTimes(transcriptPath, agentIds).
// Invariants: read-only; at most MAX_READ_BYTES from the end of the file are read (the ends that matter are the recent ones);
// never throws.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

const MAX_READ_BYTES = 16 * 1024 * 1024; // the tail read: a day of heavy lead work wrote about 8 MB (2026-11-24), and an end that
// matters is newer than the running launch it frees; a bigger read only slows the gate
const ENDED_STATUSES = ['completed', 'failed', 'killed', 'stopped'];
const NOTICE_MARK = '<task-notification>';
const TASK_ID = /<task-id>([^<]*)<\/task-id>/;
const STATUS = /<status>([^<]*)<\/status>/;

/** The last MAX_READ_BYTES of a regular file as text (its first, cut line dropped), or '' when it cannot be read. */
function transcriptTail(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const info = fstatSync(fd);
    if (!info.isFile()) return '';
    const length = Math.min(info.size, MAX_READ_BYTES);
    const bytes = Buffer.alloc(length);
    readSync(fd, bytes, 0, length, info.size - length);
    const text = bytes.toString('utf8');
    return length < info.size ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return ''; // no transcript to read: the caller keeps its stale age
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
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
  const id = TASK_ID.exec(row.content)?.[1];
  const status = STATUS.exec(row.content)?.[1];
  const at = Date.parse(row.timestamp);
  if (id === undefined || !ENDED_STATUSES.includes(status) || !Number.isFinite(at)) return null;
  return { id, at };
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
