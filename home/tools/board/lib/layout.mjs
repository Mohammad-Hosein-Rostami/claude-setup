// The status line's row budget from LINES and its one agents summary row (owner decision RC8).
// Exports: rowBudget(env) -> 2 | 4 | 6; agentsSummaryRow(board, ctx, look) -> string | null.
// Budget (spec R18, owner decision RC17): 6 rows from FULL_LINES lines, 4 from SHORT_LINES, else 2 (LINES missing counts as 24).
// Agents summary: `agents  5 running · 1 done · ! reviewer quiet 6 min · implementer quiet 4 min`: running = run + quiet, done =
// finished in the last 10 min; only the quiet agents are named (longest quiet first), in yellow with their word; as many names as
// fit, then `+K more`. No progress or finish estimate (plan 2026-11-24: estimates removed).
// Invariants: pure (no I/O); every row fits look.columns.
import { cleanText, cutWords, durationText, fitParts, labelled, STATE } from './cells.mjs';

const FULL_ROWS = 6;
const MID_ROWS = 4;
const SHORT_ROWS = 2;
/** From these terminal heights the status line may print 6 or 4 rows (spec R18 budget); below SHORT_LINES only 2. */
const FULL_LINES = 20;
const SHORT_LINES = 12;
const DEFAULT_LINES = 24;
const AGENT_NAME_CHARS = 24;
const DONE_COUNTED_MS = 10 * 60_000;
const ESCAPES = /\u001b\[[0-9;]*m/g;

const widthOf = (text) => [...text.replace(ESCAPES, '')].length;

/** @returns {2 | 4 | 6} the rows the status line may print, from the terminal's height: 6 from FULL_LINES, 4 from SHORT_LINES, else 2 */
export function rowBudget(env) {
  const parsed = Number.parseInt(env.LINES ?? '', 10);
  const lines = parsed > 0 ? parsed : DEFAULT_LINES;
  return lines >= FULL_LINES ? FULL_ROWS : lines >= SHORT_LINES ? MID_ROWS : SHORT_ROWS;
}

const agentsOf = (board) => (Array.isArray(board?.agents) ? board.agents : []).filter((agent) => agent !== null && typeof agent === 'object');
const doneLately = (agents, nowMs) => agents.filter((agent) => agent.state === 'done' && nowMs - agent.doneMs < DONE_COUNTED_MS).length;
const joinedWidth = (texts, look) => texts.reduce((sum, text, index) => sum + widthOf(text) + (index === 0 ? 0 : widthOf(look.glyph.sep)), 0);

/** The words of a quiet agent: `reviewer quiet 6 min`. */
function quietText(agent, look) {
  const name = cutWords(cleanText(agent.name ?? agent.type ?? '?', look), AGENT_NAME_CHARS, look);
  return `${name} quiet ${durationText(agent.quietMin ?? 0)}`;
}

/**
 * The status line's one agents row (RC8): counts and the quiet agents by name.
 * @param {object | null} board the session's board
 * @param {{ nowMs: number }} ctx now
 * @param {ReturnType<import('./cells.mjs').lookOf>} look the terminal
 * @returns {string | null} the row; null when no agent runs
 */
export function agentsSummaryRow(board, ctx, look) {
  const agents = agentsOf(board);
  const running = agents.filter((agent) => agent.state === 'run' || agent.state === 'quiet');
  if (running.length === 0) return null;
  const done = doneLately(agents, ctx.nowMs);
  const counts = done > 0 ? `${running.length} running${look.glyph.sep}${done} done` : `${running.length} running`;
  const head = labelled('agents', { text: counts }, look);
  const quiet = running.filter((agent) => agent.state === 'quiet')
    .sort((a, b) => (b.quietMin ?? 0) - (a.quietMin ?? 0))
    .map((agent, index) => `${index === 0 ? '! ' : ''}${quietText(agent, look)}`);
  // As many names as fit beside the counts, the rest as `+K more`, so the row never cuts a name.
  let named = quiet.length;
  const restText = (n) => (n === 0 ? `! ${quiet.length} quiet` : `+${quiet.length - n} more`);
  const withMore = (n) => [head.text, ...quiet.slice(0, n), ...(n < quiet.length ? [restText(n)] : [])];
  while (named > 0 && joinedWidth(withMore(named), look) > look.columns) named -= 1;
  const quietParts = withMore(named).slice(1).map((text) => ({ text, state: STATE.warn }));
  return fitParts([head, ...quietParts], look);
}
