// Finds usage-limit windows in Claude Code lead transcripts (JSONL) and resolves the transcript folder of a project.
// Exports: limitWindows(sources) -> sorted merged [{start,end}] (epoch ms); projectSlug(cwd); resolveTranscriptDir(cwd, root, isDir, stopAt).
// Invariants: pure (the folder check is injected); a window starts at an assistant entry whose model is `<synthetic>` and
// whose text matches /hit your .*limit/i, and ends at the next entry saying "usage limit has reset" or the next
// non-synthetic assistant entry (an unfinished window ends at the transcript's last timestamp); lines are prefiltered by
// substring before JSON.parse because transcripts are large.
import { dirname, join } from 'node:path';

const SYNTHETIC_MODEL = '<synthetic>';
const LIMIT_TEXT = /hit your .*limit/i;
const START_HINT = 'hit your';
const RESET_HINT = 'usage limit has reset';
const ASSISTANT_HINT = '"type":"assistant"';
const TIMESTAMP_HINT = '"timestamp"';

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null; // a truncated or foreign line is not an entry; skipping it is the only sensible reading
  }
}

function textOf(entry) {
  const content = entry.message?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((part) => part?.text ?? '').join('\n') : '';
}

const isAssistant = (entry) => entry.type === 'assistant' && entry.message?.role !== 'user';
const isLimitHit = (entry) => isAssistant(entry) && entry.message?.model === SYNTHETIC_MODEL && LIMIT_TEXT.test(textOf(entry));
const timeOf = (entry) => (typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN);

function windowsOf(source) {
  const lines = typeof source === 'string' ? source.split('\n') : source;
  const windows = [];
  let start = null;
  let lastStampedLine = null;
  for (const line of lines) {
    if (line.includes(TIMESTAMP_HINT)) lastStampedLine = line;
    const wantsStart = start === null && line.includes(START_HINT);
    const wantsEnd = start !== null && (line.includes(RESET_HINT) || line.includes(ASSISTANT_HINT));
    if (!wantsStart && !wantsEnd) continue;
    const entry = parseLine(line);
    const time = entry ? timeOf(entry) : Number.NaN;
    if (Number.isNaN(time)) continue; // entries without a timestamp (request blobs) say nothing about when
    if (start === null) {
      if (isLimitHit(entry)) start = time;
    } else if (line.includes(RESET_HINT) || (isAssistant(entry) && entry.message?.model !== SYNTHETIC_MODEL)) {
      windows.push({ start, end: time });
      start = null;
    }
  }
  if (start !== null) {
    const end = timeOf(parseLine(lastStampedLine ?? '') ?? {});
    if (!Number.isNaN(end)) windows.push({ start, end });
  }
  return windows.filter((w) => w.end > w.start);
}

/** Sorts intervals and merges the overlapping or touching ones. */
export function mergeIntervals(intervals) {
  const merged = [];
  for (const { start, end } of [...intervals].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else merged.push({ start, end });
  }
  return merged;
}

/**
 * Usage-limit windows across lead transcripts.
 * @param {Iterable<string | Iterable<string>>} sources one per transcript: its text, or its lines one at a time (so a huge
 *   file is never held whole in memory); read in order.
 * @returns {{start: number, end: number}[]} sorted, merged, epoch ms.
 */
export function limitWindows(sources) {
  const windows = [];
  for (const source of sources) windows.push(...windowsOf(source));
  return mergeIntervals(windows);
}

/** Claude Code's folder name for a working directory: every non-alphanumeric character becomes `-`. */
export function projectSlug(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * The project's transcript folder: the slug of `cwd`, else of the nearest parent whose folder exists. The walk never
 * reaches `stopAt` (the home folder: its slug holds unrelated work) nor the filesystem root.
 * @param {string} cwd working directory.
 * @param {string} projectsRoot e.g. ~/.claude/projects.
 * @param {(dir: string) => boolean} isDir folder check.
 * @param {string} [stopAt] folder at which the walk up stops, itself not tried.
 * @returns {string | null} folder path or null when none exists.
 */
export function resolveTranscriptDir(cwd, projectsRoot, isDir, stopAt = null) {
  let current = cwd;
  while (dirname(current) !== current && current !== stopAt) {
    const candidate = join(projectsRoot, projectSlug(current));
    if (isDir(candidate)) return candidate;
    current = dirname(current);
  }
  return null;
}
