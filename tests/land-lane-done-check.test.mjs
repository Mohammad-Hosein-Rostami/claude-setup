// Acceptance tests for the done-check step of `land-lane` (design.md section 8: A9 and A10, plus the lane's F1 and F2 probes).
// They are red until the land step is wired (road newchk step 6, lane dc-land-step): today land-lane runs no check, takes no `--reviewed`,
// `--skip-review` or `--accept-open`, and prints no `checks:` line. Only the "branch moved after --tip" case is green today (it keeps working).
// Conventions the tests rely on, all from the spec: after the rebase land-lane runs `done-check run --where land` on the lane's worktree
//   (`--worktree <abs>`) against the rebased base, or reuses a green ledger row with the same change key (no command runs), and prints the
//   `checks:` line of the run (`checks: reused (same change) ok`, `checks: types FAIL 1 new`). New failures or an open weakened item are exit 4
//   (`--accept-open <text>` accepts the weakened item); a lane that touches a risk class (src/auth/ is `security`) is exit 10 unless
//   `--reviewed <sha>` (the --tip or an ancestor of it) or `--skip-review <1-200 chars>` is given; a bad value of either is exit 2. A refused
//   landing changes nothing: the base stays, the lane stays, the STATUS row stays open. A landing is still `git merge --ff-only` of exactly --tip.
// The project, its fake tsc and its private HOME come from done-check-fixture.mjs; the real git-tidy, disk-free and status tools run on it.
// A stop record is made by `done-check run --where manual` in the lane's worktree (it writes the same ledger row the stop hook writes).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDoneCheckRepo } from './done-check-fixture.mjs';
import { addWorktree, commit, git, snapshot } from './git-tidy-helpers.mjs';
import { LAND_LANE, landArgs, readRow } from './land-lane-helpers.mjs';

const DONE_CHECK = fileURLToPath(new URL('../home/tools/done-check/done-check.mjs', import.meta.url));
const PACKAGE = { name: 'p', private: true, scripts: { typecheck: 'tsc --noEmit', test: 'node --test tests/*.test.mjs' } };
const SOURCES = { 'src/lib.ts': 'export const n: number = 1;\n', 'src/use.ts': "import { n } from './lib';\nexport const s = String(n);\nexport const t: number = n;\n", 'tsconfig.json': '{"compilerOptions":{"strict":true}}\n' };
const TSC_CLEAN = { exit: 0 };
const TSC_BROKEN_CALLER = { exit: 2, stdout: "src/use.ts(3,25): error TS2322: Type 'string' is not assignable to type 'number'.\n" };
const KB_PER_GB = 1024 * 1024;
const DISK_ENV = {
  DISK_FREE_DF_OUTPUT: `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 976490576 900000000 ${80 * KB_PER_GB} 99% /System/Volumes/Data\n`,
};
const STATUS_TEXT = `# STATUS

## Work items

| id | item | size | started | done | evidence |
| -- | ---- | ---- | ------- | ---- | -------- |
| close:1 | land the lane | S | 2026-11-22T10:00Z | - | - |
| close:2 | land the second lane | S | 2026-11-22T10:00Z | - | - |
| close:3 | land the third lane | S | 2026-11-22T10:00Z | - | - |
`;
const MAX_REASON_CHARS = 200;
const AUTH_FILE = { 'src/auth/login.ts': 'export const login = 1;\n' };

/** A project with the fake tsc (clean unless `replay` says otherwise), a STATUS.md, and the df text land-lane's disk check reads. */
function makeWorld(t, replay = TSC_CLEAN) {
  const repo = makeDoneCheckRepo({ packageJson: PACKAGE, files: SOURCES, tools: ['tsc'], replay: { tsc: replay } });
  t.after(repo.cleanup);
  const statusFolder = join(dirname(repo.dir), 'my status'); // a space in a path must reach status.mjs whole
  mkdirSync(statusFolder);
  const statusFile = join(statusFolder, 'STATUS.md');
  writeFileSync(statusFile, STATUS_TEXT);
  return { repo, dir: repo.dir, statusFile, base: repo.baseSha };
}

const commitAll = (dir, message) => {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
};

/** A lane `lane/<slug>` in its own worktree (with its own fake tsc), one commit per entry of `commits` (each a map of file to text). */
function makeLane(world, slug, commits) {
  const dir = addWorktree(world.dir, `lane-${slug}`, `lane/${slug}`);
  world.repo.installTools(['tsc'], dir);
  const shas = commits.map((files, index) => {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), text);
    }
    return commitAll(dir, `${slug} ${index}`);
  });
  return { branch: `lane/${slug}`, dir, tip: shas.at(-1), shas };
}

/** The base moves on by one commit that touches no code. */
const moveBase = (world, name = 'moved.txt') => commit(world.dir, name);

/** What a stop of the lane's agent leaves in the ledger: a manual run in the lane's worktree against the base the lane started from. */
function recordStopRun(world, lane, base = world.base) {
  const result = world.repo.run(DONE_CHECK, ['run', '--worktree', lane.dir, '--base', base, '--where', 'manual', '--json']);
  assert.equal(result.status, 0, `the stop record must be green: ${result.stdout}${result.stderr}`);
  world.repo.clearCalls();
}

/** Runs land-lane for `lane` (its worktree passed) and returns the spawn result. */
function landLane(world, lane, extra = [], row = 'close:1') {
  return world.repo.run(LAND_LANE, landArgs(world, lane.branch, lane.tip, ['--worktree', lane.dir, ...extra], row), { env: DISK_ENV });
}

const ledgerRows = (world) => readFileSync(join(world.repo.home, '.claude', 'state', 'done-check', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const mainTip = (world) => git(world.dir, 'rev-parse', 'main');
const hasBranch = (world, branch) => git(world.dir, 'branch', '--list', branch) !== '';

/** Nothing landed: the base and every ref are as before, the row is still open. */
function assertNothingLanded(world, before, label) {
  assert.equal(snapshot(world.dir), before, `${label}: refs changed`);
  assert.doesNotMatch(readRow(world), /landed/, `${label}: the row was closed`);
}

/** Landed exactly `tip`: the base is at it by fast-forward (no merge commit), the lane is pruned, the row names it. */
function assertLandedAt(world, tip, result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(mainTip(world), tip, 'the base must be at exactly the checked tip');
  assert.equal(git(world.dir, 'rev-list', '--merges', '--count', 'main'), '0');
  assert.match(readRow(world), new RegExp(`landed ${tip} on main`));
}

// A9: reuse and re-run --------------------------------------------------------------------------------------------------------------------

test('an unmoved base reuses the green stop record: no check command runs, the reused line is printed, exactly the tip lands', (t) => {
  const world = makeWorld(t);
  const lane = makeLane(world, 'a', [{ 'src/lib.ts': 'export const n: number = 2;\n' }]);
  recordStopRun(world, lane);
  const result = landLane(world, lane);
  assertLandedAt(world, lane.tip, result);
  assert.match(result.stdout, /checks: reused \(same change\) ok/);
  assert.deepEqual(world.repo.calls(), [], 'a reused record runs no tool');
  assert.equal(hasBranch(world, lane.branch), false);
});

test('a moved base does not reuse the old record: the check runs again on the rebased tip and the rebased tip lands', (t) => {
  const world = makeWorld(t);
  const lane = makeLane(world, 'a', [{ 'src/lib.ts': 'export const n: number = 2;\n' }]);
  recordStopRun(world, lane);
  moveBase(world);
  const result = landLane(world, lane);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /reused/);
  assert.match(result.stdout, /checks: .*types ok/);
  assert.ok(world.repo.calls('tsc').length > 0, 'the type check ran at the new base');
  assert.notEqual(mainTip(world), lane.tip, 'the lane was rebased onto the moved base');
  assertLandedAt(world, mainTip(world), result);
});

test('a new type failure after the base moved is exit 4: the failure is printed and nothing lands', (t) => {
  const world = makeWorld(t);
  const lane = makeLane(world, 'bad', [{ 'src/lib.ts': "export const n: string = '1';\n", 'fake-tools.json': `${JSON.stringify({ tsc: TSC_BROKEN_CALLER })}\n` }]);
  const movedBase = moveBase(world);
  const result = landLane(world, lane);
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.match(result.stdout, /checks: .*types FAIL 1 new/);
  assert.equal(hasBranch(world, lane.branch), true, 'the lane stays for its fix');
  assert.equal(mainTip(world), movedBase, 'the base is where it was');
  assert.doesNotMatch(readRow(world), /landed/);
});

test('a failure the base already has is not new: the lane lands and the line counts the old failure', (t) => {
  const world = makeWorld(t, TSC_BROKEN_CALLER);
  const lane = makeLane(world, 'a', [{ 'src/note.ts': 'export const note = 1;\n' }]);
  const result = landLane(world, lane);
  assertLandedAt(world, lane.tip, result);
  assert.match(result.stdout, /1 old fail/);
});

test('an edited test script is an open weakened item: exit 4, and --accept-open with a reason lands it', (t) => {
  const world = makeWorld(t);
  const weakened = { ...PACKAGE, scripts: { ...PACKAGE.scripts, test: 'echo skipped' } };
  const lane = makeLane(world, 'weak', [{ 'package.json': `${JSON.stringify(weakened, null, 2)}\n`, 'src/note.ts': 'export const note = 1;\n' }]);
  const before = snapshot(world.dir);
  const refused = landLane(world, lane);
  assert.equal(refused.status, 4, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /tests-weakened FAIL/);
  assertNothingLanded(world, before, 'weakened lane');
  const accepted = landLane(world, lane, ['--accept-open', 'the script moves to the new runner in the next lane']);
  assertLandedAt(world, lane.tip, accepted);
});

test('the base moves twice: every land after a move runs the check once for its own new base, only the unmoved one reuses', (t) => {
  const world = makeWorld(t);
  const lanes = ['a', 'b', 'c'].map((slug) => makeLane(world, slug, [{ [`src/${slug}.ts`]: `export const ${slug} = 1;\n` }]));
  for (const lane of lanes) recordStopRun(world, lane);
  const callsAfter = lanes.map((lane, index) => {
    const result = landLane(world, lane, [], `close:${index + 1}`);
    assert.equal(result.status, 0, `lane ${lane.branch}: ${result.stdout}${result.stderr}`);
    const calls = world.repo.calls('tsc').length;
    world.repo.clearCalls();
    return calls;
  });
  assert.equal(callsAfter[0], 0, 'the first lane found its own base unmoved');
  assert.ok(callsAfter[1] > 0 && callsAfter[2] > 0, `lanes after a base move must re-check: ${callsAfter}`);
  const landRows = ledgerRows(world).filter((row) => row.where === 'land');
  assert.deepEqual(landRows.map((row) => row.verdict), ['reused', 'ok', 'ok']);
  assert.equal(new Set(landRows.map((row) => row.key)).size, 3, 'each new base has its own change key');
  assert.equal(git(world.dir, 'rev-list', '--merges', '--count', 'main'), '0');
});

test('a branch that moved after --tip is exit 9 before any check runs, and nothing changes', (t) => {
  const world = makeWorld(t);
  const lane = makeLane(world, 'a', [{ 'src/lib.ts': 'export const n: number = 2;\n' }]);
  commit(lane.dir, 'after-review.txt');
  const before = snapshot(world.dir);
  const result = landLane(world, lane);
  assert.equal(result.status, 9, result.stdout + result.stderr);
  assertNothingLanded(world, before, 'moved tip');
  assert.deepEqual(world.repo.calls(), [], 'no tool ran on a lane that is not at the reviewed tip');
});

// A10: risk review ------------------------------------------------------------------------------------------------------------------------

test('a lane that touches src/auth/ is exit 10 without a review answer: the class is named and nothing lands', (t) => {
  const world = makeWorld(t);
  const lane = makeLane(world, 'auth', [AUTH_FILE]);
  const before = snapshot(world.dir);
  const result = landLane(world, lane);
  assert.equal(result.status, 10, result.stdout + result.stderr);
  assert.match(result.stdout, /review: .*security/);
  assertNothingLanded(world, before, 'unreviewed risky lane');
});

test('a risky lane lands with --reviewed at the tip, --reviewed at an ancestor of it, or --skip-review with a reason', (t) => {
  const answers = [
    ['--reviewed at the tip', (lane) => ['--reviewed', lane.tip]],
    ['--reviewed at an ancestor of the tip', (lane) => ['--reviewed', lane.shas[0]]],
    ['--skip-review with a reason', () => ['--skip-review', 'owner read the diff']],
  ];
  for (const [label, answer] of answers) {
    const world = makeWorld(t);
    const lane = makeLane(world, 'auth', [AUTH_FILE, { 'src/note.ts': 'export const note = 1;\n' }]);
    const result = landLane(world, lane, answer(lane));
    assert.equal(result.status, 0, `${label}: ${result.stdout}${result.stderr}`);
    assertLandedAt(world, lane.tip, result);
  }
});

test('--reviewed that is not the tip or an ancestor of it (another branch, an unknown sha, not a sha) is exit 2; an ancestor then lands', (t) => {
  const world = makeWorld(t);
  const lane = makeLane(world, 'auth', [AUTH_FILE, { 'src/note.ts': 'export const note = 1;\n' }]);
  git(world.dir, 'checkout', '-q', '-b', 'side');
  const sideSha = commit(world.dir, 'side.txt');
  git(world.dir, 'checkout', '-q', 'main');
  const before = snapshot(world.dir);
  for (const value of [sideSha, '1'.repeat(40), 'abc']) {
    const result = landLane(world, lane, ['--reviewed', value]);
    assert.equal(result.status, 2, `--reviewed ${value}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /reviewed/);
    assert.equal(snapshot(world.dir), before, `--reviewed ${value}: refs changed`);
  }
  assertLandedAt(world, lane.tip, landLane(world, lane, ['--reviewed', lane.shas[0]]));
});

test('--skip-review needs a reason of 1 to 200 characters: empty and 201 are exit 2, 200 lands', (t) => {
  const world = makeWorld(t);
  const lane = makeLane(world, 'auth', [AUTH_FILE]);
  const before = snapshot(world.dir);
  for (const reason of ['', 'x'.repeat(MAX_REASON_CHARS + 1)]) {
    const result = landLane(world, lane, ['--skip-review', reason]);
    assert.equal(result.status, 2, `${reason.length} characters: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /skip-review/);
    assert.equal(snapshot(world.dir), before, `${reason.length} characters: refs changed`);
  }
  assertLandedAt(world, lane.tip, landLane(world, lane, ['--skip-review', 'x'.repeat(MAX_REASON_CHARS)]));
});
