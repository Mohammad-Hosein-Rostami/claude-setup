// `status.mjs show`: where the job stands in at most MAX_SHOW_LINES lines: the rows, the open ones, the running agents (when the
// board file exists) and the finish the estimate cache holds. It reads only: the table, the cache, the board; it computes no time.
// Exports: showStatus(statusFile, { now, cacheDir, boardFile }) -> { code, message }; MAX_SHOW_LINES.
// Invariants: every time shown comes from the estimate cache (estimate.mjs is the one source of the finish time); a cache that does
// not match the file says so instead of showing an old time; row ids only, never row text; nothing here writes.
import { readFileSync, statSync } from 'node:fs';
import { listed } from '../estimate/lib/report.mjs';
import { parseWorkItems } from '../estimate/lib/items.mjs';
import { cacheDir as defaultCacheDir, readEntry } from '../estimate/lib/segment-cache.mjs';

export const MAX_SHOW_LINES = 5;
const MS_PER_MIN = 60_000;
const MIN_PER_HOUR = 60;
const MAX_BOARD_BYTES = 16 * 1024;

const isWork = (item) => item.kind !== 'deliver';
const ageText = (ms) => (ms < MS_PER_MIN ? 'just now' : `${Math.round(ms / MS_PER_MIN)} min ago`);
const workText = (minutes) => (minutes < MIN_PER_HOUR ? `${Math.round(minutes)} min` : `${Math.floor(minutes / MIN_PER_HOUR)} h ${String(Math.round(minutes % MIN_PER_HOUR)).padStart(2, '0')}`);

/** The current job's rows: open, or done after the last hand-over. */
function jobRows(items) {
  const handOvers = items.filter((item) => item.kind === 'deliver' && item.done !== null).map((item) => item.done);
  const last = handOvers.length === 0 ? -Infinity : Math.max(...handOvers);
  return items.filter((item) => isWork(item) && (item.done === null || item.done > last));
}

function rowLines(rows) {
  const open = rows.filter((row) => row.done === null);
  const running = open.filter((row) => row.started !== null);
  const waiting = open.filter((row) => row.started === null);
  const lines = [`Rows: ${rows.length - open.length} of ${rows.length} done · ${running.length} running · ${waiting.length} not started`];
  if (open.length > 0) lines.push(`Open: ${listed([...running, ...waiting].map((row) => row.id))}`);
  return lines;
}

/** The finish line from the cache entry, or why there is none. */
function finishLine(statusFile, file, dir, now) {
  const entry = readEntry(dir, statusFile);
  if (entry === null || entry.text === null) return 'Finish: no estimate cached yet (run estimate.mjs STATUS.md)';
  const fresh = entry.mtimeMs === file.mtimeMs && entry.size === file.size;
  const left = entry.numbers?.leftMin;
  const work = Number.isFinite(left) ? ` · ${workText(left)} of work left` : '';
  return `Finish: ${entry.text}${work} (estimate ${ageText(now - entry.computedAt)}${fresh ? '' : ', the table changed since: refreshing'})`;
}

/** The agents line from the session's board file (r9-board), when one exists and reads. */
function agentsLine(boardFile) {
  if (!boardFile) return [];
  try {
    const text = readFileSync(boardFile, 'utf8');
    if (text.length > MAX_BOARD_BYTES) return [];
    const board = JSON.parse(text);
    const agents = Array.isArray(board?.agents) ? board.agents : [];
    const runs = Array.isArray(board?.runs) ? board.runs : [];
    return agents.length + runs.length === 0 ? [] : [`Agents: ${runs.length} runs · ${agents.length} agents${board.stale ? ' (board stale)' : ''}`];
  } catch {
    return []; // no board yet, or one being written: the line is left out
  }
}

/**
 * @param {string} statusFile the real path of STATUS.md
 * @param {{ now?: number, cacheDir?: string, boardFile?: string | null }} [options] the clock (epoch ms), the estimate cache folder, the session's board file
 * @returns {{ code: number, message: string }} 0 with the lines; 1 when the table cannot be read
 */
export function showStatus(statusFile, { now = Date.now(), cacheDir = defaultCacheDir(), boardFile = null } = {}) {
  let text;
  let file;
  try {
    file = statSync(statusFile);
    text = readFileSync(statusFile, 'utf8');
  } catch (error) {
    return { code: 1, message: `cannot read ${statusFile}: ${error.code ?? error.message}` };
  }
  const { items, problems } = parseWorkItems(text);
  if (problems.length > 0) return { code: 1, message: `${statusFile}:${problems[0].line}: ${problems[0].reason}` };
  const lines = [...rowLines(jobRows(items)), ...agentsLine(boardFile), finishLine(statusFile, file, cacheDir, now)];
  return { code: 0, message: lines.slice(0, MAX_SHOW_LINES).join('\n') };
}
