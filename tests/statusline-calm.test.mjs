// Tests for the calm status line (terminal-ui design A; owner decisions RC5, RC6 and RC8 of 2026-11-22): 2 rows when calm and at
// most 4 when busy, colour only for a state, the bar and time left from live work only, one agents summary row, no stale road; and
// the lane's F questions (hostile names, a render from files only, old board files, empty and huge input, Windows Terminal and
// ASCII, a stale road, a failed draw). Rows come from home/tools/board/lib/render.mjs statusRows (pure), `/where` from tree.mjs
// whereTree, and the road's `live` from job-facts.mjs run in a child with a temp HOME.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lookOf } from '../home/tools/board/lib/cells.mjs';
import { sessionRow, statusRows } from '../home/tools/board/lib/render.mjs';
import { whereTree } from '../home/tools/board/lib/tree.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const NOW = Date.UTC(2026, 10, 22, 9, 0);
const MIN_MS = 60_000;
const COLUMNS = [80, 100, 120];
const CUT_MARGIN = 5; // statusline.mjs fits rows to COLUMNS - 5
const ESC = '\u001b';
const ALLOWED_SGR = new Set(['0', '1', '2', '31', '33', '35', '36']); // reset, bold, dim, red, yellow, magenta, cyan
const TERM_256 = { TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8', LINES: '36' };
const NO_COLOR_ENV = { ...TERM_256, NO_COLOR: '1' };
const ASCII_ENV = { ...NO_COLOR_ENV, CLAUDE_STATUS_ASCII: '1' };
const WINDOWS_TERMINAL_ENV = { WT_SESSION: '1b2e-0001', LINES: '36' }; // no TERM, no COLORTERM: Windows Terminal sets neither
const JOB_FACTS = pathToFileURL(fileURLToPath(new URL('../home/tools/board/lib/job-facts.mjs', import.meta.url))).href;

const plain = (row) => row.replaceAll(/\u001b\[[0-9;]*m/g, '');
const sgrCodes = (rows) => new Set(rows.flatMap((row) => [...row.matchAll(/\u001b\[([0-9;]*)m/g)].map((match) => match[1])));
const lookFor = (env, columns, platform = 'darwin') => lookOf(env, platform, columns - CUT_MARGIN);

const agent = (id, fields = {}) => ({
  id, name: id, type: 'implementer', state: 'run', writer: true, pct: 40, conf: 'medium', elapsedMin: 5, leftMin: 10, highLeftMin: 25,
  overMin: 0, usual: [10, 30], tag: null, doing: 'Edit render.mjs', calls: 12, tokens: 40_000, quietMin: 0, pendingMin: 0,
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
const boardOf = (fields = {}) => ({ session: 'calm', at: NOW, stale: null, asking: null, agents: [], repo: repoOf([]), repos: [], git: null, road: null, trend: null, ...fields });

/** An estimate cache entry: the whole job of 21 rows (11 done), the given open rows, and the road step when given. */
const segmentOf = ({ road = null, rows = [] } = {}) => ({
  kind: 'finish', text: 'done by 11:10', highMs: NOW + 130 * MIN_MS,
  numbers: { finishMs: NOW + 130 * MIN_MS, p85Ms: NOW + 165 * MIN_MS, leftMin: 130, workedMin: 140, rowsDone: 11, rowsTotal: 21, rows },
  progress: { pct: 51, approx: false, rowsDone: 11, rowsTotal: 21, leftMin: 130, tag: null, road },
});
const ROAD_FINAL = { name: 'final', step: 2, steps: 4, rowsDone: 2, rowsTotal: 5, leftMin: 40, clockMs: NOW + 40 * MIN_MS, p85Ms: NOW + 65 * MIN_MS };
const SESSION_INPUT = {
  model: { display_name: 'Opus 5.5' }, effort: { level: 'high' },
  context_window: { context_window_size: 400_000, current_usage: { input_tokens: 99_000 } },
  rate_limits: { five_hour: { used_percentage: 46, resets_at: (NOW + 160 * MIN_MS) / 1000 }, seven_day: { used_percentage: 31, resets_at: (NOW + 4 * 1440 * MIN_MS) / 1000 } },
};
const viewOf = (env, fields) => ({ input: SESSION_INPUT, segment: null, board: null, asking: null, limitsFile: null, account: 'work', env, nowMs: NOW, timeZone: 'UTC', ...fields });

/** Nothing needs a look: a job with one started row, main only, no agent. */
const calmView = (env) => viewOf(env, { segment: segmentOf({ rows: [{ id: 'docs', expectMin: 40, startedMs: NOW - 10 * MIN_MS }] }), board: boardOf() });

/** Busy: a question waits, the live road `final`, 5 agents running (one quiet, one over its usual time) and one just done, 3 lanes. */
function busyView(env) {
  const agents = [
    agent('reviewer', { type: 'reviewer', writer: false, state: 'quiet', quietMin: 6 }), agent('implementer', { overMin: 12, leftMin: 0 }),
    agent('impl-a', { wt: 'remove-modes', branch: 'remove-modes' }), agent('impl-b', { wt: 'road-gate', branch: 'road-gate' }),
    agent('scout', { type: 'scout', writer: false, leftMin: 3 }), agent('done-one', { state: 'done', doneMs: NOW - 2 * MIN_MS }),
  ];
  const lanes = [worktree('remove-modes', { ahead: 7 }), worktree('road-gate', { ahead: 8, changed: 2 }), worktree('sync-remote', {})];
  const board = boardOf({
    agents, repo: repoOf(lanes, { upAhead: 44 }), trend: { deltaMin: 70, atMs: NOW },
    road: { name: 'final', step: 2, steps: 4, title: 'calm palette', lanesDone: 2, lanesTotal: 5, goal: 'final polish', live: true },
  });
  return viewOf(env, { segment: segmentOf({ road: ROAD_FINAL }), board, asking: { kind: 'question', count: 1, expiresAt: NOW + 160_000 } });
}

const rowsAt = (view, env, columns, platform) => statusRows(view(env), lookFor(env, columns, platform));
const whereAt = (view, columns) => whereTree({ ...view, limits: [], lastSeen: null }, lookFor(view.env, columns));

test('busy with a question: 4 rows at 80, 100 and 120 columns; calm: 2 rows; every row within COLUMNS - 5', () => {
  for (const columns of COLUMNS) {
    const busy = rowsAt(busyView, TERM_256, columns);
    const calm = rowsAt(calmView, TERM_256, columns);
    assert.equal(busy.length, 4, busy.map(plain).join('\n'));
    assert.equal(calm.length, 2, calm.map(plain).join('\n'));
    assert.match(plain(busy[0]), /^\? ANSWER NEEDED · 1 question/);
    assert.match(plain(busy[2]), /^agents /, 'one agents summary row (RC8)');
    for (const row of [...busy, ...calm]) assert.ok([...plain(row)].length <= columns - CUT_MARGIN, `${columns}: ${plain(row)}`);
  }
});

test('colour only for a state (RC5): codes within {0,1,2,31,33,35,36}; nothing but dim while nothing needs a look', () => {
  for (const columns of COLUMNS) {
    const busy = sgrCodes(rowsAt(busyView, TERM_256, columns));
    for (const code of busy) assert.ok(ALLOWED_SGR.has(code), `${columns}: SGR ${code}`);
    assert.ok(busy.has('35') && busy.has('33'), 'the question in magenta, the quiet agent in yellow');
    assert.deepEqual([...sgrCodes(rowsAt(calmView, TERM_256, columns))].sort(), ['0', '2'], `${columns}: calm is plain and dim`);
  }
});

test('NO_COLOR prints no escape code and every state keeps its word', () => {
  const rows = COLUMNS.flatMap((columns) => rowsAt(busyView, NO_COLOR_ENV, columns));
  assert.ok(rows.every((row) => !row.includes(ESC)));
  const wide = rowsAt(busyView, NO_COLOR_ENV, 120).join('\n');
  for (const word of ['ANSWER NEEDED', 'quiet 6 min', 'over 12 min', 'later']) assert.ok(wide.includes(word), word);
});

test('RC6: 30 unstarted and 2 started rows, no live road: the time left is the started rows\' expected minutes; /where counts all 32', () => {
  const unstarted = Array.from({ length: 30 }, (_, index) => ({ id: `o${index}`, expectMin: 40, startedMs: null }));
  const started = [{ id: 's1', expectMin: 40, startedMs: NOW }, { id: 's2', expectMin: 9, startedMs: NOW }];
  const segment = { ...segmentOf({ rows: [...started, ...unstarted] }), numbers: { ...segmentOf().numbers, rowsDone: 0, rowsTotal: 32, leftMin: 1209, rows: [...started, ...unstarted] } };
  const view = viewOf(NO_COLOR_ENV, { segment, board: boardOf() });
  const job = plain(statusRows(view, lookFor(NO_COLOR_ENV, 120))[0]);
  assert.match(job, /^ALL +\S+ +0% +49 min left · by 09:49 · 2 rows started$/, job);
  assert.match(plain(whereAt(view, 120)[0]), /20 h left .* 0\/32 rows$/, '/where: the whole job');
});

test('a started row past its expected minutes says how far over its plan, in yellow', () => {
  const segment = segmentOf({ rows: [{ id: 's1', expectMin: 30, startedMs: NOW - 50 * MIN_MS }] });
  const row = statusRows(viewOf(TERM_256, { segment, board: boardOf() }), lookFor(TERM_256, 120))[0];
  assert.match(plain(row), /3 min left · by 09:03 · 20 min over plan/, plain(row));
  assert.ok(row.includes('\u001b[33m20 min over plan'), row);
});

test('the agent counts add up: the summary row and /where give the total as the sum of its parts', () => {
  const board = boardOf({ agents: [...['a', 'b', 'c', 'd', 'e'].map((id) => agent(id)), agent('f', { state: 'done', doneMs: NOW - MIN_MS })] });
  const view = viewOf(NO_COLOR_ENV, { board });
  assert.match(plain(statusRows(view, lookFor(NO_COLOR_ENV, 120))[1]), /^agents +6 · 5 running · 1 done +all by 09:10$/);
  assert.ok(whereAt(view, 120).some((line) => line.includes('6 agents (5 run, 1 done last 10 min)')), whereAt(view, 120).join('\n'));
});

test('F7: a road with live false is not on the line and its rows are not counted; /where shows it idle; an old board road shows', () => {
  const stale = busyView(NO_COLOR_ENV);
  stale.board = { ...stale.board, road: { ...stale.board.road, live: false } };
  stale.segment = segmentOf({ road: ROAD_FINAL, rows: [{ id: 'final.s2.a', expectMin: 40, startedMs: NOW - 9 * 24 * 60 * MIN_MS }] });
  const line = statusRows(stale, lookFor(NO_COLOR_ENV, 120)).join('\n');
  assert.doesNotMatch(line, /road|final/, line);
  assert.match(line, /ALL +nothing started · 10 rows open/, 'the stale road\'s old started row is not live work');
  assert.ok(whereAt(stale, 120).some((row) => /^road final · idle · step 2\/4/.test(plain(row))), whereAt(stale, 120).join('\n'));
  const old = busyView(NO_COLOR_ENV);
  delete old.board.road.live; // a board file written before `live` existed
  assert.match(statusRows(old, lookFor(NO_COLOR_ENV, 120))[1], /road final 2\/4 · 2\/5 lanes$/);
});

test('F1: hostile agent and branch names (escape codes, bidi marks, 300 characters) are cleaned and the rows stay within COLUMNS - 5', () => {
  const hostile = (word) => `\u001b[31m${word}‮⁦${'x'.repeat(300)}\u0007`;
  const view = (env) => {
    const busy = busyView(env);
    busy.board.agents = busy.board.agents.map((entry) => ({ ...entry, name: hostile(entry.id) }));
    busy.board.repo.worktrees = busy.board.repo.worktrees.map((wt) => ({ ...wt, name: hostile(wt.name), op: wt.main ? hostile('rebase') : null }));
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

test('F4: no board, no segment, no rate_limits and current_usage null still give 2 rows with `ctx ?` and `git: loading`', () => {
  const view = { input: { model: { display_name: 'Opus 5.5' }, context_window: { current_usage: null } }, segment: null, board: null, asking: null, limitsFile: null, account: undefined, env: {}, nowMs: NOW, timeZone: 'UTC' };
  const rows = statusRows(view, lookFor(NO_COLOR_ENV, 80)).map(plain);
  assert.equal(rows.length, 2);
  assert.equal(rows[0], 'ALL no job linked');
  assert.match(rows[1], /^git: loading +Opus 5\.5 · ctx \? · account \?$/);
});

test('F5: 40 agents, 30 worktrees and 300 open rows give one agents row and one git count', () => {
  const agents = Array.from({ length: 40 }, (_, index) => agent(`agent-${index}`, index % 10 === 0 ? { state: 'quiet', quietMin: 4 } : {}));
  const lanes = Array.from({ length: 30 }, (_, index) => worktree(`lane-${index}`, { changed: index % 2 }));
  const rows = Array.from({ length: 300 }, (_, index) => ({ id: `r${index}`, expectMin: 9, startedMs: index < 3 ? NOW : null }));
  const view = viewOf(NO_COLOR_ENV, { board: boardOf({ agents, repo: repoOf(lanes) }), segment: segmentOf({ rows }) });
  for (const columns of COLUMNS) {
    const shown = statusRows(view, lookFor(NO_COLOR_ENV, columns)).map(plain);
    assert.equal(shown.length, 3, shown.join('\n'));
    assert.match(shown[1], /^agents +40 running · ! agent-0 quiet 4 min/);
    const named = shown[1].match(/quiet 4 min/g)?.length ?? 0;
    const more = Number(/\+(\d+) more/.exec(shown[1])?.[1] ?? 0);
    assert.equal(named + more, 4, `every quiet agent named or counted: ${shown[1]}`);
    assert.match(shown[2], /^git +main ✓ · 30 lanes( open)? · 15 dirty/);
  }
});

test('F6: Windows Terminal (WT_SESSION, no 256-colour TERM) gets only the basic codes; ASCII mode prints no byte above 0x7E', () => {
  for (const columns of COLUMNS) {
    for (const code of sgrCodes(rowsAt(busyView, WINDOWS_TERMINAL_ENV, columns, 'win32'))) assert.ok(ALLOWED_SGR.has(code), `SGR ${code}`);
    for (const row of rowsAt(busyView, ASCII_ENV, columns)) assert.doesNotMatch(row, /[^ -~]/, row);
  }
});

test('F8: the last row draws with no board (statusline.mjs prints it alone when drawing fails)', () => {
  const row = plain(sessionRow(viewOf(NO_COLOR_ENV, { board: null }), lookFor(NO_COLOR_ENV, 100)));
  assert.match(row, /^git: loading +Opus 5\.5 high · ctx 25% · 5h 54% left · 7d 69% left · acct work$/);
});

test('F2: the row modules read no file, start nothing and keep no clock of their own (a render is drawn from the files statusline.mjs read)', () => {
  for (const name of ['render', 'layout', 'work-row', 'stat-rows', 'git-rows', 'cells']) {
    const source = readFileSync(fileURLToPath(new URL(`../home/tools/board/lib/${name}.mjs`, import.meta.url)), 'utf8');
    assert.doesNotMatch(source, /from 'node:|Date\.now\(\)/, name);
  }
});

test('F3: an old board file (identity hue fields, the old counts, no road.live) draws without an error line', () => {
  const old = busyView(TERM_256);
  old.board = { ...old.board, hues: { 'impl-a': 3 }, identity: { items: [] }, git: { branch: 'main', ahead: 0, behind: 0, changed: 0 } };
  delete old.board.road.live;
  const rows = statusRows(old, lookFor(TERM_256, 120));
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => !row.includes('error')));
});

/** jobFacts in a child with a temp HOME: STATUS.md rows of road `rd`, the estimate cache at step 1, the session started at sinceMs. */
function roadLive(rows, sinceMs) {
  const root = makeTempDir('calm-road-');
  const home = join(root, 'home');
  const folder = join(root, 'work');
  mkdirSync(folder, { recursive: true });
  const statusFile = join(folder, 'STATUS.md');
  const head = '# STATUS\n\n## Work items\n\n| id | item | size | started | done | evidence |\n| -- | ---- | ---- | ------- | ---- | -------- |\n';
  writeFileSync(statusFile, `${head}${rows.map(([id, started]) => `| ${id} | build: ${id} | S | ${started} | - | - |`).join('\n')}\n`);
  const cache = join(home, '.claude', 'state', 'estimate-segment');
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  const entry = { path: statusFile, text: null, highMs: null, kind: null, mtimeMs: 0, size: 0, computedAt: 0, refreshStartedAt: 0,
    progress: { pct: 0, approx: false, rowsDone: 0, rowsTotal: 1, leftMin: null, tag: null, road: { name: 'rd', step: 1, steps: 2 } } };
  writeFileSync(join(cache, `${createHash('sha256').update(statusFile).digest('hex').slice(0, 32)}.json`), JSON.stringify(entry), { mode: 0o600 });
  const script = `import { jobFacts } from ${JSON.stringify(JOB_FACTS)}; const f = jobFacts({ session: 'no-such-session', cwd: ${JSON.stringify(folder)}, cache: { sinceMs: ${sinceMs} }, nowMs: ${sinceMs} + 60000 }); process.stdout.write(JSON.stringify({ live: f.road?.live, sinceMs: f.cache.sinceMs }));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
  return JSON.parse(child.stdout || 'null');
}

test('F7: job-facts marks the road live only when a row of its current step started or finished this session', () => {
  const since = Date.parse('2026-11-22T08:00:00Z');
  assert.deepEqual(roadLive([['rd.s1.a', '2026-11-22T08:30Z'], ['rd.s2.b', '-']], since), { live: true, sinceMs: since });
  assert.deepEqual(roadLive([['rd.s1.a', '2026-11-12T08:30Z'], ['rd.s2.b', '2026-11-22T08:30Z']], since), { live: false, sinceMs: since }, 'a later step moving does not make step 1 live');
  assert.deepEqual(roadLive([['rd.s1.a', '-']], since), { live: false, sinceMs: since });
});
