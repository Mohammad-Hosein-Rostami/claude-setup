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

// The states of the approved mockups (final-round/statusline/mockups.html, owner decision RC18): each one's inputs and the exact
// text the mockup shows per width. The mockup's three copies of `one job running` differ in how many more active branches there
// are (none at 100 columns, 1 more at 80, 2 more at 120), so each width gets its own count (`activeMore`); everything else is one
// input per state. Clocks are UTC on 2026-11-22.
const at = (hour, minute) => Date.UTC(2026, 10, 22, hour, minute);
const SEVEN_DAY_RESET = at(9, 0) + 4 * 1440 * MIN_MS;
export const MOCKUP_HOME = '/Users/owner';
const CHECK_OK = { verdict: 'ok', atMs: at(18, 0), failed: [] };

/** The status input: Opus 5.5 high, the context share, the 5 h window's use and reset, 7 d 47 % left, in `folder`. */
const inputOf = ({ context, fiveUsed, fiveResetMs, folder = '/Users/owner/Desktop/claude-setup' }) => ({
  model: { display_name: 'Opus 5.5' }, effort: { level: 'high' }, workspace: { current_dir: folder },
  context_window: { context_window_size: 200_000, current_usage: { input_tokens: context * 2000 } },
  rate_limits: { five_hour: { used_percentage: fiveUsed, resets_at: fiveResetMs / 1000 }, seven_day: { used_percentage: 53, resets_at: SEVEN_DAY_RESET / 1000 } },
});
/** Two samples of one 5 h window whose rising use runs out at `emptyMs` (render.mjs paceOf), the newest one taken now. */
function paceFile(nowMs, emptyMs, used, resetMs) {
  const msPerPercent = Math.ceil((emptyMs - nowMs) / (100 - used));
  const sample = (t, pct) => ({ t, five_hour: { used_percentage: pct, resets_at: resetMs / 1000 }, seven_day: { used_percentage: 53, resets_at: SEVEN_DAY_RESET / 1000 } });
  return { account: 'mine', samples: [sample(nowMs - msPerPercent, used - 1), sample(nowMs, used)] };
}
/** The calm session of most mockups: context 29 %, 5 h 90 % left and running out at 22:32 before its 23:30 reset. */
const calmSession = (nowMs, folder) => ({ input: inputOf({ context: 29, fiveUsed: 10, fiveResetMs: at(23, 30), folder }), limitsFile: paceFile(nowMs, at(22, 32), 10, at(23, 30)) });
/** The busy session: context 41 %, 5 h 38 % left (yellow) and its reset at 22:10, no pace. */
const busySession = () => ({ input: inputOf({ context: 41, fiveUsed: 62, fiveResetMs: at(22, 10) }), limitsFile: null });

/** An active branch of git-state.mjs (`repo.active`), clean and level unless the fields say otherwise. */
const branch = (name, fields = {}) => ({ name, current: false, upstream: null, upAhead: null, upBehind: null, ahead: 0, behind: 0, ageMin: 30,
  worktree: name, agents: [], staged: 0, changed: 0, untracked: 0, conflicts: 0, op: null, opStep: null, ...fields });
const mainBranch = (fields) => branch('main', { current: true, upstream: 'origin/main', upAhead: 0, upBehind: 0, ageMin: 8, ...fields });
/** A repository of the R18 board (git-state.mjs repo plus name and check, repos.mjs). */
const repoOf = (name, active, fields = {}) => ({
  name, base: 'main', branches: active.length, unlanded: 0, trust: 'full', stash: 0, check: null, active, activeMore: 0,
  worktrees: [worktree(active.find((entry) => entry.current)?.name ?? active[0]?.name ?? 'main', { path: `/r/${name}`, main: true })],
  ...fields,
});
const LANE_GIT = branch('r18-git', { ahead: 2, changed: 3, agents: ['implementer'] });
const LANE_EST = branch('r18-est', { ahead: 4 });
const LANE_LINE = branch('r18-line', { ahead: 1, changed: 2, agents: ['implementer'] });
const ROAD_FACTS = { name: 'r18', step: 2, steps: 4, title: 'git rows', lanesDone: 1, lanesTotal: 3, goal: 'status line', live: true };
const runningAgent = (id, fields = {}) => agent({ id, name: id, leftMin: 10, ...fields });

/** The estimate cache entry of a job: rows done of all, the work left, the committed finish, how late, the road step, open rows. */
function segmentOf({ rowsDone, rowsTotal, leftMin, finishMs, p85Ms = null, lateMin = null, lateCause = null, road = null, rows = [] }) {
  const numbers = { finishMs, p85Ms, leftMin, workedMin: 120, rowsDone, rowsTotal, firstBudgetMin: null, lateMin, lateCause, rows };
  return { kind: 'finish', text: null, highMs: finishMs, numbers, progress: { pct: 50, approx: false, rowsDone, rowsTotal, leftMin, tag: null, road } };
}
const roadStep = (nowMs) => ({ name: 'r18', step: 2, steps: 4, rowsDone: 1, rowsTotal: 3, leftMin: 40, clockMs: nowMs + 40 * MIN_MS, p85Ms: nowMs + 60 * MIN_MS });
const boardOf = (nowMs, fields) => ({ session: 'mockup', at: nowMs, stale: null, refreshStartedAt: nowMs, asking: null, agents: [], repo: null, repos: [], git: null, road: null, trend: null, ...fields });

/** `one job running` (and `question waiting`): a live road, 3 agents running and 1 done, main with lanes. */
function roadJob(nowMs, activeMore) {
  const agents = [runningAgent('impl-a'), runningAgent('impl-b'), runningAgent('impl-c'), runningAgent('scout', { state: 'done', doneMs: nowMs - 2 * MIN_MS })];
  const main = mainBranch({ upAhead: 2, staged: 1, changed: 3, untracked: 1 });
  return {
    segment: segmentOf({ rowsDone: 6, rowsTotal: 10, leftMin: 130, finishMs: at(21, 40), road: roadStep(nowMs) }),
    board: boardOf(nowMs, { agents, road: ROAD_FACTS, repo: repoOf('claude-setup', [main, LANE_GIT, LANE_EST, LANE_LINE], { stash: 1, check: CHECK_OK, activeMore }) }),
  };
}

/** Each mockup state: its inputs (the statusRows view) and the mockup's rows per width, plain text. */
export function mockupStates() {
  const states = [];
  const add = (name, nowMs, view, expected, env = {}) => states.push({ name, nowMs, env, expected, view: { segment: null, asking: null, account: 'mine', nowMs, timeZone: 'UTC', ...view } });
  const session = { calm: 'session Opus 5.5 high · context 29% · 5h 90% left, empty ~22:32 · 7d 47% left · acct mine',
    busy: 'session Opus 5.5 high · context 41% · 5h 38% left, resets 22:10 · 7d 47% left · acct mine' };

  let now = at(19, 15);
  add('idle-in-repo', now, { ...calmSession(now), board: boardOf(now, { repo: repoOf('claude-setup', [mainBranch()], { stash: 1, check: CHECK_OK }) }) },
    { 100: ['git     claude-setup  main  ✓ clean · stash 1 · last commit 8 min ago · check ok', session.calm] });
  add('idle-lanes', now, { ...calmSession(now), board: boardOf(now, { repo: repoOf('claude-setup', [mainBranch({ upAhead: 1, staged: 1, changed: 3, untracked: 1 }), LANE_EST, branch('r17-col', { behind: 5 })], { stash: 1, check: CHECK_OK }) }) },
    { 100: ['git     claude-setup  main  ↑1 to push · 1 staged · 3 changed · 1 new · stash 1 · check ok', 'lanes   r18-est ↑4 ready to land · r17-col ↓5 needs rebase', session.calm] });
  const running = { 100: [
    'job     ████░░░░ 6/10 rows done · 2 h 10 work left · done by 21:40',
    'now     step 2 of 4 git rows · ██░░░░ 1/3 lanes landed · 40 min work left · step done by 19:55',
    'agents  3 running · 1 done',
    'git     claude-setup  main  ↑2 to push · 1 staged · 3 changed · 1 new · stash 1 · check ok',
    'lanes   r18-git ↑2 ~3 implementer · r18-est ↑4 ready to land · r18-line ↑1 ~2 implementer', session.busy] };
  add('job-running', now, { ...busySession(), ...roadJob(now, 0) }, running);
  add('job-running-light', now, { ...busySession(), ...roadJob(now, 0) }, running, { CLAUDE_STATUS_THEME: 'light' });
  add('job-running-narrow', now, { ...busySession(), ...roadJob(now, 1) }, { 80: [
    'job ███░░░ 6/10 rows done · 2 h 10 left · done by 21:40',
    'now step 2/4 git rows · █░░ 1/3 lanes · 40 min left · step by 19:55',
    'agents 3 running · 1 done',
    'git main  ↑2 · +1 ~3 ?1 · stash 1 · last commit 8 min ago · check ok',
    'lanes r18-git ↑2 ~3 implementer · r18-est ↑4 ready to land · +2 more',
    'session Opus 5.5 high · context 41% · 5h 38% left, resets 22:10 · acct mine'] });
  add('job-running-wide', now, { ...busySession(), ...roadJob(now, 2) }, { 120: [
    'job     █████████░░░░░░░  6 of 10 rows done · about 2 h 10 of work left · done by 21:40',
    'now     step 2 of 4 git rows · ██░░░░ 1 of 3 lanes landed · about 40 min of work left · step done by 19:55',
    'agents  3 running · 1 done',
    'git     claude-setup  main  ↑2 to push · 1 staged · 3 changed · 1 new · stash 1 · last commit 8 min ago · check ok',
    'lanes   r18-git ↑2 ~3 implementer · r18-est ↑4 ready to land · r18-line ↑1 ~2 implementer · +2 more', session.busy] });
  add('question', now, { ...calmSession(now), ...roadJob(now, 0), asking: { kind: 'question', count: 1, expiresAt: now + 160_000 } }, { 100: [
    '? ANSWER NEEDED · 1 question · recommended answer taken in 1:40', ...running[100].slice(0, 4), session.calm] });

  now = at(19, 40);
  const lateRows = [{ id: 'R18.git', expectMin: 40, leftMin: 15, startedMs: now - 65 * MIN_MS }, { id: 'R18.spec', expectMin: 30, leftMin: 10, startedMs: now - 20 * MIN_MS }, { id: 'R18.docs', expectMin: 20, leftMin: 20, startedMs: null }];
  const lateView = () => ({
    ...calmSession(now),
    segment: segmentOf({ rowsDone: 7, rowsTotal: 10, leftMin: 90, finishMs: at(21, 40), p85Ms: now + 130 * MIN_MS, lateMin: 25, lateCause: { cause: 'rows-added', ids: ['a', 'b', 'c'], count: 3 }, rows: lateRows }),
    board: boardOf(now, {
      agents: [runningAgent('reviewer', { state: 'quiet', quietMin: 6 }), ...['a', 'b', 'c', 'd'].map((id) => runningAgent(`impl-${id}`))],
      repo: repoOf('claude-setup', [mainBranch({ upAhead: 2, upBehind: 1, staged: 1, changed: 3, untracked: 1 }), LANE_GIT, branch('r18-spec', { ahead: 1, agents: ['reviewer'] })], { stash: 1, check: CHECK_OK }),
    }),
  });
  const late = { 100: [
    'job     █████░░░ 7/10 rows done · 1 h 30 work left · done by 21:40, 25 min late: 3 rows added',
    'now     2 rows running · 25 min work left · by 20:05 · R18.git 25 min over usual',
    'agents  5 running · ! reviewer quiet 6 min',
    'git     claude-setup  main  ↑2 to push · ↓1 to pull · 1 staged · 3 changed · 1 new · stash 1',
    'lanes   r18-git ↑2 ~3 implementer · r18-spec ↑1 reviewer', session.calm] };
  add('job-late', now, lateView(), late);
  add('job-late-light', now, lateView(), late, { CLAUDE_STATUS_THEME: 'light' });

  now = at(19, 50);
  add('past-p85', now, {
    ...calmSession(now),
    segment: segmentOf({ rowsDone: 8, rowsTotal: 10, leftMin: 50, finishMs: at(20, 40), p85Ms: now + 80 * MIN_MS, lateMin: 70, lateCause: { cause: 'slow-row', ids: ['R18.git'], count: 1 },
      rows: [{ id: 'R18.git', expectMin: 45, leftMin: 50, startedMs: now - 110 * MIN_MS }, { id: 'R18.docs', expectMin: 20, leftMin: 20, startedMs: null }] }),
    board: boardOf(now, { repo: repoOf('claude-setup', [mainBranch({ upAhead: 2, staged: 1, changed: 3, untracked: 1 })], { check: { verdict: 'block', atMs: at(19, 30), failed: ['tests'] } }) }),
  }, { 100: [
    'job     ██████░░ 8/10 rows done · 50 min work left · done by 20:40, 1 h 10 late: R18.git slow',
    'now     1 row running: R18.git · 50 min work left · by 20:40 · R18.git 1 h 05 over usual',
    'git     claude-setup  main  ↑2 to push · 1 staged · 3 changed · 1 new · check failed: tests', session.calm] });

  now = at(19, 15);
  const ice = repoOf('demo-web-ui', [branch('feat/auth-i18n', { upstream: 'origin/feat/auth-i18n', upAhead: 1, upBehind: 2, op: 'rebase', opStep: '3/7', staged: null, changed: null, untracked: null, conflicts: null })], { trust: 'refs' });
  add('several-repos', now, {
    ...calmSession(now),
    segment: segmentOf({ rowsDone: 3, rowsTotal: 8, leftMin: 200, finishMs: at(23, 10), road: roadStep(now) }),
    board: boardOf(now, {
      agents: ['a', 'b', 'c', 'd'].map((id) => runningAgent(`impl-${id}`)), road: ROAD_FACTS, repos: [ice],
      repo: repoOf('claude-setup', [mainBranch({ upAhead: 3, changed: 2 }), branch('r18-git', { ahead: 2, changed: 1, agents: ['implementer'] }), LANE_EST]),
    }),
  }, { 100: [
    'job     ███░░░░░ 3/8 rows done · 3 h 20 work left · done by 23:10',
    'now     step 2 of 4 git rows · ██░░░░ 1/3 lanes landed · 40 min work left · step done by 19:55',
    'agents  4 running',
    'git     claude-setup  main  ↑3 to push · 2 changed │ r18-git ↑2 ~1 · r18-est ↑4 ready',
    'git     demo-web-ui  feat/auth-i18n  ↑1 to push · ↓2 to pull · rebase 3/7 · changes ?', session.calm] });
  add('outside-repo', now, {
    ...calmSession(now, MOCKUP_HOME),
    segment: segmentOf({ rowsDone: 9, rowsTotal: 10, leftMin: 10, finishMs: at(19, 50), rows: [{ id: 'R18.land', expectMin: 20, leftMin: 10, startedMs: now - 10 * MIN_MS }] }),
    board: boardOf(now, {
      agents: ['a', 'b', 'c', 'd', 'e'].map((id) => runningAgent(`impl-${id}`)),
      repo: repoOf('claude-setup', [branch('main', { upstream: 'origin/main', upAhead: 1, upBehind: 0, untracked: null }), LANE_GIT, LANE_EST]),
    }),
  }, { 100: [
    'job     ███████░ 9/10 rows done · 10 min work left · done by 19:50',
    'agents  5 running',
    'git     claude-setup  main  ↑1 to push │ r18-git ↑2 ~3 · r18-est ↑4 ready to land', session.calm] });
  add('no-repo', now, { ...calmSession(now, MOCKUP_HOME), board: boardOf(now, {}) },
    { 100: ['git     no repository used in this session yet (~ is not one)', session.calm] });
  return states;
}
