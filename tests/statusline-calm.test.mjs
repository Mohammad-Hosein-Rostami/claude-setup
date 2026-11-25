// Tests for the status line's rows on busy and idle sessions (spec R18; owner decisions RC14 to RC18 of 2026-11-22): 4 rows when busy
// and 2 when idle, colour by kind, one agents summary row naming the quiet agents, no job, step or estimate rows (plan 2026-11-24);
// and the lane's F questions: F1 NO_COLOR, TERM=dumb, ASCII mode and a Windows console print the same words with no escape code (and
// no byte above 0x7E in ASCII); F2 an old board file still draws every row and never a job row; F3 COLUMNS 40 to 120 and LINES 10
// to 24 keep every row within COLUMNS - 5 and the rows within the budget 2, 4 or 6; and hostile names, a render from files only,
// huge input, a failed draw. Rows come from home/tools/board/lib/render.mjs statusRows (pure).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lookOf } from '../home/tools/board/lib/cells.mjs';
import { sessionRow, statusRows } from '../home/tools/board/lib/render.mjs';

const NOW = Date.UTC(2026, 10, 22, 9, 0);
const MIN_MS = 60_000;
const COLUMNS = [80, 100, 120];
const CUT_MARGIN = 5; // statusline.mjs fits rows to COLUMNS - 5
const ESC = '\u001b';
// reset, bold, dim, the reserved red, yellow and magenta, and the 16-colour kinds: branch green, bar cyan, time blue, session white
const BASIC_SGR = new Set(['0', '1', '2', '31', '33', '35', '32', '36', '34', '37']);
const RESERVED_SGR = new Set(['31', '33', '35']);
const TERM_256 = { TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8', LINES: '36' };
const NO_COLOR_ENV = { ...TERM_256, NO_COLOR: '1' };
const ASCII_ENV = { ...NO_COLOR_ENV, CLAUDE_STATUS_ASCII: '1' };
const WINDOWS_TERMINAL_ENV = { WT_SESSION: '1b2e-0001', LINES: '36' }; // no TERM, no COLORTERM: Windows Terminal sets neither

const plain = (row) => row.replaceAll(/\u001b\[[0-9;]*m/g, '');
const sgrCodes = (rows) => new Set(rows.flatMap((row) => [...row.matchAll(/\u001b\[([0-9;]*)m/g)].map((match) => match[1])));
const lookFor = (env, columns, platform = 'darwin') => lookOf(env, platform, columns - CUT_MARGIN);

const agent = (id, fields = {}) => ({
  id, name: id, type: 'implementer', state: 'run', writer: true, doing: 'Edit render.mjs', calls: 12, tokens: 40_000, quietMin: 0, pendingMin: 0,
  doneMs: null, repo: 'claude-setup', wt: null, branch: null, unplaced: 'claude-setup · no edits yet', ...fields,
});
const worktree = (name, fields = {}) => ({
  name, path: `/r/wt/${name}`, branch: name, main: false, ahead: 1, behind: 0, changed: 0, op: null, ageMin: 10, agents: [],
  checkedMs: NOW - 2000, upAhead: null, upBehind: null, ...fields,
});
const repoOf = (lanes, main = {}) => ({
  name: 'claude-setup', base: 'main', branches: lanes.length + 1, unlanded: lanes.length, tip: 'a'.repeat(40), suite: null,
  landed: { count: 4, lastMs: NOW - 20 * MIN_MS },
  worktrees: [worktree('main', { path: '/r/main', main: true, ahead: 0, ageMin: 30, upAhead: 0, upBehind: 0, ...main }), ...lanes],
});
const boardOf = (fields = {}) => ({ session: 'calm', at: NOW, stale: null, agents: [], repo: repoOf([]), repos: [], git: null, ...fields });

const SESSION_INPUT = {
  model: { display_name: 'Opus 5.5' }, effort: { level: 'high' },
  context_window: { context_window_size: 400_000, current_usage: { input_tokens: 99_000 } },
  rate_limits: { five_hour: { used_percentage: 46, resets_at: (NOW + 160 * MIN_MS) / 1000 }, seven_day: { used_percentage: 31, resets_at: (NOW + 4 * 1440 * MIN_MS) / 1000 } },
};
const viewOf = (env, fields) => ({ input: SESSION_INPUT, board: null, limitsFile: null, account: 'work', env, nowMs: NOW, timeZone: 'UTC', ...fields });

/** Busy: 4 agents running (one quiet) and one just done, 3 lanes. */
function busyView(env) {
  const agents = [
    agent('reviewer', { type: 'reviewer', writer: false, state: 'quiet', quietMin: 6 }), agent('implementer'),
    agent('impl-a', { wt: 'remove-modes', branch: 'remove-modes' }), agent('impl-b', { wt: 'road-gate', branch: 'road-gate' }),
    agent('done-one', { state: 'done', doneMs: NOW - 2 * MIN_MS }),
  ];
  const lanes = [worktree('remove-modes', { ahead: 7 }), worktree('road-gate', { ahead: 8, changed: 2 }), worktree('sync-remote', {})];
  return viewOf(env, { board: boardOf({ agents, repo: repoOf(lanes, { upAhead: 44 }) })});
}

const rowsAt = (view, env, columns, platform) => statusRows(view(env), lookFor(env, columns, platform));

/** Idle: no agent, main only. */
const idleView = (env) => viewOf(env, { board: boardOf() });

test('busy: 4 rows at 80, 100 and 120 columns; idle: 2 rows; every row within COLUMNS - 5', () => {
  for (const columns of COLUMNS) {
    const busy = rowsAt(busyView, TERM_256, columns);
    const idle = rowsAt(idleView, TERM_256, columns);
    assert.deepEqual(busy.map((row) => plain(row).split(' ')[0]), ['agents', 'git', 'lanes', 'session'], busy.map(plain).join('\n'));
    assert.deepEqual(idle.map((row) => plain(row).split(' ')[0]), ['git', 'session']);
    for (const row of [...busy, ...idle]) assert.ok([...plain(row)].length <= columns - CUT_MARGIN, `${columns}: ${plain(row)}`);
  }
});

test('colour by kind (RC14): idle prints no yellow, red or magenta; busy shows the quiet agent in yellow and nothing in magenta', () => {
  for (const columns of COLUMNS) {
    const busy = sgrCodes(rowsAt(busyView, TERM_256, columns));
    assert.ok(busy.has('33'), 'the quiet agent in yellow');
    assert.ok(!busy.has('35'), 'nothing waits on the owner, so no magenta');
    const idle = sgrCodes(rowsAt(idleView, TERM_256, columns));
    assert.deepEqual([...idle].filter((code) => RESERVED_SGR.has(code)), [], `${columns}: idle has nothing to look at`);
    assert.ok(idle.has('38;5;35') && idle.has('38;5;103'), `${columns}: the branch and the session values in their kind colour`);
  }
});

test('F1: NO_COLOR and TERM=dumb print no escape code and every state keeps its word', () => {
  for (const env of [NO_COLOR_ENV, { ...TERM_256, TERM: 'dumb' }]) {
    const rows = COLUMNS.flatMap((columns) => rowsAt(busyView, env, columns));
    assert.ok(rows.every((row) => !row.includes(ESC)), env.TERM);
  }
  const wide = rowsAt(busyView, NO_COLOR_ENV, 120).join('\n');
  for (const word of ['4 running · 1 done', 'reviewer quiet 6 min', 'road-gate']) assert.ok(wide.includes(word), word);
});

test('the agents row names only the quiet agents and carries no estimate, even from a board an older release wrote', () => {
  const view = busyView(NO_COLOR_ENV);
  view.board.agents = view.board.agents.map((entry) => ({ ...entry, pct: 40, leftMin: 10, overMin: entry.id === 'implementer' ? 12 : 0 }));
  for (const columns of COLUMNS) {
    const row = statusRows(view, lookFor(NO_COLOR_ENV, columns)).map(plain).find((text) => text.startsWith('agents'));
    assert.match(row, /^agents +4 running · 1 done · ! reviewer quiet 6 min$/);
    assert.doesNotMatch(row, /over|all done|%/, row);
  }
});

test('F1: hostile agent and branch names (escape codes, bidi marks, 300 characters) are cleaned and the rows stay within COLUMNS - 5', () => {
  const hostile = (word) => `\u001b[31m${word}‮⁦${'x'.repeat(300)}\u0007`;
  const view = (env) => {
    const busy = busyView(env);
    busy.board.agents = busy.board.agents.map((entry) => ({ ...entry, name: hostile(entry.id) }));
    busy.board.repo.worktrees = busy.board.repo.worktrees.map((wt) => ({ ...wt, name: hostile(wt.name), branch: hostile(wt.name), op: wt.main ? hostile('rebase') : null }));
    busy.board.repo.active = [{ name: hostile('main'), current: true, agents: [hostile('agent')], op: hostile('merge'), opStep: hostile('1/2') }];
    busy.board.repos = [{ ...busy.board.repo, name: hostile('repo'), active: [{ name: hostile('other') }] }];
    return busy;
  };
  for (const env of [TERM_256, NO_COLOR_ENV, ASCII_ENV]) {
    for (const columns of COLUMNS) {
      for (const row of rowsAt(view, env, columns)) {
        const shown = row.replaceAll(/\u001b\[[0-9;]*m/g, '');
        assert.doesNotMatch(shown, /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/u, JSON.stringify(shown));
        assert.ok([...shown].length <= columns - CUT_MARGIN, `${columns}: ${shown}`);
        if (env === ASCII_ENV) assert.doesNotMatch(row, /[^ -~]/, row);
      }
    }
  }
});

test('F4: no board, no rate_limits and current_usage null still give 2 rows with `context ?` and `git loading`', () => {
  const view = { input: { model: { display_name: 'Opus 5.5' }, context_window: { current_usage: null } }, board: null, limitsFile: null, account: undefined, env: {}, nowMs: NOW, timeZone: 'UTC' };
  assert.deepEqual(statusRows(view, lookFor(NO_COLOR_ENV, 80)).map(plain), ['git loading', 'session Opus 5.5 · context ? · acct ?']);
});

test('F5: 40 agents and 30 worktrees give one agents row and one lanes row, every quiet agent and lane named or counted', () => {
  const agents = Array.from({ length: 40 }, (_, index) => agent(`agent-${index}`, index % 10 === 0 ? { state: 'quiet', quietMin: 4 } : {}));
  const lanes = Array.from({ length: 30 }, (_, index) => worktree(`lane-${index}`, { changed: index % 2 }));
  const view = viewOf(NO_COLOR_ENV, { board: boardOf({ agents, repo: repoOf(lanes) }) });
  for (const columns of COLUMNS) {
    const shown = statusRows(view, lookFor(NO_COLOR_ENV, columns)).map(plain);
    assert.deepEqual(shown.map((row) => row.split(' ')[0]), ['agents', 'git', 'lanes', 'session'], shown.join('\n'));
    assert.match(shown[0], /^agents +40 running · ! agent-\d+ quiet 4 min/);
    const named = shown[0].match(/quiet 4 min/g)?.length ?? 0;
    const more = Number(/\+(\d+) more/.exec(shown[0])?.[1] ?? 0);
    assert.equal(named + more, 4, `every quiet agent named or counted: ${shown[0]}`);
    const lanesNamed = shown[2].match(/lane-\d+/g)?.length ?? 0;
    assert.equal(lanesNamed + Number(/\+(\d+) more$/.exec(shown[2])?.[1] ?? 0), 30, `every lane named or counted: ${shown[2]}`);
  }
});

test('F1: a Windows console (WT_SESSION, no 256-colour TERM) gets the 16-colour codes only; ASCII mode prints no byte above 0x7E', () => {
  for (const columns of COLUMNS) {
    for (const code of sgrCodes(rowsAt(busyView, WINDOWS_TERMINAL_ENV, columns, 'win32'))) assert.ok(BASIC_SGR.has(code), `SGR ${code}`);
    for (const row of rowsAt(busyView, ASCII_ENV, columns)) assert.doesNotMatch(row, /[^ -~]/, row);
    for (const row of rowsAt(busyView, { LINES: '36' }, columns, 'win32')) assert.doesNotMatch(row, /[^ -~]/, `the old console host: ASCII, no escape code: ${row}`);
  }
});

test('F3: COLUMNS 40 to 120 and LINES 10 to 24 (and none): every row within COLUMNS - 5, never more rows than the budget 2, 4 or 6', () => {
  const expected = { 10: 2, 15: 4, 24: 4, '': 4 }; // the budget is 2, 4 or 6; a busy session has 4 rows
  for (const [lines, rows] of Object.entries(expected)) {
    for (const columns of [40, ...COLUMNS]) {
      const env = { ...TERM_256, LINES: lines };
      const shown = statusRows(busyView(env), lookFor(env, columns));
      assert.equal(shown.length, rows, `LINES ${lines}: ${shown.map(plain).join(' | ')}`);
      for (const row of shown) assert.ok([...plain(row)].length <= columns - CUT_MARGIN, `${columns}: ${plain(row)}`);
      assert.match(plain(shown.at(-1)), /^session /, 'the session row always');
    }
  }
  const short = statusRows(busyView({ ...TERM_256, LINES: '10' }), lookFor(TERM_256, 100)).map((row) => plain(row).split(' ')[0]);
  assert.deepEqual(short, ['git', 'session'], 'kept in order: session, git, agents, lanes');
});

test('F8: the session row draws with no board (statusline.mjs prints it alone when drawing fails)', () => {
  const row = plain(sessionRow(viewOf(NO_COLOR_ENV, { board: null }), lookFor(NO_COLOR_ENV, 100)));
  assert.equal(row, 'session Opus 5.5 high · context 25% · 5h 54% left · 7d 69% left · acct work');
});

test('F2: the row modules read no file, start nothing and keep no clock of their own (a render is drawn from the files statusline.mjs read)', () => {
  for (const name of ['render', 'layout', 'git-rows', 'cells']) {
    const source = readFileSync(fileURLToPath(new URL(`../home/tools/board/lib/${name}.mjs`, import.meta.url)), 'utf8');
    assert.doesNotMatch(source, /from 'node:|Date\.now\(\)/, name);
  }
});

test('F2: an old board file (identity hues, road and trend fields, no active, trust, stash or check) draws every row and no job row', () => {
  const old = busyView(TERM_256);
  old.board = { ...old.board, hues: { 'impl-a': 3 }, identity: { items: [] }, git: { branch: 'main', ahead: 0, behind: 0, changed: 0 },
    road: { name: 'final', step: 2, steps: 4, live: true }, trend: { deltaMin: 70, atMs: NOW } };
  old.board.repo = { ...old.board.repo, check: { verdict: 'block', failed: ['tests'] } };
  const rows = statusRows(old, lookFor(TERM_256, 120)).map(plain);
  assert.deepEqual(rows.map((row) => row.split(' ')[0]), ['agents', 'git', 'lanes', 'session'], rows.join('\n'));
  assert.ok(rows.every((row) => row.trim() !== '' && !/error|check|job|step/.test(row)), rows.join('\n'));
});
