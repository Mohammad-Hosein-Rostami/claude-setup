// The board of the owner's 2026-11-22 screenshot (spec-tui-3): three workflows, three lane branches and main, for the identity
// colour tests (statusline-identity.test.mjs) and the fixture renders of the lane report.
// Exports: screenshotBoard(nowMs) -> board; viewOf(board, nowMs, env) -> the view statusRows takes; lookFor(env, columns);
// TERM_256, TERM_16, NO_COLOR_ENV (terminal environments); NOW.
// Workflow `remove-modes-delta-review` and `road-gate-landed-row` have agents placed in the lane worktree of the same-named branch
// (`remove-modes`, `road-gate-landed-row`); `statusline-identity-colours` has an agent on no sure worktree, so its row names no
// branch; `sync-remote-path` is a lane branch no workflow works on.
import { lookOf } from '../home/tools/board/lib/cells.mjs';

export const NOW = Date.UTC(2026, 10, 22, 9, 0);
const MIN_MS = 60_000;
/** The environments of a 256-colour terminal, a 16-colour one and one with NO_COLOR set (UTF-8 locale in each). */
export const TERM_256 = { TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8', LINES: '36' };
export const TERM_16 = { TERM: 'xterm', LANG: 'en_US.UTF-8', LINES: '36' };
export const NO_COLOR_ENV = { ...TERM_256, NO_COLOR: '1' };

const agent = (fields) => ({
  type: 'implementer', phase: 'Build', row: null, state: 'run', writer: true, pct: 40, conf: 'medium', elapsedMin: 5, leftMin: 10,
  highLeftMin: 25, overMin: 0, usual: [10, 30], tag: null, doing: 'Edit render.mjs', calls: 12, tokens: 40_000, quietMin: 0,
  pendingMin: 0, doneMs: null, repo: 'claude-setup', wt: null, branch: null, unplaced: null, ...fields,
});
const run = (fields) => ({
  state: 'run', quietMin: 0, phaseIndex: 1, phaseTotal: 1, started: 3, done: 1, lanes: {}, purpose: null, agentsTotal: 3,
  agentsDone: 1, leftMin: 12, ...fields,
});
const worktree = (name, fields) => ({
  name, path: `/r/wt/${name}`, branch: name, main: false, ahead: 0, behind: 0, changed: 0, op: null, ageMin: 10, agents: [],
  checkedMs: NOW - 2000, upAhead: null, upBehind: null, ...fields,
});

/** @returns {object} the screenshot's board: 3 workflows, 3 lane worktrees and main, nothing waiting on the owner */
export function screenshotBoard(nowMs = NOW) {
  return {
    session: 'fixture', at: nowMs, stale: false, asking: null, road: null, trend: null, repos: [],
    git: { branch: 'main', ahead: 44, behind: 0, changed: 0 },
    runs: [
      run({ runId: 'wf_remove', name: 'remove-modes-delta-review', phase: 'Delta review', leftMin: 13 }),
      run({ runId: 'wf_status', name: 'statusline-identity-colours', phase: 'Build', started: 1, done: 0, agentsTotal: 1, agentsDone: 0, leftMin: 8 }),
      run({ runId: 'wf_road', name: 'road-gate-landed-row', phase: 'Delta review', leftMin: 7 }),
    ],
    agents: [
      agent({ id: 'a1', name: 'implementer:opus', runId: 'wf_remove', wt: 'remove-modes', branch: 'remove-modes' }),
      agent({ id: 'a2', name: 'reviewer:opus', type: 'reviewer', writer: false, runId: 'wf_remove', unplaced: 'claude-setup · read-only' }),
      agent({ id: 'a3', name: 'implementer:opus', runId: 'wf_status', unplaced: 'claude-setup · no edits yet' }),
      agent({ id: 'a4', name: 'implementer:opus', runId: 'wf_road', wt: 'road-gate-landed-row', branch: 'road-gate-landed-row' }),
    ],
    repo: {
      name: 'claude-setup', base: 'main', branches: 6, unlanded: 3, tip: 'a'.repeat(40), suite: null,
      landed: { count: 42, lastMs: nowMs - 20 * MIN_MS },
      worktrees: [
        worktree('main', { path: '/r/main', main: true, ageMin: 340, upAhead: 44, upBehind: 0 }),
        worktree('remove-modes', { ahead: 7, agents: ['implementer:opus'] }),
        worktree('road-gate-landed-row', { ahead: 8, changed: 2, agents: ['implementer:opus'] }),
        worktree('sync-remote-path', { ahead: 1, ageMin: 2 }),
      ],
    },
  };
}

/** @returns {object} the view render.mjs statusRows takes, for a board at a fixed clock (UTC, no estimate, no limits) */
export function viewOf(board, nowMs = NOW, env = TERM_256) {
  return {
    input: { model: { display_name: 'Opus 5.5' }, effort: { level: 'high' }, context_window: { context_window_size: 400_000, current_usage: { input_tokens: 99_000 } } },
    segment: null, board, asking: null, limitsFile: null, account: 'work', env, nowMs, timeZone: 'UTC', checks: { on: ['test', 'types'], off: ['ui'] },
  };
}

/** @returns {ReturnType<typeof lookOf>} the look of a macOS terminal with this environment, fitted to COLUMNS - 5 */
export const lookFor = (env, columns) => lookOf(env, 'darwin', columns - 5);
