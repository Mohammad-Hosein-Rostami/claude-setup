// The board of the owner's 2026-11-22 screenshot (spec-tui-3), as agent rows only (the workflow rows are gone): one implementer, three
// read-only reviewers, three lane branches and main, for the row, safety and `/where` tests (statusline-rows, statusline-safety).
// Exports: screenshotBoard(nowMs) -> board; placedWriterBoard(nowMs) -> the same board with writers placed in two lanes;
// viewOf(board, nowMs, env) -> the view statusRows takes; lookFor(env, columns);
// TERM_256, NO_COLOR_ENV (terminal environments); NOW.
// `screenshotBoard` is what the live board shows: the reviewers are read-only agents that no sure fact places in a worktree, so no
// agent row names a lane (repos.mjs placeAgents).
// `placedWriterBoard` is the case with a tie: two implementers are placed in the lane worktrees `remove-modes` and
// `road-gate-landed-row`, so their rows name the branch; `sync-remote-path` is a lane no agent works on.
import { lookOf } from '../home/tools/board/lib/cells.mjs';

export const NOW = Date.UTC(2026, 10, 22, 9, 0);
const MIN_MS = 60_000;
/** The environments of a 256-colour terminal and one with NO_COLOR set (UTF-8 locale in each). */
export const TERM_256 = { TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8', LINES: '36' };
export const NO_COLOR_ENV = { ...TERM_256, NO_COLOR: '1' };

const agent = (fields) => ({
  type: 'implementer', phase: 'Build', row: null, state: 'run', writer: true, pct: 40, conf: 'medium', elapsedMin: 5, leftMin: 10,
  highLeftMin: 25, overMin: 0, usual: [10, 30], tag: null, doing: 'Edit render.mjs', calls: 12, tokens: 40_000, quietMin: 0,
  pendingMin: 0, doneMs: null, repo: 'claude-setup', wt: null, branch: null, unplaced: null, ...fields,
});
const reviewer = (fields) => ({ name: 'reviewer:opus', type: 'reviewer', writer: false, unplaced: 'claude-setup · read-only', ...fields });
const worktree = (name, fields) => ({
  name, path: `/r/wt/${name}`, branch: name, main: false, ahead: 0, behind: 0, changed: 0, op: null, ageMin: 10, agents: [],
  checkedMs: NOW - 2000, upAhead: null, upBehind: null, ...fields,
});

/** @returns {object} the screenshot's board: 4 agents, 3 lane worktrees and main, nothing waiting on the owner */
export function screenshotBoard(nowMs = NOW) {
  return {
    session: 'fixture', at: nowMs, stale: false, asking: null, road: null, trend: null, repos: [],
    git: { branch: 'main', ahead: 44, behind: 0, changed: 0 },
    agents: [
      agent(reviewer({ id: 'a1' })),
      agent(reviewer({ id: 'a2' })),
      agent({ id: 'a3', name: 'implementer:opus', unplaced: 'claude-setup · no edits yet' }),
      agent(reviewer({ id: 'a4' })),
    ],
    repo: {
      name: 'claude-setup', base: 'main', branches: 6, unlanded: 3, tip: 'a'.repeat(40), suite: null,
      landed: { count: 42, lastMs: nowMs - 20 * MIN_MS },
      worktrees: [
        worktree('main', { path: '/r/main', main: true, ageMin: 340, upAhead: 44, upBehind: 0 }),
        worktree('remove-modes', { ahead: 7 }),
        worktree('road-gate-landed-row', { ahead: 8, changed: 2 }),
        worktree('sync-remote-path', { ahead: 1, ageMin: 2 }),
      ],
    },
  };
}

/** @returns {object} the screenshot's board where two implementers are placed in their lane worktrees (a tie) */
export function placedWriterBoard(nowMs = NOW) {
  const board = screenshotBoard(nowMs);
  const placed = (id, lane) => agent({ id, name: 'implementer:opus', wt: lane, branch: lane });
  board.agents = [placed('a1', 'remove-modes'), board.agents[1], board.agents[2], placed('a4', 'road-gate-landed-row')];
  for (const wt of board.repo.worktrees) if (wt.name === 'remove-modes' || wt.name === 'road-gate-landed-row') wt.agents = ['implementer:opus'];
  return board;
}

/** @returns {object} the view render.mjs statusRows takes, for a board at a fixed clock (UTC, no estimate, no limits) */
export function viewOf(board, nowMs = NOW, env = TERM_256) {
  return {
    input: { model: { display_name: 'Opus 5.5' }, effort: { level: 'high' }, context_window: { context_window_size: 400_000, current_usage: { input_tokens: 99_000 } } },
    segment: null, board, asking: null, limitsFile: null, account: 'work', env, nowMs, timeZone: 'UTC',
  };
}

/** @returns {ReturnType<typeof lookOf>} the look of a macOS terminal with this environment, fitted to COLUMNS - 5 */
export const lookFor = (env, columns) => lookOf(env, 'darwin', columns - 5);
