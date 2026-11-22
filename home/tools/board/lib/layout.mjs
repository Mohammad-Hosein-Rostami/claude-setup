// Packing the board into the rows the terminal has room for (spec-tui "Layout", research-tui 2.3): the row budget from LINES, the
// counts row, and the work rows (workflow headers and agent rows) folded by urgency when they do not all fit. In the status line a
// workflow is one row (name, what it is for, its bar of agents done of all, phase, running count, spark of its agents, remaining,
// finish) and its agents are not listed under it (owner, 2026-11-22: "work flow agents progress bars should be inside itself");
// `/where` (ctx.runAgents) lists them. Agents outside a workflow keep their own rows.
// Exports: rowBudget(env) -> number; countsRow(board, asking, ctx, look); workGroups(board, nowMs); workRows(board, slots, ctx, look).
// Budget: R = clamp(floor(LINES / 3), 3, 12) (24 lines give 8, 36 and more give 12; LINES missing counts as 24).
// Folding, in this order, until the rows fit: (1) every header and every listed agent; (2) each workflow folded into its header
// (spark strip of its agents), the most urgent listed agents in full under their header, the rest on one `+K more` row; (2b) in the
// status line, each workflow's row, then the most urgent agents outside workflows without their header, `+K more`; (3) one strip
// row with every group, the most urgent listed agents, `+K more`. Urgency: quiet > over its usual time > writer > reader, then the soonest finish. A
// finished agent shows for DONE_SHOWN_MS, then only the counts row has it. From FULL_COLUMNS two agents share a row.
// Colour of the counts row (spec-tui-2): running work cyan, any quiet agent yellow, waiting on the owner magenta; it leads with a dim
// `Σ` (`=` in ASCII; spec-tui-3 section labels). The strip row's group names lead with their marker and are in their identity hue (identity.mjs).
// Invariants: pure (no I/O); every row fits look.columns; never more rows than `slots`.
import { cleanText, cutWords, DONE_SHOWN_MS, fitParts, hueState, STATE } from './cells.mjs';
import { hueOf, itemKey, markerOf } from './identity.mjs';
import { agentRow, countsText, foldRow, plainHeader, runHeader, sparkText, treeMark, urgencyOf } from './agent-rows.mjs';
import { gitCounts } from './git-rows.mjs';
import { WIDE_COLUMNS } from './work-row.mjs';

const MIN_ROWS = 3;
const MAX_ROWS = 12;
const DEFAULT_LINES = 24;
const LINES_PER_ROW = 3;
const FULL_COLUMNS = 150;
const PAIR_GAP = '  ';
const STRIP_NAME_CHARS = 12; // a workflow's name on the strip row, cut at a word or `-` with the cut mark
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
 * @returns {{ run: object | null, agents: object[] }[]} the live workflow runs with their agents, then the plain agents (run null)
 */
export function workGroups(board, nowMs) {
  const agents = (Array.isArray(board?.agents) ? board.agents : []).filter((agent) => agent !== null && typeof agent === 'object'
    && (agent.state !== 'done' || nowMs - agent.doneMs < DONE_SHOWN_MS));
  const runs = (Array.isArray(board?.runs) ? board.runs : []).filter((run) => run !== null && typeof run === 'object'
    && (run.state !== 'stopped?' || agents.some((agent) => agent.runId === run.runId)));
  const groups = runs.map((run) => ({ run, agents: agents.filter((agent) => agent.runId === run.runId).sort(byUrgency) }));
  const plain = agents.filter((agent) => !runs.some((run) => run.runId === agent.runId)).sort(byUrgency);
  return plain.length > 0 ? [...groups, { run: null, agents: plain }] : groups;
}

/** Workflows, agents, what waits on the owner and git, in counts. */
export function countsRow(board, asking, ctx, look) {
  const runs = (Array.isArray(board?.runs) ? board.runs : []).filter((run) => run && typeof run === 'object');
  const agents = (Array.isArray(board?.agents) ? board.agents : []).filter((agent) => agent && typeof agent === 'object');
  const paused = runs.filter((run) => run.state !== 'run').length;
  const count = (state) => agents.filter((agent) => agent.state === state).length;
  const done = agents.filter((agent) => agent.state === 'done' && ctx.nowMs - agent.doneMs < DONE_COUNTED_MS).length;
  const over = agents.filter((agent) => agent.state !== 'done' && agent.overMin > 0).length;
  const runText = runs.length === 0 ? 'no workflows' : wide(look) ? `${plural(runs.length, 'workflow')} (${runs.length - paused} run, ${paused} paused)` : `${runs.length} wf`;
  const live = count('run') + count('quiet');
  const agentText = live + done === 0 ? 'no agents' : `${plural(live, 'agent')} (${count('run')} run${count('quiet') ? `, ${count('quiet')} quiet` : ''}${done ? `, ${done} done${wide(look) ? ' last 10 min' : ''}` : ''})`;
  const label = `${look.ascii ? '=' : 'Σ'} `;
  const runState = runs.length > paused ? STATE.run : STATE.ok;
  const parts = [{ text: `${label}${runText}`, spans: [{ text: label, state: STATE.dim }, { text: runText, state: runState }] }, { text: agentText, state: count('quiet') > 0 ? STATE.warn : live > 0 ? STATE.run : STATE.ok }];
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
/** The agents shown under a group's header: none for a workflow in the status line (its header carries them), all in `/where`. */
const listed = (group) => (group.inHeader ? [] : group.agents);
const headerOf = (group, ctx, look, folded) => (group.run === null ? plainHeader(group.agents, { ...ctx, folded }, look)
  : runHeader(group.run, group.agents, { ...ctx, folded: folded || group.inHeader }, look));

/** Form 2: folded headers, the chosen agents under them, the rest on one row. */
function foldedRows(groups, room, ctx, look) {
  const all = groups.flatMap(listed).sort(byUrgency);
  const fits = rowsNeeded(all, look) <= room;
  const chosen = new Set(fits ? all : all.slice(0, Math.max(0, room - 1)));
  const rows = groups.flatMap((group) => [headerOf(group, ctx, look, true), ...agentLines(listed(group).filter((agent) => chosen.has(agent)), ctx, look)]);
  const hidden = all.filter((agent) => !chosen.has(agent));
  return hidden.length > 0 ? [...rows, foldRow(treeMark(true, look), hidden, ctx, look)] : rows;
}

/** Form 3: one strip row with every group, then the most urgent agents, then `+K more`. */
function stripRows(groups, slots, ctx, look) {
  const strip = fitParts(groups.map((group, index) => {
    const run = group.run;
    const hueIndex = run === null ? null : hueOf(ctx.identity, itemKey(ctx.identity, run));
    const name = run === null ? 'agents' : `${markerOf(hueIndex, look)} ${cutWords(cleanText(run.name ?? '?', look), STRIP_NAME_CHARS, look)}`;
    const phase = run && Number.isInteger(run.phaseIndex) ? ` ${run.phaseIndex}/${run.phaseTotal ?? '?'}` : '';
    const rest = `${phase} ${countsText(group.agents, { ...look, glyph: { ...look.glyph, sep: ' ' } })} ${sparkText(group.agents, look)}`;
    const hue = run === null ? STATE.ok : hueState(hueIndex);
    return { text: `${name}${rest}`, spans: [{ text: name, state: hue }, { text: rest }], drop: index };
  }), look);
  return slots <= 1 ? [strip] : [strip, ...urgentRows(groups.flatMap(listed).sort(byUrgency), slots - 1, ctx, look)];
}

/** The most urgent agents in `room` rows, without tree marks: one row each, the rest on one `+K more` row. */
function urgentRows(agents, room, ctx, look) {
  const shown = agents.length <= room ? agents : agents.slice(0, room - 1);
  const hidden = agents.slice(shown.length);
  const rows = shown.map((agent) => agentRow(agent, { ...ctx, prefix: ' ' }, look));
  return [...rows, ...(hidden.length > 0 ? [hidden.length === 1 ? agentRow(hidden[0], { ...ctx, prefix: ' ' }, look) : foldRow(' ', hidden, ctx, look)] : [])];
}

/** Form 2b (status line): each workflow's one row (it never lists its agents there), then the agents outside workflows. */
function runFirstRows(groups, slots, ctx, look) {
  const runs = groups.filter((group) => group.inHeader);
  const plain = groups.filter((group) => group.run === null).flatMap((group) => group.agents);
  return [...runs.map((group) => headerOf(group, ctx, look, true)), ...urgentRows(plain, slots - runs.length, ctx, look)];
}

/**
 * @param {object | null} board the session's board
 * @param {number} slots the rows the work may take (Infinity for `/where`)
 * @param {{ nowMs: number, timeZone: string, at?: number, repo?: object, runAgents?: boolean }} ctx the clock, the board's time
 *   and repo; runAgents lists each workflow's agents under its header (`/where`), else the header alone stands for them
 * @param {ReturnType<import('./cells.mjs').lookOf>} look the terminal
 * @returns {string[]} at most `slots` rows; [] when nothing runs
 */
export function workRows(board, slots, ctx, look) {
  const groups = workGroups(board, ctx.nowMs).map((group) => ({ ...group, inHeader: group.run !== null && ctx.runAgents !== true }));
  if (groups.length === 0 || slots < 1) return [];
  const full = groups.reduce((sum, group) => sum + 1 + rowsNeeded(listed(group), look), 0);
  if (full <= slots) return groups.flatMap((group) => [headerOf(group, ctx, look, false), ...agentLines(listed(group), ctx, look)]);
  const room = slots - groups.length;
  if (room >= 2) return foldedRows(groups, room, ctx, look);
  const runCount = groups.filter((group) => group.inHeader).length;
  if (runCount > 0 && runCount === groups.filter((group) => group.run !== null).length && slots > runCount) return runFirstRows(groups, slots, ctx, look);
  return stripRows(groups, slots, ctx, look).slice(0, slots);
}

