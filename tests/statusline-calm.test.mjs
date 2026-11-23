// Tests for the status line's rows on busy and idle sessions (spec R18; owner decisions RC14 to RC18 of 2026-11-22): 6 rows when busy
// and 2 when idle, colour by kind, the job row for the whole job and the now row for the running rows, one agents summary row, no
// stale road; and the lane's F questions: F1 NO_COLOR, TERM=dumb, ASCII mode and a Windows console print the same words with no
// escape code (and no byte above 0x7E in ASCII); F2 an old board or cache file without the R18 fields still draws every row; F3
// COLUMNS 40 to 120 and LINES 10 to 24 keep every row within COLUMNS - 5 and the rows within the budget 2, 4 or 6; and hostile
// names, a render from files only, huge input, a stale road, a failed draw. Rows come from home/tools/board/lib/render.mjs
// statusRows (pure), `/where` from tree.mjs whereTree, and the road's `live` from job-facts.mjs run in a child with a temp HOME.
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
// reset, bold, dim, the reserved red, yellow and magenta, and the 16-colour kinds: branch green, bar cyan, time blue, session white
const BASIC_SGR = new Set(['0', '1', '2', '31', '33', '35', '32', '36', '34', '37']);
const RESERVED_SGR = new Set(['31', '33', '35']);
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

/** Idle: no job, no agent, main only. */
const idleView = (env) => viewOf(env, { board: boardOf() });

test('busy with a question: 6 rows at 80, 100 and 120 columns (the lanes row left out); idle: 2 rows; every row within COLUMNS - 5', () => {
  for (const columns of COLUMNS) {
    const busy = rowsAt(busyView, TERM_256, columns);
    const idle = rowsAt(idleView, TERM_256, columns);
    assert.equal(busy.length, 6, busy.map(plain).join('\n'));
    assert.equal(idle.length, 2, idle.map(plain).join('\n'));
    assert.deepEqual(busy.map((row) => plain(row).split(' ')[0]), ['?', 'job', 'now', 'agents', 'git', 'session'], busy.map(plain).join('\n'));
    assert.deepEqual(idle.map((row) => plain(row).split(' ')[0]), ['git', 'session']);
    for (const row of [...busy, ...idle]) assert.ok([...plain(row)].length <= columns - CUT_MARGIN, `${columns}: ${plain(row)}`);
  }
});

test('colour by kind (RC14): idle prints no yellow, red or magenta; busy shows the question in magenta and the quiet agent in yellow', () => {
  for (const columns of COLUMNS) {
    const busy = sgrCodes(rowsAt(busyView, TERM_256, columns));
    assert.ok(busy.has('35') && busy.has('33'), 'the question in magenta, the quiet agent in yellow');
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
  for (const word of ['ANSWER NEEDED', 'quiet 6 min', 'over 12 min', '2 of 5 lanes landed']) assert.ok(wide.includes(word), word);
});

test('RC16: 30 unstarted and 2 started rows, no live road: the job row is the whole job, the now row the 2 started rows; /where counts all 32', () => {
  const unstarted = Array.from({ length: 30 }, (_, index) => ({ id: `o${index}`, expectMin: 40, startedMs: null }));
  const started = [{ id: 's1', expectMin: 40, startedMs: NOW }, { id: 's2', expectMin: 9, startedMs: NOW }];
  const segment = { ...segmentOf({ rows: [...started, ...unstarted] }), numbers: { ...segmentOf().numbers, rowsDone: 0, rowsTotal: 32, leftMin: 1209, rows: [...started, ...unstarted] } };
  const view = viewOf(NO_COLOR_ENV, { segment, board: boardOf() });
  const [job, now] = statusRows(view, lookFor(NO_COLOR_ENV, 100)).map(plain);
  assert.equal(job, 'job     ░░░░░░░░ 0/32 rows done · 20 h work left · done by 11:10');
  assert.equal(now, 'now     2 rows running: s1, s2 · 49 min work left · by 09:49', 'an old cache row without leftMin: its expected minutes less the elapsed ones');
  assert.match(plain(whereAt(view, 120)[0]), /20 h left .* 0\/32 rows$/, '/where: the whole job');
});

test('E3: a started row\'s time left is its own median, and past its size\'s median it is `over usual`, in yellow', () => {
  const segment = segmentOf({ rows: [{ id: 's1', expectMin: 30, leftMin: 12, startedMs: NOW - 50 * MIN_MS }] });
  const row = statusRows(viewOf(TERM_256, { segment, board: boardOf() }), lookFor(TERM_256, 100))[1];
  assert.equal(plain(row), 'now     1 row running: s1 · 12 min work left · by 09:12 · s1 20 min over usual');
  assert.ok(row.includes('\u001b[33ms1 20 min over usual'), row);
});

test('the agents row: running and done counts, `all done ~` with its clock only while no job or now row shows a clock; /where adds up', () => {
  const board = boardOf({ agents: [...['a', 'b', 'c', 'd', 'e'].map((id) => agent(id)), agent('f', { state: 'done', doneMs: NOW - MIN_MS })] });
  const view = viewOf(NO_COLOR_ENV, { board });
  assert.equal(plain(statusRows(view, lookFor(NO_COLOR_ENV, 100))[0]), 'agents  5 running · 1 done · all done ~09:10');
  const busy = viewOf(NO_COLOR_ENV, { board, segment: segmentOf({ road: ROAD_FINAL }) });
  assert.equal(plain(statusRows(busy, lookFor(NO_COLOR_ENV, 100))[2]), 'agents  5 running · 1 done', 'the job and now rows carry the clocks');
  assert.ok(whereAt(view, 120).some((line) => line.includes('6 agents (5 run, 1 done last 10 min)')), whereAt(view, 120).join('\n'));
});

test('a late job says by how much and why on the job row: yellow within the 85 % margin, red past it; an old entry without lateMin is not late', () => {
  const late = (lateMin, p85Min) => ({ ...segmentOf({ road: ROAD_FINAL }), numbers: { ...segmentOf().numbers, p85Ms: NOW + p85Min * MIN_MS, lateMin, lateCause: { cause: 'rows-added', ids: ['x', 'y'], count: 2 } } });
  const jobAt = (segment, columns) => statusRows(viewOf(TERM_256, { segment, board: boardOf() }), lookFor(TERM_256, columns))[0];
  assert.equal(plain(jobAt(late(25, 165), 100)), 'job     ████░░░░ 11/21 rows done · 2 h 10 work left · done by 11:10, 25 min late: 2 rows added');
  assert.ok(jobAt(late(25, 165), 100).includes('\u001b[33m, 25 min late'), 'margin 35 min: yellow');
  assert.ok(jobAt(late(40, 165), 100).includes('\u001b[31m, 40 min late'), 'past the 35 min margin: red');
  assert.equal(plain(jobAt(late(25, 165), 130)), 'job     ████████░░░░░░░░  11 of 21 rows done · about 2 h 10 of work left · done by 11:10 · late by 25 min (2 rows added)');
  assert.match(plain(jobAt(late(25, 165), 120)), / · late by 25 min$/, 'a full row drops the cause first, never the late amount');
  assert.doesNotMatch(plain(jobAt(segmentOf({ road: ROAD_FINAL }), 100)), /late/);
});

test('F7: a road with live false is not on the line and its rows are not counted; /where shows it idle; an old board road shows', () => {
  const stale = busyView(NO_COLOR_ENV);
  stale.board = { ...stale.board, road: { ...stale.board.road, live: false } };
  stale.segment = segmentOf({ road: ROAD_FINAL, rows: [{ id: 'final.s2.a', expectMin: 40, startedMs: NOW - 9 * 24 * 60 * MIN_MS }] });
  const line = statusRows(stale, lookFor(NO_COLOR_ENV, 120)).join('\n');
  assert.doesNotMatch(line, /final|step|^job|^now/m, 'no live work: neither the job nor the now row');
  assert.ok(whereAt(stale, 120).some((row) => /^road final · idle · step 2\/4/.test(plain(row))), whereAt(stale, 120).join('\n'));
  const old = busyView(NO_COLOR_ENV);
  delete old.board.road.live; // a board file written before `live` existed
  assert.equal(statusRows(old, lookFor(NO_COLOR_ENV, 100))[2], 'now     step 2 of 4 · ██░░░░ 2/5 lanes landed · 40 min work left · step done by 09:40', 'the title drops first');
  assert.equal(plain(statusRows(old, lookFor(NO_COLOR_ENV, 120))[2]), 'now     step 2 of 4 calm palette · ██░░░░ 2 of 5 lanes landed · about 40 min of work left · step done by 09:40');
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

test('F4: no board, no segment, no rate_limits and current_usage null still give 2 rows with `context ?` and `git loading`', () => {
  const view = { input: { model: { display_name: 'Opus 5.5' }, context_window: { current_usage: null } }, segment: null, board: null, asking: null, limitsFile: null, account: undefined, env: {}, nowMs: NOW, timeZone: 'UTC' };
  assert.deepEqual(statusRows(view, lookFor(NO_COLOR_ENV, 80)).map(plain), ['git loading', 'session Opus 5.5 · context ? · acct ?']);
});

test('F5: 40 agents, 30 worktrees and 300 open rows give one agents row and one lanes row, every agent and lane named or counted', () => {
  const agents = Array.from({ length: 40 }, (_, index) => agent(`agent-${index}`, index % 10 === 0 ? { state: 'quiet', quietMin: 4 } : {}));
  const lanes = Array.from({ length: 30 }, (_, index) => worktree(`lane-${index}`, { changed: index % 2 }));
  const rows = Array.from({ length: 300 }, (_, index) => ({ id: `r${index}`, expectMin: 9, startedMs: index < 3 ? NOW : null }));
  const view = viewOf(NO_COLOR_ENV, { board: boardOf({ agents, repo: repoOf(lanes) }), segment: segmentOf({ rows }) });
  for (const columns of COLUMNS) {
    const shown = statusRows(view, lookFor(NO_COLOR_ENV, columns)).map(plain);
    assert.deepEqual(shown.map((row) => row.split(' ')[0]), ['job', 'now', 'agents', 'git', 'lanes', 'session'], shown.join('\n'));
    assert.match(shown[2], /^agents +40 running · ! agent-0 quiet 4 min/);
    const named = shown[2].match(/quiet 4 min/g)?.length ?? 0;
    const more = Number(/\+(\d+) more/.exec(shown[2])?.[1] ?? 0);
    assert.equal(named + more, 4, `every quiet agent named or counted: ${shown[2]}`);
    const lanesNamed = shown[4].match(/lane-\d+/g)?.length ?? 0;
    assert.equal(lanesNamed + Number(/\+(\d+) more$/.exec(shown[4])?.[1] ?? 0), 30, `every lane named or counted: ${shown[4]}`);
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
  const budget = { 10: 2, 15: 4, 24: 6, '': 6 };
  for (const [lines, rows] of Object.entries(budget)) {
    for (const columns of [40, ...COLUMNS]) {
      const env = { ...TERM_256, LINES: lines };
      const shown = statusRows(busyView(env), lookFor(env, columns));
      assert.equal(shown.length, rows, `LINES ${lines}: ${shown.map(plain).join(' | ')}`);
      for (const row of shown) assert.ok([...plain(row)].length <= columns - CUT_MARGIN, `${columns}: ${plain(row)}`);
      assert.match(plain(shown.at(-1)), /^session /, 'the session row always');
    }
  }
  const short = statusRows(busyView({ ...TERM_256, LINES: '15' }), lookFor(TERM_256, 100)).map((row) => plain(row).split(' ')[0]);
  assert.deepEqual(short, ['?', 'job', 'git', 'session'], 'kept in order: session, git, alert, job');
});

test('F8: the session row draws with no board (statusline.mjs prints it alone when drawing fails)', () => {
  const row = plain(sessionRow(viewOf(NO_COLOR_ENV, { board: null }), lookFor(NO_COLOR_ENV, 100)));
  assert.equal(row, 'session Opus 5.5 high · context 25% · 5h 54% left · 7d 69% left · acct work');
});

test('F2: the row modules read no file, start nothing and keep no clock of their own (a render is drawn from the files statusline.mjs read)', () => {
  for (const name of ['render', 'layout', 'work-row', 'range-rows', 'stat-rows', 'git-rows', 'cells']) {
    const source = readFileSync(fileURLToPath(new URL(`../home/tools/board/lib/${name}.mjs`, import.meta.url)), 'utf8');
    assert.doesNotMatch(source, /from 'node:|Date\.now\(\)/, name);
  }
});

test('F2: an old board file (identity hues, no active, trust, stash or check, no road.live) and an old cache entry (no lateMin, no row leftMin) draw every row', () => {
  const old = busyView(TERM_256);
  old.board = { ...old.board, hues: { 'impl-a': 3 }, identity: { items: [] }, git: { branch: 'main', ahead: 0, behind: 0, changed: 0 } };
  delete old.board.road.live;
  const rows = statusRows(old, lookFor(TERM_256, 120));
  assert.equal(rows.length, 6);
  assert.ok(rows.every((row) => plain(row).trim() !== '' && !row.includes('error')), rows.map(plain).join('\n'));
  const entry = { kind: 'finish', text: 'done by 11:10', highMs: NOW + 130 * MIN_MS, numbers: null, progress: { pct: 51, approx: false, rowsDone: 11, rowsTotal: 21, leftMin: 130, tag: null, road: ROAD_FINAL } };
  const fromOld = statusRows(viewOf(NO_COLOR_ENV, { segment: entry, board: boardOf({ road: { name: 'final', step: 2, steps: 4 } }) }), lookFor(NO_COLOR_ENV, 100)).map(plain);
  assert.equal(fromOld[0], 'job     ████░░░░ 11/21 rows done · 2 h 10 work left · done by 11:10', 'the progress counts and the highMs clock');
  assert.equal(fromOld[1], 'now     step 2 of 4 · ██░░░░ 2/5 rows done · 40 min work left · step done by 09:40', 'no lane facts: the step\'s rows');
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
