// The old status line's second and third lines: the job's progress bar and one line per live workflow run. No longer drawn: the
// rows are home/tools/board/lib/render.mjs now; this file stays until its tests (tests/workflow-runs.test.mjs) move to the render's.
// Exports: progressLines(progress, runs, { columns, color }) -> string[] (the bar line first when there is progress, then up to
// MAX_RUN_LINES run lines; [] when there is nothing to show).
// Look (spec U7): `██████░░░░░░ 54% · 5/9 rows · 30 min left · moved`; 12 cells from BAR_WIDE_COLUMNS columns, 8 from BAR_NARROW_COLUMNS,
// no bar below; `~` before an approximate percent; the minutes left only on the wide bar; green, yellow for the tags moved and +rows, red for overdue.
// Without color the glyphs are `#` and `-` and there are no escape codes (NO_COLOR). Run line: `wf build impl-a · Review (3/4) · 5/7 agents`.
// Invariants: pure; no line is longer than `columns` characters (a longer one is cut and ends with `…`); the estimate's text modules are not
// imported, so a render stays light. Progress comes from the cache (checked by segment-cache.mjs), runs from workflow-runs.mjs (cleaned there).

const BAR_WIDE_COLUMNS = 100;
const BAR_NARROW_COLUMNS = 70;
const WIDE_CELLS = 12;
const NARROW_CELLS = 8;
const MAX_RUN_LINES = 2;
const MIN_PER_HOUR = 60;
const PERCENT = 100;
const SEPARATOR = ' · ';
const RESET = '\u001b[0m';
const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';
const RED = '\u001b[31m';
const DIM = '\u001b[2m';
const COLOR_OF_TAG = { moved: YELLOW, '+rows': YELLOW, overdue: RED };

/** Cut to `columns` characters, ending with an ellipsis when something was cut. */
function fitted(text, columns) {
  const chars = [...text];
  return chars.length <= columns ? text : `${chars.slice(0, Math.max(0, columns - 1)).join('')}…`;
}

const paint = (text, color, code) => (color ? `${code}${text}${RESET}` : text);

/** Work minutes as `30 min` under an hour, else `2 h 05` (report.mjs workText, repeated here to keep this file light). */
const leftText = (minutes) => (minutes < MIN_PER_HOUR ? `${Math.round(minutes)} min` : `${Math.floor(minutes / MIN_PER_HOUR)} h ${String(Math.round(minutes % MIN_PER_HOUR)).padStart(2, '0')}`);

/** The bar cells for a percent: whole cells only, so a full bar means 100%. */
function barOf(pct, cells, color) {
  const filled = Math.floor((cells * pct) / PERCENT);
  const [on, off] = color ? ['█', '░'] : ['#', '-'];
  return on.repeat(filled) + off.repeat(cells - filled);
}

function barLine(progress, { columns, color }) {
  const cells = columns >= BAR_WIDE_COLUMNS ? WIDE_CELLS : columns >= BAR_NARROW_COLUMNS ? NARROW_CELLS : 0;
  const parts = [
    `${progress.approx ? '~' : ''}${progress.pct}%`,
    `${progress.rowsDone}/${progress.rowsTotal} rows`,
    ...(columns >= BAR_WIDE_COLUMNS && !progress.approx && progress.leftMin > 0 ? [`${leftText(progress.leftMin)} left`] : []),
    ...(progress.tag === null ? [] : [progress.tag]),
  ];
  const text = parts.join(SEPARATOR);
  return paint(fitted(cells > 0 ? `${barOf(progress.pct, cells, color)} ${text}` : text, columns), color, COLOR_OF_TAG[progress.tag] ?? GREEN);
}

function runLine(run, { columns, color }) {
  const phase = run.phase === null ? [] : [`${run.phase}${run.phaseIndex > 0 ? ` (${run.phaseIndex}/${run.phaseTotal ?? '?'})` : ''}`];
  const parts = [`wf ${run.name}${run.row === null ? '' : ` ${run.row}`}`, ...phase, `${run.done}/${run.started} agents`];
  return paint(fitted(parts.join(SEPARATOR), columns), color, DIM);
}

/**
 * @param {{ pct: number, approx: boolean, rowsDone: number, rowsTotal: number, leftMin: number | null, tag: string | null } | null} progress the job's progress, null for none
 * @param {{ name: string, row: string | null, phase: string | null, phaseIndex: number, phaseTotal: number | null, started: number, done: number }[]} runs live runs, newest first
 * @param {{ columns: number, color: boolean }} look the terminal width; color false for plain ASCII
 * @returns {string[]} the lines to print under the status line
 */
export function progressLines(progress, runs, look) {
  return [...(progress ? [barLine(progress, look)] : []), ...runs.slice(0, MAX_RUN_LINES).map((run) => runLine(run, look))];
}
