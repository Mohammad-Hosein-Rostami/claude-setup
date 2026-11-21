// The tree `/where` prints (display design 6.3; the progress pane would draw the same, spec-p5 `r9-pane`): all work, the road and
// its steps, the status line's counts, workflow, agent and git rows unclipped (spec-tui: every item, no row budget), what waits on
// the owner, the limits per account and the session's cost figure.
//   ALL  █████░░░░░  36% of work · 3 h 40 left · total by 18:35 · 10/21 rows
//   road r9p3 · step 2/3 users of the cache · 1/2 lanes · step 1 h 10 left · by 16:05     (stat-rows.mjs roadRow)
//    1 done   ██████████  4/4 rows
//    2 now    ███░░░░░░░  3/9 rows · 1 h 10 left · by 16:05 (85%: 16:30)
//    3 next   ░░░░░░░░░░  0/8 rows · 2 h 30
// Exports: whereTree(view, look) -> string[].
// Sources: the estimate cache's shown entry (numbers and progress.road, road-steps.mjs), the board file (with its road, trend,
// suite and landed-today facts), the asking marker, the session's `/check` switch (the checks line, stat-rows.mjs checksRow), the
// newest limits sample per account and the session's last-seen file (`{ costUsd, t }`, written by the status line).
// Invariants: pure (no I/O); every line fits look.columns; every outside text goes through cleanText; the cost is labelled as the
// API-price equivalent since the last /clear, with its age (it is not what the subscription costs).
import { barText, clockOf, cleanText, durationText, fitParts, STATE } from './cells.mjs';
import { STALE_MARGIN_S } from '../../../hooks/lib/asking-marker.mjs';
import { repoRows } from './git-rows.mjs';
import { countsRow, workRows } from './layout.mjs';
import { checksRow, roadRow, trendPart } from './stat-rows.mjs';
import { jobView } from './work-row.mjs';

const CELLS = 10;
const PERCENT = 100;
const MS_PER_S = 1000;
const MS_PER_MIN = 60_000;
const ROAD_NAME = /^[A-Za-z0-9][\w-]{0,39}$/;
const MODEL_LIMITS_NOTE = "model weekly limits: only in Claude Code's own limit message";

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isCount = (value) => Number.isInteger(value) && value >= 0;
const ago = (t, nowMs) => `${Math.max(0, Math.round((nowMs - t) / MS_PER_MIN))} min ago`;

/** The ALL line: the job's percent of work, time left or over, the total clock, the rows. */
function allLine(view, { nowMs, timeZone }, look, trend) {
  if (view === null) return fitParts([{ text: 'ALL  no job linked (status.mjs links the STATUS.md this session edits)' }], look);
  if (view.kind === 'handed-over') return fitParts([{ text: `ALL  idle${look.glyph.sep}last job ${cleanText(view.text, look)}` }], look);
  const over = view.highMs !== null && nowMs > view.highMs ? (nowMs - view.highMs) / MS_PER_MIN : 0;
  const bar = view.pct === null ? barText({ done: view.rowsTotal > 0 ? view.rowsDone / view.rowsTotal : 0 }, CELLS, look) : barText({ done: view.pct / PERCENT }, CELLS, look);
  const parts = [{ text: `ALL  ${bar}  ${view.pct === null ? 'no time' : `${view.pct}% of work`}` }];
  if (over > 0) parts.push({ text: `over by ${durationText(over)}`, state: STATE.block });
  if (view.leftMin !== null) parts.push({ text: `${durationText(view.leftMin)} left` });
  if (view.highMs !== null && over === 0) parts.push({ text: `total by ${clockOf(view.highMs, nowMs, timeZone)}` });
  else if (view.kind !== 'finish' && view.text) parts.push({ text: cleanText(view.text, look) });
  if (trend) parts.push(trend);
  parts.push({ text: `${view.rowsDone}/${view.rowsTotal} rows`, drop: 1 });
  return fitParts(parts, look);
}

const isStepLine = (line) => line !== null && typeof line === 'object' && isCount(line.step) && ['done', 'now', 'next'].includes(line.state)
  && isNumber(line.leftMin) && isCount(line.rowsDone) && isCount(line.rowsTotal);

/** One step line: its state, its rows, and for the current step its clocks. */
function stepLine(line, road, clock, look) {
  const share = line.rowsTotal > 0 ? line.rowsDone / line.rowsTotal : 0;
  const parts = [{ text: `${String(line.step).padStart(2)} ${line.state.padEnd(5)}  ${barText({ done: line.state === 'done' ? 1 : share }, CELLS, look)}  ${line.rowsDone}/${line.rowsTotal} rows` }];
  if (line.state === 'now') {
    parts.push({ text: `${durationText(line.leftMin)} left` });
    if (isNumber(road.clockMs)) parts.push({ text: `by ${clockOf(road.clockMs, clock.nowMs, clock.timeZone)}` });
    if (isNumber(road.p85Ms)) parts.push({ text: `85%: ${clockOf(road.p85Ms, clock.nowMs, clock.timeZone)}`, drop: 1 });
  } else if (line.state === 'next') parts.push({ text: durationText(line.leftMin) });
  return fitParts(parts, look);
}

/** The road head and one line per step, from progress.road; [] without a road. */
function roadLines(view, facts, clock, look) {
  const road = view?.road;
  if (!road) return [];
  const name = typeof road.name === 'string' && ROAD_NAME.test(road.name) ? `road ${road.name}` : 'road';
  const lines = Array.isArray(road.lines) ? road.lines.filter(isStepLine) : [];
  const head = roadRow(road, facts, clock, look) ?? fitParts([{ text: `${name}${look.glyph.sep}step ${road.step} of ${road.steps}` }], look);
  return [head, ...lines.map((line) => stepLine(line, road, clock, look))];
}

/** The status line's counts, work and git rows, unclipped: every workflow, every agent and every worktree. */
function workLines(board, asking, checks, clock, look) {
  const ctx = { ...clock, at: board?.at, repo: board?.repo ?? null, repos: [board?.repo, ...(Array.isArray(board?.repos) ? board.repos : [])].filter(Boolean) };
  const marked = asking && typeof asking === 'object' ? { ...asking, marginMs: STALE_MARGIN_S * MS_PER_S } : null;
  const checksLine = checksRow(checks, board?.repo ?? null, look);
  return [countsRow(board, marked, ctx, look), ...(checksLine === null ? [] : [checksLine]), ...workRows(board, Infinity, ctx, look),
    ...repoRows(board, Infinity, ctx, look)];
}

/** The line of what waits on the owner, quiet runs and git. */
function footLine(board, asking, look) {
  const waiting = asking ? `${asking.kind === 'question' ? `${isCount(asking.count) && asking.count > 1 ? asking.count : 1} question(s)` : 'a permission prompt'}` : 'none';
  const runs = Array.isArray(board?.runs) ? board.runs : [];
  const quiet = runs.filter((run) => run?.state === 'quiet' || run?.state === 'stopped?').length;
  const git = board?.git ? `git ${cleanText(board.git.branch ?? '?', look).slice(0, 32)}, ${isCount(board.git.changed) && board.git.changed > 0 ? `${board.git.changed} changed` : 'clean'}` : 'git ?';
  const stale = isNumber(board?.stale?.sinceMs) ? [{ text: 'board stale', state: STATE.warn }] : [];
  return fitParts([{ text: `waiting on you: ${waiting}`, state: asking ? STATE.block : STATE.ok }, { text: `quiet runs: ${quiet || 'none'}` }, { text: git }, ...stale], look);
}

/** One line per account: what is left of each window, its reset, and the sample's age. */
function limitLines(limits, clock, look) {
  const part = (label, win) => (isNumber(win?.used_percentage)
    ? `${label} ${Math.max(0, Math.floor(PERCENT - win.used_percentage))}% left${isNumber(win.resets_at) ? ` (resets ${clockOf(win.resets_at * MS_PER_S, clock.nowMs, clock.timeZone, true)})` : ''}`
    : `${label} ?`);
  const lines = limits.map(({ account, sample }) => fitParts([{ text: `limits ${cleanText(account, look)}: ${part('5h', sample.five_hour)}` },
    { text: part('7d', sample.seven_day) }, { text: isNumber(sample.t) ? `seen ${ago(sample.t, clock.nowMs)}` : 'age ?', drop: 1 }], look));
  return [...lines, fitParts([{ text: MODEL_LIMITS_NOTE }], look)];
}

/** The cost figure, the only place it is shown (audit case 11), with what it is and how old. */
function costLine(lastSeen, nowMs, look) {
  if (!isNumber(lastSeen?.costUsd)) return fitParts([{ text: 'cost: not seen yet (the status line writes it)' }], look);
  return fitParts([{ text: `cost: $${lastSeen.costUsd.toFixed(2)} API-price equivalent, since the last /clear` },
    { text: isNumber(lastSeen.t) ? `seen ${ago(lastSeen.t, nowMs)}` : 'age ?', drop: 1 }], look);
}

/**
 * @param {{ segment: object | null, board: object | null, asking: object | null, limits: { account: string, sample: object }[],
 *   lastSeen: { costUsd?: number, t?: number } | null, nowMs: number, timeZone: string, checks?: { on: string[], off: string[] } | null }}
 *   view what was read for this session
 * @param {ReturnType<import('./cells.mjs').lookOf>} look the terminal (80 columns for `/where`)
 * @returns {string[]} the tree, one line each, every one within look.columns
 */
export function whereTree({ segment, board, asking, limits, lastSeen, nowMs, timeZone, checks = null }, look) {
  const clock = { nowMs, timeZone };
  const job = jobView(segment);
  return [
    allLine(job, clock, look, trendPart(board?.trend, look)), ...roadLines(job, board?.road ?? null, clock, look),
    ...workLines(board, asking, checks, clock, look), footLine(board, asking, look),
    ...limitLines(Array.isArray(limits) ? limits : [], clock, look), costLine(lastSeen, nowMs, look),
  ];
}
