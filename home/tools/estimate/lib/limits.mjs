// Finds usage-limit windows in Claude Code lead transcripts (JSONL) and resolves the transcript folder of a project.
// Exports: limitWindows(jsonlTexts) -> sorted merged [{start,end}] (epoch ms); projectSlug(cwd); resolveTranscriptDir(cwd, root, isDir).
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

function lastTimestamp(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].includes('"timestamp"')) continue;
    const time = timeOf(parseLine(lines[i]) ?? {});
    if (!Number.isNaN(time)) return time;
  }
  return Number.NaN;
}

function windowsOf(text) {
  const lines = text.split('\n');
  const windows = [];
  let start = null;
  for (const line of lines) {
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
    const end = lastTimestamp(lines);
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
 * @param {string[]} jsonlTexts contents of the transcripts (one string per file).
 * @returns {{start: number, end: number}[]} sorted, merged, epoch ms.
 */
export function limitWindows(jsonlTexts) {
  return mergeIntervals(jsonlTexts.flatMap(windowsOf));
}

/** Claude Code's folder name for a working directory: every non-alphanumeric character becomes `-`. */
export function projectSlug(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * The project's transcript folder: the slug of `cwd`, else of the nearest parent whose folder exists (never the filesystem root).
 * @param {string} cwd working directory.
 * @param {string} projectsRoot e.g. ~/.claude/projects.
 * @param {(dir: string) => boolean} isDir folder check.
 * @returns {string | null} folder path or null when none exists.
 */
export function resolveTranscriptDir(cwd, projectsRoot, isDir) {
  let current = cwd;
  while (dirname(current) !== current) {
    const candidate = join(projectsRoot, projectSlug(current));
    if (isDir(candidate)) return candidate;
    current = dirname(current);
  }
  return null;
}
