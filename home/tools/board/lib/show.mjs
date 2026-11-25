// The board of a session as plain lines, for a person or a script reading it outside the status line: a head line
// with the board's write time and whether its last refresh kept old data, then one line per agent in the board's order.
// Exports: showLines(board, nowMs) -> string[].
// Invariants: pure (no I/O, now passed in); every name and text from the board goes through cells.mjs cleanText, so no control
// character reaches the terminal; no lane lines (they wait for a work-model change, owner decision).
import { cleanText } from './cells.mjs';

const MS_PER_S = 1_000;
// cleanText reads only `ascii` from a look: these lines keep non-ASCII names as they are and carry no colour
const PLAIN_LOOK = { ascii: false };
const NONE = '-';

// `||`: an empty branch, folder or doing text prints `-` too, so every line keeps its fields.
const clean = (text) => cleanText(text || NONE, PLAIN_LOOK);

/** `running`, `done`, or `quiet N min` (the minutes the refresh counted, agents.mjs quietMin). */
function stateText(agent) {
  if (agent.state === 'run') return 'running';
  if (agent.state === 'quiet') return `quiet ${agent.quietMin} min`;
  return 'done';
}

/** `fresh`, or `stale N s` when the last refresh went over its budget and kept the old data (refresh.mjs `stale.sinceMs`). */
function freshnessText(board, nowMs) {
  if (!board.stale) return 'fresh';
  return `stale ${Math.floor((nowMs - board.stale.sinceMs) / MS_PER_S)} s`;
}

const headLine = (board, nowMs) => `board ${clean(board.session)} at ${new Date(board.at).toISOString()} ${freshnessText(board, nowMs)}`;

const agentLine = (agent) => [
  'agent', clean(agent.id), clean(agent.type), stateText(agent),
  'branch', clean(agent.branch), 'folder', clean(agent.wt), clean(agent.doing),
].join(' ');

/**
 * The board as plain lines: `board <session> at <iso> <fresh|stale N s>`, then per agent, in the board's order,
 * `agent <id> <type> <running|done|quiet N min> branch <branch|-> folder <wt|-> <doing|->`.
 * @param {object} board a board file's content (refresh.mjs readBoard)
 * @param {number} nowMs now (epoch ms), for the age of a stale board
 * @returns {string[]} the head line, then one line per agent (only the head line when there is none)
 */
export const showLines = (board, nowMs) => [headLine(board, nowMs), ...board.agents.map(agentLine)];
