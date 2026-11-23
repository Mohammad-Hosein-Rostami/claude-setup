// Tests of `road.mjs land` (road README, "Land"): join, land-lane and next in one call. Real git repositories in cs-test- temp folders.
// Most cases run runRoad in this process with a `run` that passes git through and stands in for land-lane, so each land-lane exit can be
// given; the argv it receives is checked with land-lane's own parser. The last case runs the real CLI and the real land-lane with a
// private HOME (land-lane-helpers makeWorld). Failure classes of the lane: P3 (a join refusal stops before land-lane, land-lane's exit
// passes through, next only after 0 or 1), F1 (hostile input or a road with two steps open: refused before any subprocess), F2 (a killed
// land-lane is exit 14 and the re-run takes land-lane's restart path).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../home/tools/land-lane/lib/args.mjs';
import { runRoad } from '../home/tools/road/road.mjs';
import { CLEAN_ENV, git } from './git-tidy-helpers.mjs';
import { makeWorld } from './land-lane-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const ROAD_CLI = fileURLToPath(new URL('../home/tools/road/road.mjs', import.meta.url));
const LAND_LANE_EXITS = Array.from({ length: 15 }, (_, code) => code); // land-lane.mjs header: 0-14
const KILLED_EXIT = 128; // road.mjs runProgram's exit for a child killed by a signal

const commitFiles = (cwd, files, message = 'change') => {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, name)), { recursive: true });
    writeFileSync(join(cwd, name), text);
  }
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
};

const laneOf = (name, files, extra = {}) => ({ name, item: `build ${name}`, size: 'S', branch: `lane/${name}`, files, implementer: { model: 'opus', effort: 'high' }, checkpoints: ['node --test: exit 0'], ...extra });

/** The STATUS.md of road `tr` as `rows` writes it; `done` maps a row id to its done cell and evidence. */
function statusText(baseSha, done = {}) {
  const row = (id, item) => `| ${id} | ${item} | S | ${done[id]?.at ?? '-'} | ${done[id]?.at ?? '-'} | ${done[id]?.evidence ?? '-'} |`;
  return ['# STATUS', '', '## Work items', '', '| id | item | size | started | done | evidence |', '| -- | -- | -- | -- | -- | -- |',
    row('tr.s1.a', 'build: build a'), row('tr.s1.check', `close: step 1 checkpoint, base ${baseSha}`), row('tr.s2.b', 'build: build b'),
    row('tr.s2.check', 'close: step 2 checkpoint'), ''].join('\n');
}

/** A road file `road-tr.json` and its STATUS.md in `folder` for the repo; returns the road file and its sha256. */
function writeRoad(folder, repo, baseSha) {
  const road = { road: 'tr', goal: 'g', repo, base: 'main', spec: '/spec.md', steps: [
    { goal: 's1', lanes: [laneOf('a', ['src/'])] }, { goal: 's2', lanes: [laneOf('b', ['other/'], { needs: ['a'] })] }] };
  const text = JSON.stringify(road);
  const roadFile = join(folder, 'road-tr.json');
  writeFileSync(roadFile, text);
  writeFileSync(join(folder, 'STATUS.md'), statusText(baseSha));
  return { roadFile, sha256: createHash('sha256').update(text).digest('hex'), statusFile: join(folder, 'STATUS.md') };
}

/** A repo on main, a lane worktree on lane/a with one commit in src/, and the road beside a STATUS.md. */
function fixture() {
  const root = realpathSync(makeTempDir('road-land-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(root, 'init', '-q', '-b', 'main', repo);
  git(repo, 'config', 'commit.gpgsign', 'false');
  const baseSha = commitFiles(repo, { 'README.md': 'base\n' }, 'base');
  const worktree = join(root, 'wt-a');
  git(repo, 'worktree', 'add', '-q', '-b', 'lane/a', worktree, baseSha);
  const tip = commitFiles(worktree, { 'src/feature.txt': 'x\n' });
  return { root, repo, worktree, baseSha, tip, ...writeRoad(root, repo, baseSha) };
}

const landFlags = (f, extra = [], overrides = {}) => ['--road-sha256', overrides.sha256 ?? f.sha256, '--lane', overrides.lane ?? 'a', '--worktree', overrides.worktree ?? f.worktree,
  '--base', overrides.base ?? f.baseSha, '--tip', overrides.tip ?? f.tip, ...extra];

/** A land-lane `--json` report line, as land-lane.mjs print() writes it. */
const report = (exit, state = `state-${exit}`) => JSON.stringify({ state, exit, to: null, from: null, lines: [`line of ${state}`] });

/**
 * A `run` that runs git for real and answers land-lane with `landLane(argv)`; every call is recorded.
 * @param {(argv: string[]) => { exit: number, out: string }} landLane the stand-in
 */
function fakeRun(landLane = () => ({ exit: 0, out: `${report(0, 'landed')}\n` })) {
  const calls = [];
  const run = (file, argv) => {
    calls.push({ file, argv });
    if (file === 'land-lane') return landLane(argv);
    if (file !== 'git') return { exit: 127, out: `no ${file} in this test` };
    const result = spawnSync('git', argv, { encoding: 'utf8', env: CLEAN_ENV });
    return { exit: result.status ?? KILLED_EXIT, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  };
  return { run, calls, landLaneCalls: () => calls.filter((call) => call.file === 'land-lane') };
}

const land = (f, flags, fake) => runRoad(['land', f.roadFile, ...flags], { run: fake.run, isUiPath: () => false });
const lastLine = (result) => result.out.trim().split('\n').at(-1);

test('a clean landing: join, then land-lane with the road values and the answer flags as given, then next; exit 0', async () => {
  const f = fixture();
  const fake = fakeRun();
  const result = await land(f, landFlags(f, ['--skip-review', 'docs only', '--brief', '/abs/brief.md']), fake);
  assert.equal(result.code, 0, result.out);
  const [call] = fake.landLaneCalls();
  assert.deepEqual(call.argv, ['--repo', f.repo, '--branch', 'lane/a', '--tip', f.tip, '--base', 'main', '--status-file', f.statusFile, '--close-row', 'tr.s1.a',
    '--worktree', f.worktree, '--skip-review', 'docs only', '--brief', '/abs/brief.md', '--json']);
  const parsed = parseArgs(call.argv); // land-lane's own parser accepts what road land passes
  assert.deepEqual([parsed.closeRow, parsed.skipReview, parsed.brief, parsed.json], ['tr.s1.a', 'docs only', '/abs/brief.md', true]);
  const lines = result.out.split('\n');
  assert.equal(JSON.parse(lines[0].replace(/^join: /, '')).joined, f.tip);
  assert.deepEqual(lines.slice(1, 3), ['land: landed', 'line of landed']);
  assert.match(lines[3], /^leftover: branch lane\/a still exists after the landing, at [0-9a-f]{40} .*fu\.prune-rebased-reflog$/);
  assert.equal(lines[4], 'next:');
  const next = JSON.parse(lines.slice(5, -1).join('\n'));
  assert.deepEqual([next.road, next.step, next.lanes], ['tr', 1, ['a']]);
  assert.equal(lastLine(result), 'road land: exit 0');
});

test('every land-lane exit passes through unchanged; next runs only after 0 or 1', async () => {
  const f = fixture();
  for (const code of LAND_LANE_EXITS) {
    const fake = fakeRun(() => ({ exit: code, out: `${report(code)}\n` }));
    const result = await land(f, landFlags(f), fake);
    assert.equal(result.code, code, `land-lane exit ${code}: ${result.out}`);
    assert.equal(result.out.includes('\nnext:\n'), code === 0 || code === 1, `next after exit ${code}`);
    assert.ok(result.out.includes(`land: state-${code}\nline of state-${code}`), result.out);
  }
});

test('a join refusal or finding stops before land-lane runs, with the join exit', async () => {
  const dirty = fixture();
  writeFileSync(join(dirty.worktree, 'README.md'), 'changed\n'); // uncommitted change to a tracked file: join refuses (1)
  const outside = fixture();
  const outsideTip = commitFiles(outside.worktree, { 'notes.txt': 'outside the lane\n' }); // a file outside src/: a finding (3)
  for (const [f, flags, code, pattern] of [[dirty, landFlags(dirty), 1, /uncommitted changes/], [outside, landFlags(outside, [], { tip: outsideTip }), 3, /outside the lane's files/]]) {
    const fake = fakeRun();
    const result = await land(f, flags, fake);
    assert.equal(result.code, code, result.out);
    assert.match(result.out, pattern);
    assert.equal(fake.landLaneCalls().length, 0, 'land-lane must not run after a join stop');
    assert.ok(!result.out.includes('next:'), result.out);
  }
});

test('a lane whose needed lane has not landed is refused by the needs check before land-lane', async () => {
  const f = fixture();
  const worktree = join(f.root, 'wt-b');
  git(f.repo, 'worktree', 'add', '-q', '-b', 'lane/b', worktree, f.baseSha);
  const tip = commitFiles(worktree, { 'other/b.txt': 'b\n' });
  const fake = fakeRun();
  const result = await land(f, landFlags(f, [], { lane: 'b', worktree, tip }), fake);
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /refused: lane b needs a landed on main first/);
  assert.equal(fake.landLaneCalls().length, 0);
});

test('a worktree HEAD other than --tip is refused: the join judged another commit than land-lane would land', async () => {
  const f = fixture();
  git(f.worktree, 'checkout', '-q', '--detach');
  commitFiles(f.worktree, { 'src/later.txt': 'later\n' }); // HEAD moves on, branch lane/a stays at --tip
  const fake = fakeRun();
  const result = await land(f, landFlags(f), fake);
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /refused: the join read HEAD [0-9a-f]{40} of .*, not --tip /);
  assert.equal(fake.landLaneCalls().length, 0);
});

test('F1: hostile or bad input and a road with two steps open are refused before any subprocess', async () => {
  const f = fixture();
  const twoOpen = fixture();
  writeFileSync(twoOpen.statusFile, statusText(twoOpen.baseSha, { 'tr.s2.check': { at: '2026-11-23T10:00Z', evidence: 'gate PASS' } }));
  const closed = fixture();
  writeFileSync(closed.statusFile, statusText(closed.baseSha, { 'tr.s1.check': { at: '2026-11-23T10:00Z', evidence: 'gate PASS' } }));
  const unread = fixture(); // a done check row the parser cannot read (no started) must not read as open
  writeFileSync(unread.statusFile, statusText(unread.baseSha).replace(/(\| tr\.s1\.check \|[^|]*\| S \|) - \| - \| - \|/, '$1 - | 2026-11-23T10:00Z | gate PASS |'));
  const cases = [
    [f, landFlags(f, [], { lane: '$(touch pwned)' }), 2], [f, landFlags(f, [], { lane: '--json' }), 2], [f, landFlags(f, [], { lane: 'zz' }), 1],
    [f, landFlags(f, [], { sha256: 'f'.repeat(64) }), 1], [f, landFlags(f, [], { tip: 'main' }), 2], [f, landFlags(f, [], { worktree: 'relative/wt' }), 2],
    [f, landFlags(f, ['--repo', '/elsewhere']), 2], [f, landFlags(f, ['--close-row', 'tr.s2.b']), 2], [f, landFlags(f, ['--owner-waive-ui', 'x']), 2],
    [f, landFlags(f, ['--budget', '6']), 2], [f, landFlags(f, ['--skip-review', '--json']), 2], [f, landFlags(f, ['--brief', '/a', '--brief', '/b']), 2],
    [f, landFlags(f).slice(0, -2), 2], [twoOpen, landFlags(twoOpen), 1], [closed, landFlags(closed), 1], [unread, landFlags(unread), 1],
  ];
  for (const [world, flags, code] of cases) {
    const fake = fakeRun();
    const result = await land(world, flags, fake);
    assert.equal(result.code, code, `${flags.join(' ')}: ${result.out}`);
    assert.deepEqual(fake.calls, [], `no subprocess for ${flags.join(' ')}`);
  }
  const twoOpenResult = await land(twoOpen, landFlags(twoOpen), fakeRun());
  assert.match(twoOpenResult.out, /two steps open: step 1's check row is open but step 2's is done/);
  assert.match((await land(closed, landFlags(closed), fakeRun())).out, /step 1's check row is done/);
  assert.match((await land(unread, landFlags(unread), fakeRun())).out, /is not fully understood \(line \d+: tr\.s1\.check: done without started/);
});

test('F2: a land-lane killed mid-way, or one whose report does not match its exit, is exit 14 with no next', async () => {
  const f = fixture();
  const answers = [{ exit: KILLED_EXIT, out: '' }, { exit: 1, out: 'TypeError: crashed before its report\n' }, { exit: 1, out: `${report(0)}\n` }];
  for (const answer of answers) {
    const result = await land(f, landFlags(f), fakeRun(() => answer));
    assert.equal(result.code, 14, result.out);
    assert.match(result.out, /land: land-lane did not finish .*run road\.mjs land again with the same --tip/);
    assert.ok(!result.out.includes('next:'), result.out);
  }
});

test('F2: the re-run after a landing skips the join and lets land-lane\'s restart path record or refuse', async () => {
  const gone = fixture();
  git(gone.repo, 'worktree', 'remove', '--force', gone.worktree);
  git(gone.repo, 'branch', '-D', 'lane/a'); // landed and pruned before the kill: the branch is gone
  const goneFake = fakeRun(() => ({ exit: 0, out: `${report(0, 'already landed')}\n` }));
  const goneResult = await land(gone, landFlags(gone), goneFake);
  assert.equal(goneResult.code, 0, goneResult.out);
  assert.match(goneResult.out, /^join: skipped: branch lane\/a is gone, not at --tip [0-9a-f]{40}: a re-run/);
  assert.equal(goneFake.landLaneCalls()[0].argv[5], gone.tip, 'land-lane gets the same --tip');
  assert.ok(!goneResult.out.includes('leftover:'), 'no leftover line when the branch is gone');
  assert.ok(goneResult.out.includes('\nnext:\n'));
  const moved = fixture();
  commitFiles(moved.worktree, { 'src/rebased.txt': 'r\n' }); // the branch is no longer at --tip (rebased, or new commits)
  const movedResult = await land(moved, landFlags(moved), fakeRun(() => ({ exit: 9, out: `${report(9, 'tip-moved')}\n` })));
  assert.equal(movedResult.code, 9, movedResult.out);
  assert.match(movedResult.out, /join: skipped: branch lane\/a is at [0-9a-f]{40}, not at --tip/);
});

test('--json prints one object: exit, join, land, leftover and next', async () => {
  const f = fixture();
  const result = await land(f, landFlags(f, ['--json', '--budget', '2']), fakeRun(() => ({ exit: 1, out: `${report(1, 'landed, check findings left')}\n` })));
  assert.equal(result.code, 1, result.out);
  const parsed = JSON.parse(result.out);
  assert.deepEqual([parsed.exit, parsed.join.joined, parsed.joinSkipped, parsed.land.state, parsed.next.exit], [1, f.tip, null, 'landed, check findings left', 0]);
  assert.equal(JSON.parse(parsed.next.out).writers, 1);
  assert.match(parsed.leftover, /^leftover: branch lane\/a still exists/);
});

test('the real CLI and land-lane: the lane lands on main, its row holds the landing, next shows the step at its gate', () => {
  const world = makeWorld();
  const folder = realpathSync(makeTempDir('road-land-cli-'));
  const baseSha = git(world.dir, 'rev-parse', 'HEAD');
  const { roadFile, sha256, statusFile } = writeRoad(folder, world.dir, baseSha);
  const worktree = join(realpathSync(makeTempDir('road-land-wt-')), 'wt-a');
  git(world.dir, 'worktree', 'add', '-q', '-b', 'lane/a', worktree, baseSha);
  const tip = commitFiles(worktree, { 'src/feature.txt': 'x\n' });
  const args = ['land', roadFile, '--road-sha256', sha256, '--lane', 'a', '--worktree', worktree, '--base', baseSha, '--tip', tip, '--skip-review', 'test lane'];
  const run = spawnSync(process.execPath, [ROAD_CLI, ...args], { cwd: world.dir, encoding: 'utf8', env: world.env });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(git(world.dir, 'rev-parse', 'main'), tip, 'main fast-forwarded to the joined tip');
  assert.match(run.stdout, /\nland: landed\n/);
  const row = readFileSync(statusFile, 'utf8').split('\n').find((line) => line.startsWith('| tr.s1.a '));
  assert.match(row, new RegExp(`landed ${tip} on main from ${baseSha}`));
  const next = JSON.parse(run.stdout.split('\nnext:\n')[1].split('\nroad land: exit')[0]);
  assert.deepEqual([next.step, next.state, next.early], [1, 'gate', ['b']]);
  // F2 with the real land-lane: the same call again (as after a kill once the landing was made) takes land-lane's restart path.
  const again = spawnSync(process.execPath, [ROAD_CLI, ...args], { cwd: world.dir, encoding: 'utf8', env: world.env });
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /^join: skipped: branch lane\/a is gone, not at --tip [0-9a-f]{40}: a re-run[^\n]*\nland: already landed\n/);
  assert.match(again.stdout, /\nrow tr\.s1\.a was already closed\n/);
  assert.equal(git(world.dir, 'rev-parse', 'main'), tip, 'nothing new landed');
});
