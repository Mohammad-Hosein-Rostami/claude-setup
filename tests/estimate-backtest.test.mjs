// Tests for home/tools/estimate/backtest.mjs as a command: usage errors, the scanner and threshold report on a tiny synthetic
// setup (two tables, one session each), and the seed it writes (table hash, size, kind, done, cost; no ids, no text).
// `--freeze` (model s1's frozen data and seed runs): ids rewritten and no row text, path or session id in the files (hostile
// names too), no clock time, working minutes clipped to the activity, the same bytes on a second run, an empty seed with a message,
// tables numbered by first minute, every fail-closed refusal, the held-out filter, and the committed backtest-data/*.json and
// seed-runs.json held to the same share-safe shape (each id, road and seed run tied to its row, every time a table offset).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_KINDS, LEAD_KINDS, MAX_RUN_MIN, MIN_RUN_MIN, kindPools } from '../home/tools/estimate/lib/kinds.mjs';
import { seedRunsWithout } from '../home/tools/estimate/lib/freeze-data.mjs';
import { workedMinutes, workingIntervals } from '../home/tools/estimate/lib/worked.mjs';
import { SESSION, iso, row, statusDoc, writeTranscript } from './estimate-tables.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const CLI = fileURLToPath(new URL('../home/tools/estimate/backtest.mjs', import.meta.url));
const SESSIONS = ['aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002'];
const HEADER = '## Work items\n\n| id | item | size | started | done | evidence |\n| -- | ---- | ---- | ------- | ---- | -------- |\n';

/** Two tables of two done S rows and one hand-over each; every minute of 10:00-10:40 is active in both sessions. */
function fixture(t) {
  const root = makeTempDir('est-backtest-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = join(root, 'projects', '-Users-me-p');
  mkdirSync(folder, { recursive: true });
  const jobs = SESSIONS.map((session, k) => {
    const minutes = Array.from({ length: 41 }, (_, m) => `{"timestamp":"2026-11-16T10:${String(m).padStart(2, '0')}:00.000Z"}`);
    writeFileSync(join(folder, `${session}.jsonl`), `${minutes.join('\n')}\n`);
    const statusPath = join(root, `t${k}.STATUS.md`);
    writeFileSync(statusPath, `${HEADER}| r1 | secret text one | S | 2026-11-16T10:00Z | 2026-11-16T10:20Z | abc1234 |\n| r2 | close: secret two | S | 2026-11-16T10:20Z | 2026-11-16T10:40Z | abc1234 |\n| deliver:1 | deliver: done | S | - | 2026-11-16T10:40Z | - |\n`);
    return `${statusPath}=${session}`;
  });
  return { root, jobs, args: ['--now', '2026-11-16T12:00Z', '--projects', join(root, 'projects'), '--state-dir', join(root, 'state')] };
}

const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('backtest: a missing --job or a job without a session id is a usage error (exit 2)', (t) => {
  const { root } = fixture(t);
  assert.equal(run(['--now', '2026-11-16T12:00Z']).status, 2);
  const bad = run(['--job', join(root, 't0.STATUS.md')]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /is not <STATUS\.md>=<session-id>/);
});

test('backtest prints the scanner numbers and every threshold row, and exits 1 when one fails', (t) => {
  const { jobs, args } = fixture(t);
  const result = run([...jobs.flatMap((job) => ['--job', job]), ...args]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /t0\.STATUS\.md: working time first to last stamp 0\.67 h; 2 done work rows, 2 with a cost; jobs \(rows, hours\): 2, 0\.67/);
  assert.match(result.stdout, /rows with a cost: 4/);
  assert.match(result.stdout, /Replay: 4 instants over 2 handed-over jobs/);
  assert.match(result.stdout, /\| instants with a time \| 0 of 4 \| >= 58 \| FAIL \|/); // two S rows per side: below the 5-row minimum
  assert.equal(result.stdout.match(/\| (PASS|FAIL) \|$/gm).length, 12);
  assert.doesNotMatch(result.stdout, /secret/);
});

test('backtest --write-seed writes every finished row and job with its table hash and no ids or text', (t) => {
  const { root, jobs, args } = fixture(t);
  const seedFile = join(root, 'seed.json');
  run([...jobs.flatMap((job) => ['--job', job]), ...args, '--write-seed', seedFile]);
  const seed = JSON.parse(readFileSync(seedFile, 'utf8'));
  assert.equal(seed.v, 2);
  assert.equal(seed.rows.length, 4);
  assert.deepEqual(Object.keys(seed.rows[0]), ['table', 'size', 'kind', 'done', 'cost']);
  assert.deepEqual(seed.rows.slice(0, 2).map((row) => [row.size, row.kind, row.done, row.cost]), [['S', 'build', '2026-11-16T10:20:00.000Z', 20], ['S', 'close', '2026-11-16T10:40:00.000Z', 20]]);
  assert.match(seed.rows[0].table, /^[0-9a-f]{32}$/);
  assert.notEqual(seed.rows[0].table, seed.rows[2].table);
  assert.deepEqual(seed.jobs.map((job) => [job.at, job.minutes]), [['2026-11-16T10:40:00.000Z', 40], ['2026-11-16T10:40:00.000Z', 40]]);
  assert.doesNotMatch(readFileSync(seedFile, 'utf8'), /secret|r1|r2/);
});

// --freeze ----------------------------------------------------------------------------------------------------------------------

const ESTIMATE_DIR = fileURLToPath(new URL('../home/tools/estimate/', import.meta.url));
const ROW_KEYS = ['id', 'road', 'step', 'kind', 'c3Kind', 'size', 'state', 'firstSeenMin', 'startedMin', 'doneMin'];
const STATES = ['done', 'dropped', 'open', 'parked', 'waiting'];
const C3_KINDS = ['build', 'close', 'rework', 'deliver'];
const MAX_OFFSET_MIN = 60 * 24 * 60; // 60 days from a table's first minute; an epoch minute (about 29 million) is far past it
// Hostile on purpose: roads named `s1` and `r22`, ids holding an escaped pipe or looking rewritten (`task9`), a path and secret
// words in item and evidence cells.
const HOSTILE_ROWS = [
  row({ id: 's1.s2.build-x', item: 'secret lane text', size: 'M', startedH: 1, doneH: 2.5 }), // runs 60 of its 90 min (a 30-min silence)
  row({ id: 's1.s2.check', item: 'secret gate', startedH: 2.5, doneH: 2.6 }), // a lead kind: no run
  row({ id: 'a\\|b', item: 'review: secret pipe row', startedH: 2, doneH: 2.25 }), // 15 min
  row({ id: 'r22.s1.lane-a', item: 'secret road lane', startedH: 2, doneH: 2.1 }), // 6 min
  row({ id: 'task9', item: 'secret listed row' }),
  row({ id: 'fix-thing', item: 'fix: bookkeeping', startedH: 2.25, doneH: 2.25, evidence: 'see /Users/someone/private' }), // 0 min
  row({ id: 'old', item: 'secret dropped work', startedH: 2, doneH: 2.5, evidence: 'dropped: secret reason' }),
  row({ id: 'open1', item: 'secret open row', startedH: 2.9 }),
  row({ id: 'long', item: 'secret long task', size: 'L', startedH: 3, doneH: 8 }), // 300 min: over 240
  row({ id: 'deliver:1', item: 'deliver: secret hand-over', doneH: 8 }),
];

/** A table, its session's transcript (active 1:00-1:30 and 2:00-8:00) and a store copy whose first sighting of the lane is 0:30. */
function freezeFixture(t, rows = HOSTILE_ROWS) {
  const root = realpathSync.native(makeTempDir('est-freeze-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projects = join(root, 'projects');
  writeTranscript(projects, SESSION, 1, 1.5);
  writeTranscript(projects, SESSION, 2, 8);
  const statusPath = join(root, 'STATUS.md');
  writeFileSync(statusPath, statusDoc(rows));
  const storePath = join(root, 'store.json');
  writeFileSync(storePath, JSON.stringify({ v: 2, path: statusPath, sessions: [SESSION], added: { 's1.s2.build-x': iso(0.5) }, rows: [], jobs: [], commit: null, log: [] }));
  const out = join(root, 'out');
  mkdirSync(out);
  const args = ['--freeze', `${statusPath}=${SESSION}`, '--store', `${statusPath}=${storePath}`, '--projects', projects, '--out', out];
  return { root, statusPath, storePath, out, args };
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** Every frozen file of a folder holding backtest-data/ and seed-runs.json, as { name: text }. */
function frozenFiles(dir) {
  const data = join(dir, 'backtest-data');
  const files = Object.fromEntries(readdirSync(data).filter((name) => name.endsWith('.json')).map((name) => [`backtest-data/${name}`, readFileSync(join(data, name), 'utf8')]));
  return { ...files, 'seed-runs.json': readFileSync(join(dir, 'seed-runs.json'), 'utf8') };
}

/** Each row's id and road as the freeze must write them from its own kind, road order and step: a raw id or road name fails. */
function assertIdsTied(name, rows) {
  const roads = [];
  const counts = new Map();
  for (const frozen of rows) {
    if (frozen.road !== null && !roads.includes(frozen.road)) roads.push(frozen.road);
    assert.equal(frozen.road, frozen.road === null ? null : `r${roads.indexOf(frozen.road) + 1}`, `${name}: road numbered in table order`);
    assert.ok(frozen.road === null ? frozen.step === null : Number.isInteger(frozen.step) && frozen.step > 0, `${name}: step of ${frozen.id}`);
    const key = `${frozen.road === null ? '' : `${frozen.road}.s${frozen.step}.`}${frozen.kind}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    assert.equal(frozen.id, `${key}${counts.get(key)}`, `${name}: id tied to its kind, road and step`);
  }
}

/** Every time is an offset from the table's own first minute: the earliest is in [0, 1), none is past MAX_OFFSET_MIN. */
function assertOffsets(name, table) {
  const rowTimes = table.rows.flatMap((frozen) => [frozen.firstSeenMin, frozen.startedMin, frozen.doneMin]).filter((min) => min !== null);
  const times = [...rowTimes, ...table.active.flat()];
  assert.ok(times.every((min) => Number.isFinite(min) && min >= 0 && min <= MAX_OFFSET_MIN), `${name}: a time is not a table offset`);
  if (rowTimes.length > 0) assert.ok(Math.min(...rowTimes) < 1, `${name}: the first time is not the table's first minute`);
  assert.ok(table.active.every((run) => run.length === 2 && Number.isInteger(run[0]) && Number.isInteger(run[1]) && run[0] < run[1]), name);
}

/** The share-safe shape (F1, F2, R3): fixed keys, allowlisted values, ids and seed runs tied to their rows, no clock time. */
function assertShareSafe(files) {
  const tables = new Map(Object.entries(files).filter(([name]) => name !== 'seed-runs.json').map(([name, text]) => [name, JSON.parse(text)]));
  for (const [name, table] of tables) {
    assert.deepEqual(Object.keys(table), ['v', 'table', 'rows', 'active'], name);
    assert.equal(`backtest-data/${table.table}.json`, name);
    assert.match(table.table, /^t\d+$/);
    for (const frozen of table.rows) {
      assert.deepEqual(Object.keys(frozen), ROW_KEYS, name);
      assert.ok([...AGENT_KINDS, ...LEAD_KINDS].includes(frozen.kind) && C3_KINDS.includes(frozen.c3Kind) && ['S', 'M', 'L'].includes(frozen.size) && STATES.includes(frozen.state), `${name}: ${frozen.id}`);
    }
    assertIdsTied(name, table.rows);
    assertOffsets(name, table);
  }
  const seed = JSON.parse(files['seed-runs.json']);
  assert.deepEqual(Object.keys(seed), ['v', 'rows']);
  for (const run of seed.rows) {
    assert.deepEqual(Object.keys(run), ['t', 'k', 'runMin', 'doneMin']);
    const rows = tables.get(`backtest-data/${run.t}.json`)?.rows ?? [];
    assert.ok(AGENT_KINDS.includes(run.k) && run.runMin >= MIN_RUN_MIN && run.runMin <= MAX_RUN_MIN, JSON.stringify(run));
    assert.ok(rows.some((frozen) => frozen.kind === run.k && frozen.state === 'done' && frozen.doneMin === run.doneMin), `seed run not tied to a done row: ${JSON.stringify(run)}`);
  }
}

test('backtest --freeze rewrites every id and writes no row text, path, session id, raw road name or clock time (F1, F2)', (t) => {
  const { root, out, args } = freezeFixture(t);
  const result = run(args);
  assert.equal(result.status, 0, result.stderr);
  const files = frozenFiles(out);
  assert.deepEqual(Object.keys(files), ['backtest-data/t1.json', 'seed-runs.json']);
  assertShareSafe(files);
  for (const text of Object.values(files)) {
    assert.doesNotMatch(text, /secret|someone|Users|bookkeeping|build-x|lane-a|fix-thing|open1|long|r22|task9|2026|T\d\d:|\||\\|"s1[."]/); // "s1: the raw road at a value's start (r2.s1.lane1 is fine)
    assert.ok(!text.includes(SESSION) && !text.includes(root));
  }
  const table = readJson(join(out, 'backtest-data', 't1.json'));
  assert.deepEqual(table.rows.map((frozen) => [frozen.id, frozen.state]), [
    ['r1.s2.lane1', 'done'], ['r1.s2.gate1', 'done'], ['review1', 'done'], ['r2.s1.lane1', 'done'], ['task1', 'open'],
    ['fix1', 'done'], ['task2', 'dropped'], ['task3', 'open'], ['task4', 'done'], ['deliver1', 'done'],
  ]);
  assert.deepEqual(table.rows[0], { id: 'r1.s2.lane1', road: 'r1', step: 2, kind: 'lane', c3Kind: 'build', size: 'M', state: 'done', firstSeenMin: 0, startedMin: 30, doneMin: 120 });
  assert.equal(table.rows[4].firstSeenMin, null); // listed, never stamped, not in the store
  assert.deepEqual(table.active, [[30, 60], [90, 450]]);
  assert.doesNotMatch(result.stdout, /secret/);
});

test('backtest --freeze seeds only finished agent runs of 1-240 working minutes, each with its table and done offset', (t) => {
  const { out, args } = freezeFixture(t);
  assert.equal(run(args).status, 0);
  // Lanes 6 (road r22) and 60 (90 wall min less a 30-min silence), review 15; no gate, 0-min, dropped, open, 300-min or hand-over.
  assert.deepEqual(readJson(join(out, 'seed-runs.json')), { v: 2, rows: [
    { t: 't1', k: 'lane', runMin: 6, doneMin: 96 }, { t: 't1', k: 'review', runMin: 15, doneMin: 105 }, { t: 't1', k: 'lane', runMin: 60, doneMin: 120 },
  ] });
});

test('backtest --freeze writes the same bytes again, so a re-freeze of fresh copies can be compared by sha256', (t) => {
  const { root, out, args } = freezeFixture(t);
  assert.equal(run(args).status, 0);
  const first = frozenFiles(out);
  const again = join(root, 'again');
  mkdirSync(again);
  assert.equal(run([...args.slice(0, -1), again]).status, 0);
  assert.equal(run(args).status, 0); // over its own earlier files
  assert.deepEqual(frozenFiles(again), first);
  assert.deepEqual(frozenFiles(out), first);
});

test('backtest --freeze of a table with no finished agent row writes an empty seed and says so, never a made-up pool (F3)', (t) => {
  const rows = [row({ id: 'w1', item: 'open', startedH: 2 }), row({ id: 'r.s1.check', item: 'gate', startedH: 2, doneH: 2.5 })];
  const { out, args } = freezeFixture(t, rows);
  const result = run(args);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readJson(join(out, 'seed-runs.json')), { v: 2, rows: [] });
  assert.match(result.stdout, /seed-runs\.json: no finished agent row with a run of 1-240 working minutes, so it holds no runs/);
});

test('backtest --freeze without a store lists each row at its first stamp, and one STATUS.md named twice takes both sessions', (t) => {
  const { statusPath, out, args } = freezeFixture(t);
  const other = 'aaaaaaaa-0000-0000-0000-000000000003';
  writeTranscript(join(out, '..', 'projects'), other, 0, 0.5);
  const result = run(['--freeze', `${statusPath}=${SESSION}`, `${statusPath}=${other}`, ...args.slice(4)]);
  assert.equal(result.status, 0, result.stderr);
  const table = readJson(join(out, 'backtest-data', 't1.json'));
  assert.equal(table.rows[0].firstSeenMin, 0); // the lane's start at 1:00 is the table's first minute now
  assert.deepEqual(table.active, [[0, 30], [60, 420]]); // the other session's 0:00-0:30 lies before the table's first time
  assert.match(result.stdout, /first seen at the first stamp \(no --store\)/);
});

test('backtest --freeze numbers the tables by their first minute, whatever order they are named in', (t) => {
  const { root, statusPath, out, args } = freezeFixture(t);
  const earlier = join(root, 'EARLIER.md');
  writeFileSync(earlier, statusDoc([row({ id: 'e1', item: 'secret', startedH: 0.25, doneH: 1.25 })]));
  const result = run([...args, `${earlier}=${SESSION}`]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`t1 = ${earlier}: 1 rows .*\\n  t2 = ${statusPath}: 10 rows`));
  assert.deepEqual(readJson(join(out, 'backtest-data', 't1.json')).rows.map((frozen) => [frozen.startedMin, frozen.doneMin]), [[0, 60]]);
});

test('backtest --freeze refuses bad input or output before writing anything (exit 2)', (t) => {
  const { root, statusPath, storePath, out, args } = freezeFixture(t);
  const without = (flag) => { const at = args.indexOf(flag); return [...args.slice(0, at), ...args.slice(at + 2)]; };
  const refusals = [
    [without('--out'), /usage: backtest\.mjs --freeze/],
    [['--freeze', `${statusPath}=../not a session`, ...args.slice(2)], /is not <STATUS\.md>=<session-id>/],
    [['--freeze', `${statusPath}=aaaaaaaa-0000-0000-0000-00000000000f`, ...args.slice(2)], /no transcript of session/],
    [[...args, '--store', `${join(root, 'other.md')}=${storePath}`], /cannot read/],
    [[...args, '--job', `${statusPath}=${SESSION}`], /Unknown option '--job'/],
  ];
  writeFileSync(join(root, 'bad-store.json'), JSON.stringify({ v: 2, added: { x: 'yesterday' } }));
  refusals.push([[...without('--store'), '--store', `${statusPath}=${join(root, 'bad-store.json')}`], /not an estimate table file/]);
  for (const [argv, why] of refusals) {
    const result = run(argv);
    assert.equal(result.status, 2, `${argv.join(' ')}: ${result.stderr}`);
    assert.match(result.stderr, why);
  }
  mkdirSync(join(out, 'backtest-data'));
  writeFileSync(join(out, 'backtest-data', 't9.json'), '{}');
  const stale = run(args);
  assert.equal(stale.status, 2);
  assert.match(stale.stderr, /holds t9\.json, which this freeze does not write/);
  rmSync(join(out, 'backtest-data'), { recursive: true });
  symlinkSync(root, join(out, 'backtest-data'));
  const linked = run(args);
  assert.equal(linked.status, 2);
  assert.match(linked.stderr, /is not a real folder/);
  assert.deepEqual(readdirSync(out), ['backtest-data']); // no seed-runs.json either
});

test('the committed backtest-data/*.json and seed-runs.json are share-safe and the seed is the frozen tables\' runs', () => {
  const files = frozenFiles(ESTIMATE_DIR);
  assertShareSafe(files);
  const tables = Object.entries(files).filter(([name]) => name.startsWith('backtest-data/')).map(([, text]) => JSON.parse(text));
  assert.ok(tables.length >= 2);
  const runs = tables.flatMap((table) => {
    const endMin = Math.max(0, ...table.rows.flatMap((frozen) => [frozen.startedMin ?? 0, frozen.doneMin ?? 0]));
    const intervals = workingIntervals(table.active, endMin);
    return table.rows.filter((frozen) => frozen.state === 'done' && AGENT_KINDS.includes(frozen.kind) && frozen.startedMin !== null)
      .map((frozen) => ({ t: table.table, k: frozen.kind, runMin: workedMinutes(intervals, frozen.startedMin, frozen.doneMin), doneMin: frozen.doneMin }))
      .filter((seed) => seed.runMin >= MIN_RUN_MIN && seed.runMin <= MAX_RUN_MIN);
  });
  const order = (a, b) => Number(a.t.slice(1)) - Number(b.t.slice(1)) || a.doneMin - b.doneMin || AGENT_KINDS.indexOf(a.k) - AGENT_KINDS.indexOf(b.k) || a.runMin - b.runMin;
  assert.deepEqual(JSON.parse(files['seed-runs.json']).rows, runs.sort(order));
});

test('a pool built to score the held-out table holds none of its runs, and an untagged seed row is refused (R2)', () => {
  const { rows } = readJson(join(ESTIMATE_DIR, 'seed-runs.json'));
  const heldOut = `t${readdirSync(join(ESTIMATE_DIR, 'backtest-data')).filter((name) => name.endsWith('.json')).length}`; // the newest
  const own = rows.filter((seed) => seed.t === heldOut);
  assert.ok(own.length > 0, `${heldOut} has seed runs, so the filter is tested on real ones`);
  const kept = seedRunsWithout(rows, heldOut);
  assert.ok(kept.length === rows.length - own.length && kept.every((seed) => seed.t !== heldOut));
  assert.equal(kindPools(kept).agent.length, kept.length);
  assert.throws(() => seedRunsWithout([{ k: 'lane', runMin: 5 }], heldOut), /needs its table tag/);
});
