// Packing the board into the rows the terminal has room for (spec-tui "Layout", research-tui 2.3): the row budget from LINES, the
// counts row, and the agent rows folded by urgency when they do not all fit.
// Exports: rowBudget(env) -> number; countsRow(board, asking, ctx, look); shownAgents(board, nowMs); workRows(board, slots, ctx, look).
// Budget: R = clamp(floor(LINES / 3), 3, 12) (24 lines give 8, 36 and more give 12; LINES missing counts as 24).
// Folding, in this order, until the rows fit: (1) the `agents` header and every agent; (2) the header folded (spark strip of the
// agents), the most urgent agents in full under it, the rest on one `+K more` row; (3) one strip row, the most urgent agents, `+K more`.
// Urgency: quiet > over its usual time > writer > reader, then the soonest finish. A finished agent shows for DONE_SHOWN_MS, then only
// the counts row has it. From FULL_COLUMNS two agents share a row.
// Colour of the counts row (spec-tui-2): running work cyan, any quiet agent yellow, waiting on the owner magenta; it leads with a dim
// `Σ` (`=` in ASCII; spec-tui-3 section labels).
// Invariants: pure (no I/O); every row fits look.columns; never more rows than `slots`.
import { DONE_SHOWN_MS, fitParts, STATE } from './cells.mjs';
import { agentRow, countsText, foldRow, plainHeader, sparkText, treeMark, urgencyOf } from './agent-rows.mjs';
import { gitCounts } from './git-rows.mjs';
import { WIDE_COLUMNS } from './work-row.mjs';

const MIN_ROWS = 3;
const MAX_ROWS = 12;
const DEFAULT_LINES = 24;
const LINES_PER_ROW = 3;
const FULL_COLUMNS = 150;
const PAIR_GAP = '  ';
const DONE_COUNTED_MS = 10 * 60_000;
const MS_PER_S = 1000;
const S_PER_MIN = 60;
const ESCAPES = /\u001b\[[0-9;]*m/g;

const wide = (look) => look.columns >= WIDE_COLUMNS;
const widthOf = (text) => [...text.replace(ESCAPES, '')].length;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** @returns {number} the rows the status line may print, from the terminal's height */
export function rowBudget(env) {
  const lines = Number.parseInt(env.LINES ?? '', 10);
  return Math.min(MAX_ROWS, Math.max(MIN_ROWS, Math.floor((lines > 0 ? lines : DEFAULT_LINES) / LINES_PER_ROW)));
}

const byUrgency = (a, b) => urgencyOf(b) - urgencyOf(a) || (a.leftMin ?? Infinity) - (b.leftMin ?? Infinity);

/**
 * @param {object | null} board the session's board
 * @param {number} nowMs now
 * @returns {object[]} the agents the rows draw (running, or finished less than DONE_SHOWN_MS ago), most urgent first
 */
export function shownAgents(board, nowMs) {
  return (Array.isArray(board?.agents) ? board.agents : [])
    .filter((agent) => agent !== null && typeof agent === 'object' && (agent.state !== 'done' || nowMs - agent.doneMs < DONE_SHOWN_MS))
    .sort(byUrgency);
}

/** Agents, what waits on the owner and git, in counts. */
export function countsRow(board, asking, ctx, look) {
  const agents = (Array.isArray(board?.agents) ? board.agents : []).filter((agent) => agent && typeof agent === 'object');
  const count = (state) => agents.filter((agent) => agent.state === state).length;
  const done = agents.filter((agent) => agent.state === 'done' && ctx.nowMs - agent.doneMs < DONE_COUNTED_MS).length;
  const over = agents.filter((agent) => agent.state !== 'done' && agent.overMin > 0).length;
  const live = count('run') + count('quiet');
  const agentText = live + done === 0 ? '0 agents' : `${plural(live, 'agent')} (${count('run')} run${count('quiet') ? `, ${count('quiet')} quiet` : ''}${done ? `, ${done} done${wide(look) ? ' last 10 min' : ''}` : ''})`;
  const label = `${look.ascii ? '=' : 'Σ'} `;
  const parts = [{ text: `${label}${agentText}`, spans: [{ text: label, state: STATE.dim }, { text: agentText, state: count('quiet') > 0 ? STATE.warn : live > 0 ? STATE.run : STATE.ok }] }];
  if (over > 0) parts.push({ text: `${over} over usual`, state: STATE.warn, drop: 1 });
  if (asking && typeof asking === 'object') {
    const leftS = Math.max(0, Math.round(((asking.expiresAt ?? 0) - (asking.marginMs ?? 0) - ctx.nowMs) / MS_PER_S));
    parts.push({ text: `${Number.isInteger(asking.count) && asking.count > 1 ? asking.count : 1} waiting on you ${Math.floor(leftS / S_PER_MIN)}:${String(leftS % S_PER_MIN).padStart(2, '0')}`, state: STATE.wait });
  }
  parts.push({ text: gitCounts(board?.repo ?? null, look), drop: 2, bar: true });
  return fitParts(parts, look);
}

/** One row per agent, or two agents per row from FULL_COLUMNS; each row starts with its tree mark. */
function agentLines(agents, ctx, look) {
  if (look.columns < FULL_COLUMNS || agents.length < 2) {
    return agents.map((agent, index) => agentRow(agent, { ...ctx, prefix: treeMark(index === agents.length - 1, look) }, look));
  }
  const half = { ...look, columns: Math.floor((look.columns - PAIR_GAP.length) / 2) };
  const lines = [];
  for (let index = 0; index < agents.length; index += 2) {
    const last = index + 2 >= agents.length;
    const left = agentRow(agents[index], { ...ctx, prefix: treeMark(last, look) }, half);
    const right = agents[index + 1] ? agentRow(agents[index + 1], { ...ctx, prefix: treeMark(last, look) }, half) : '';
    lines.push(right ? `${left}${' '.repeat(Math.max(0, half.columns - widthOf(left)))}${PAIR_GAP}${right}` : left);
  }
  return lines;
}

const rowsNeeded = (agents, look) => (look.columns >= FULL_COLUMNS ? Math.ceil(agents.length / 2) : agents.length);

/** Form 2: the folded header, the most urgent agents under it, the rest on one row. */
function foldedRows(agents, room, ctx, look) {
  const fits = rowsNeeded(agents, look) <= room;
  const chosen = fits ? agents : agents.slice(0, Math.max(0, room - 1));
  const hidden = agents.slice(chosen.length);
  const rows = [plainHeader(agents, { ...ctx, folded: true }, look), ...agentLines(chosen, ctx, look)];
  return hidden.length > 0 ? [...rows, foldRow(treeMark(true, look), hidden, ctx, look)] : rows;
}

/** Form 3: one strip row, then the most urgent agents, then `+K more`. */
function stripRows(agents, slots, ctx, look) {
  const name = 'agents';
  const rest = ` ${countsText(agents, { ...look, glyph: { ...look.glyph, sep: ' ' } })} ${sparkText(agents, look)}`;
  const strip = fitParts([{ text: `${name}${rest}`, spans: [{ text: name, state: STATE.ok }, { text: rest }] }], look);
  return slots <= 1 ? [strip] : [strip, ...urgentRows(agents, slots - 1, ctx, look)];
}

/** The most urgent agents in `room` rows, without tree marks: one row each, the rest on one `+K more` row. */
function urgentRows(agents, room, ctx, look) {
  const shown = agents.length <= room ? agents : agents.slice(0, room - 1);
  const hidden = agents.slice(shown.length);
  const rows = shown.map((agent) => agentRow(agent, { ...ctx, prefix: ' ' }, look));
  return [...rows, ...(hidden.length > 0 ? [hidden.length === 1 ? agentRow(hidden[0], { ...ctx, prefix: ' ' }, look) : foldRow(' ', hidden, ctx, look)] : [])];
}

/**
 * @param {object | null} board the session's board
 * @param {number} slots the rows the work may take (Infinity for `/where`)
 * @param {{ nowMs: number, timeZone: string, at?: number, repo?: object }} ctx the clock, the board's time and repo
 * @param {ReturnType<import('./cells.mjs').lookOf>} look the terminal
 * @returns {string[]} at most `slots` rows; [] when nothing runs
 */
export function workRows(board, slots, ctx, look) {
  const agents = shownAgents(board, ctx.nowMs);
  if (agents.length === 0 || slots < 1) return [];
  if (1 + rowsNeeded(agents, look) <= slots) return [plainHeader(agents, { ...ctx, folded: false }, look), ...agentLines(agents, ctx, look)];
  if (slots - 1 >= 2) return foldedRows(agents, slots - 1, ctx, look);
  return stripRows(agents, slots, ctx, look).slice(0, slots);
}
