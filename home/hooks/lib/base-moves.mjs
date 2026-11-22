// Whether a branch move since this session first saw the reflog is the session's own or only another session's (spec-p1-gates-fix 2.3);
// commit-gate.mjs reads it. The base-tip "no full-suite PASS" rule that used to sit here is gone with the test checks.
// Exports: moveVerdict(reflogPath, tipSha, ctx) -> {verdict: 'unwatched'|'own'|'foreign'|'none', watch?, beforeMs?},
//   moveContext(input, env, top, agent).
// Invariants: the reflog is read as a file (no git; no link followed, no FIFO waited on, one region cap); every doubt is own: an
//   unusable log, a shorter file than a size this session recorded, a recorded size or the watch size not at a line start, a broken
//   chain, a line that does not parse, a region over the caps, the deadline, a tool_use id the log lacks. A line is foreign only when no
//   own window covers its offset and another, older session's closed window claims it (lib/change-owner.mjs).
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { readCallWindows, reflogRealPath } from './call-windows.mjs';
import { claimed, missingToolUses, ownsOffset, VERDICT_DEADLINE_MS } from './change-owner.mjs';
import { READ_FLAGS } from './session-store.mjs';

const MAX_REFLOG_ENTRIES = 50;
const MAX_REFLOG_REGION_BYTES = 64 * 1024;
const BEFORE_ENTRY_BYTES = 4096; // the line before the first sight is read from this much before it
const REFLOG_LINE = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) /;
const ENTRY_TIME = /\s(\d{1,12}) [+-]\d{4}(?:\t|$)/;
const NEWLINE = 0x0a;

/** `length` bytes of a plain file from `start`, with its size; null when it is no plain file or cannot be read. */
function readBytes(path, start, length) {
  let fd;
  try {
    fd = openSync(path, READ_FLAGS);
    const stats = fstatSync(fd);
    if (!stats.isFile()) return null;
    const want = Math.max(0, Math.min(length, stats.size - start));
    const buffer = Buffer.alloc(want);
    return { size: stats.size, bytes: buffer.subarray(0, readSync(fd, buffer, 0, want, start)) };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Epoch ms of the reflog line that ends at `bytes` (the entry before a first sight); -Infinity with none; null when unreadable. */
function entryTimeBefore(path, bytes) {
  if (bytes === 0) return -Infinity;
  const start = Math.max(0, bytes - BEFORE_ENTRY_BYTES);
  const read = readBytes(path, start, bytes - start);
  if (read === null || read.bytes.length !== bytes - start || read.bytes.at(-1) !== NEWLINE) return null;
  const found = ENTRY_TIME.exec(read.bytes.subarray(0, -1).toString('utf8').split('\n').at(-1));
  return found === null ? null : Number(found[1]) * 1000;
}

/** Every size this session recorded for reflog `k` (its watch lines and the `b` of every line). */
const recordedSizes = (log, k) => [
  ...log.watches.filter((watch) => watch.k === k).map((watch) => watch.bytes),
  ...log.lines.map((line) => line.b?.[k]).filter((size) => typeof size === 'number'),
];

/**
 * The start offsets of the reflog lines after the watch, checked (2.3 step 2); null when any check says own.
 * @returns {number[] | null}
 */
function regionStarts(path, watch, log, tipSha) {
  const read = readBytes(path, Math.max(0, watch.bytes - 1), MAX_REFLOG_REGION_BYTES + 1);
  if (read === null || read.size < watch.bytes || read.size - watch.bytes > MAX_REFLOG_REGION_BYTES) return null;
  if (recordedSizes(log, watch.k).some((size) => size > read.size)) return null; // the file shrank: lines were cut
  const region = watch.bytes === 0 ? read.bytes : read.bytes.subarray(1);
  if (watch.bytes > 0 && read.bytes[0] !== NEWLINE) return null; // the watch size is not at a line start
  if (region.length > 0 && region.at(-1) !== NEWLINE) return null;
  const starts = [];
  let previous = watch.tip;
  for (let at = 0; at < region.length;) {
    const end = region.indexOf(NEWLINE, at);
    const found = REFLOG_LINE.exec(region.subarray(at, end).toString('utf8'));
    if (found === null || found[1] !== previous) return null; // a line that does not parse, or a broken chain
    starts.push(watch.bytes + at);
    previous = found[2];
    at = end + 1;
  }
  const ends = new Set([...starts, read.size]);
  const misplaced = recordedSizes(log, watch.k).some((size) => size >= watch.bytes && !ends.has(size));
  return starts.length > MAX_REFLOG_ENTRIES || previous !== tipSha || misplaced ? null : starts;
}

/**
 * Own or foreign for the moves of a reflog since this session's newest watch line of it.
 * @param {string} reflogPath the reflog file (logs/refs/heads/<branch> of the shared git folder)
 * @param {string} tipSha the branch's sha now (rev-parse)
 * @param {object} ctx moveContext(...)
 * @returns {{verdict: 'unwatched'|'own'|'foreign'|'none', watch?: object, beforeMs?: number | null}} beforeMs: time of the entry before
 *   an unsettled first sight (-Infinity for a settled watch or none; null when it cannot be read)
 */
export function moveVerdict(reflogPath, tipSha, ctx) {
  try {
    const real = reflogRealPath(reflogPath);
    if (ctx.log.missing === true) return { verdict: 'unwatched' };
    if (!ctx.log.usable) return { verdict: 'own' };
    const watch = ctx.log.watches.filter((line) => line.reflog === real).at(-1);
    if (watch === undefined) return { verdict: 'unwatched' };
    const beforeMs = watch.settled ? -Infinity : entryTimeBefore(real, watch.bytes);
    const starts = regionStarts(real, watch, ctx.log, tipSha);
    if (starts === null || Date.now() > ctx.deadlineMs) return { verdict: 'own', watch, beforeMs };
    if (starts.length === 0) return { verdict: 'none', watch, beforeMs };
    const missing = missingToolUses(ctx);
    if (missing === null || missing.length > 0) return { verdict: 'own', watch, beforeMs };
    const own = starts.some((offset) => ownsOffset(ctx.log, ctx.agent, watch.k, offset) || !claimed(ctx, { reflog: real, offset }));
    return { verdict: own ? 'own' : 'foreign', watch, beforeMs };
  } catch {
    return { verdict: 'own' };
  }
}

/**
 * What the verdicts of one stop read: this session's log (scope `agent`: null for the lead) and the stopping context's transcript.
 * @returns {object} the ctx of lib/change-owner.mjs
 */
export function moveContext(input, env, top, agent = null) {
  const deadlineMs = Date.now() + VERDICT_DEADLINE_MS;
  const transcriptPath = agent === null ? input.transcript_path : input.agent_transcript_path;
  return { env, session: input.session_id, agent, top, transcriptPath, deadlineMs, log: readCallWindows(env, input.session_id, deadlineMs) };
}
