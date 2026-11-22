// Tests for home/tools/land-lane/land-lane.mjs: the one script that lands a reviewed lane (it replaced the land workflow). The real git-tidy,
// test-pass, disk-free, audit-log and status tools run on throw-away repos with a private HOME (tests/land-lane-helpers.mjs); the arguments,
// the pure helpers and the base-moved loop are in land-lane-units.test.mjs.
// Cases ported from tests/workflow-land.test.mjs, by name: a clean lane (clean lane lands); a landed lane with findings (findings left: exit 1);
//   a conflict (conflict); patches changed (needs-review); a red suite with the failing file and first error line (red suite); the suite reused
//   or run in the worktree (suite reuse / worktree); a base that moved (base-moved loop, in the units file); disk refusal (disk low: 3 GB, an
//   unreadable df); the tip check, an old branch of a re-done lane (tip moved, the branch is not at --tip); restart detection, the branch gone
//   or at the rebased tip (restart: branch gone / branch at the landed tip); audit not recorded (audit); `from` in the row (the row evidence).
// Failure classes (spec lane-land-lane): F1 two runs at once, F2 a crash before the row, F3 a hostile branch name; F4 is in the units file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addWorktree, commit, git, snapshot, withOrigin } from './git-tidy-helpers.mjs';
import { landArgs, laneAt, makeWorld, readRow } from './land-lane-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const SHA = '[0-9a-f]{40}';
const firstLineOf = (result) => result.stdout.split('\n')[0];
const branches = (dir) => git(dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').sort();
const landed = (world, name, tip, extra = [], env = {}) => world.run(landArgs(world, name, tip, extra), env);

test('clean lane lands: exit 0, `land: landed`, the landed line, a linear base, the lane gone, the row closed with from', () => {
  const world = makeWorld();
  const { tip } = laneAt(world, 'lane/x');
  const before = git(world.dir, 'rev-parse', 'main');
  const result = landed(world, 'lane/x', tip);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(firstLineOf(result), 'land: landed');
  const now = git(world.dir, 'rev-parse', 'main');
  assert.match(result.stdout, new RegExp(`landed ${now} on main from ${before}`));
  assert.equal(git(world.dir, 'rev-list', '--merges', '--count', 'main'), '0');
  assert.deepEqual(branches(world.dir), ['main']);
  assert.match(readRow(world), new RegExp(`landed ${now} on main from ${before}`), 'the row evidence names the sha and from');
  assert.match(result.stdout, /not checked: test is off/);
});

test('--json prints one object with the state, the exit and the landed sha', () => {
  const world = makeWorld();
  const { tip } = laneAt(world, 'lane/x');
  const result = landed(world, 'lane/x', tip, ['--json']);
  const object = JSON.parse(result.stdout);
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual([object.state, object.exit, object.to], ['landed', 0, git(world.dir, 'rev-parse', 'main')]);
});

test('findings left: a merge commit on the base is exit 1 with the finding printed, after the row is closed', () => {
  const world = makeWorld();
  const { tip } = laneAt(world, 'lane/x');
  git(world.dir, 'checkout', '-q', '-b', 'other');
  commit(world.dir, 'other.txt');
  git(world.dir, 'checkout', '-q', 'main');
  git(world.dir, 'merge', '-q', '--no-ff', '-m', 'a merge commit', 'other');
  git(world.dir, 'branch', '-D', 'other');
  const result = landed(world, 'lane/x', tip);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(firstLineOf(result), 'land: landed, check findings left');
  assert.match(result.stdout, /merge-commit/);
  assert.match(readRow(world), /landed [0-9a-f]{40} on main from/);
});

test('conflict: exit 3 names the file, the lane stays where it was, nothing lands and the row stays open', () => {
  const world = makeWorld();
  git(world.dir, 'checkout', '-q', '-b', 'lane/c');
  const tip = commit(world.dir, 'same.txt', 'lane version\n');
  git(world.dir, 'checkout', '-q', 'main');
  commit(world.dir, 'same.txt', 'main version\n');
  const result = landed(world, 'lane/c', tip);
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.equal(firstLineOf(result), 'land: conflict');
  assert.match(result.stdout, /conflict same\.txt/);
  assert.equal(git(world.dir, 'rev-parse', 'lane/c'), tip);
  assert.doesNotMatch(readRow(world), /landed/);
});

test('needs-review: a rebase that changes patches is exit 10 with `review` on and lands with it off', () => {
  const world = makeWorld();
  commit(world.dir, 'f.txt', 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n');
  git(world.dir, 'checkout', '-q', '-b', 'lane/p');
  const tip = commit(world.dir, 'f.txt', 'l1\nl2\nl3\nl4\nLANE\nl6\nl7\nl8\nl9\n');
  git(world.dir, 'checkout', '-q', 'main');
  commit(world.dir, 'f.txt', 'l1\nl2\nMAIN\nl4\nl5\nl6\nl7\nl8\nl9\n');
  const result = landed(world, 'lane/p', tip, ['--checks', 'review']);
  assert.equal(result.status, 10, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`rebased ${SHA}: review the delta \\(review-tier --delta ${tip} --base ${git(world.dir, 'rev-parse', 'main')}\\)`));
  assert.notEqual(git(world.dir, 'rev-parse', 'lane/p'), tip, 'the lane was rebased');
  assert.doesNotMatch(readRow(world), /landed/);
  const reviewedAgain = git(world.dir, 'rev-parse', 'lane/p');
  const again = landed(world, 'lane/p', reviewedAgain);
  // exit 1, not 0: the replaced pre-rebase commit has a patch the base lacks and lives only in the reflog, so prune keeps the lane branch (git-tidy's rule)
  assert.equal(again.status, 1, `with review off the rebased lane lands: ${again.stdout}`);
  assert.match(again.stdout, /landed [0-9a-f]{40} on main from/);
  assert.match(again.stdout, /merged-branch lane\/p/);
});

test('tip moved: a branch that is not at --tip exits 9 and nothing changes (the old branch of a re-done lane)', () => {
  const world = makeWorld();
  const { tip } = laneAt(world, 'lane/x');
  git(world.dir, 'checkout', '-q', 'lane/x');
  commit(world.dir, 'after-review.txt');
  git(world.dir, 'checkout', '-q', 'main');
  const before = snapshot(world.dir);
  const result = landed(world, 'lane/x', tip);
  assert.equal(result.status, 9, result.stdout + result.stderr);
  assert.equal(firstLineOf(result), 'land: tip-moved');
  assert.match(result.stdout, new RegExp(`branch lane/x is at ${SHA}, not at the reviewed ${tip}`));
  assert.equal(snapshot(world.dir), before);
  assert.doesNotMatch(readRow(world), /landed/);
});

test('disk low: below the floor, or a df text that cannot be read, is exit 11 before any git step', () => {
  for (const [label, world, env] of [['3 GB', makeWorld({ freeGb: 3 }), {}], ['unreadable', makeWorld(), { DISK_FREE_DF_OUTPUT: 'garbage' }]]) {
    const { tip } = laneAt(world, 'lane/x');
    const before = snapshot(world.dir);
    const result = landed(world, 'lane/x', tip, [], env);
    assert.equal(result.status, 11, `${label}: ${result.stdout}${result.stderr}`);
    assert.equal(firstLineOf(result), 'land: disk-low');
    assert.match(result.stdout, /nothing was landed/);
    assert.equal(snapshot(world.dir), before);
  }
});

test('a repo folder that cannot be used is exit 14 (a tool that cannot run is never a pass)', () => {
  const world = makeWorld();
  const { tip } = laneAt(world, 'lane/x');
  const missing = join(makeTempDir('land-lane-none-'), 'no-such-repo');
  const result = world.run(landArgs({ ...world, dir: missing }, 'lane/x', tip));
  assert.equal(result.status, 14, result.stdout + result.stderr);
  assert.equal(firstLineOf(result), 'land: tool-failed');
});

// suite ------------------------------------------------------------------------------------------------------------------------------

test('suite: with `test` on the suite runs in a temporary worktree that is gone afterwards, and the PASS is recorded for the rebased tip', () => {
  const world = makeWorld();
  const { tip } = laneAt(world, 'lane/x');
  const result = landed(world, 'lane/x', tip, ['--checks', 'test,review']); // patches are unchanged by this rebase, so `review` on does not stop it
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /suite PASS recorded at [0-9a-f]{40}/);
  assert.equal(git(world.dir, 'worktree', 'list').split('\n').length, 1, 'no temporary worktree is left');
});

test('suite: an exit 0 that leaves no recorded PASS (an unusable state folder) is exit 4, never a landing', () => {
  const world = makeWorld();
  const { tip } = laneAt(world, 'lane/x');
  const brokenHome = makeTempDir('land-lane-broken-home-');
  writeFileSync(join(brokenHome, '.claude'), 'a file where the state folder should be');
  const before = git(world.dir, 'rev-parse', 'main');
  const result = landed(world, 'lane/x', tip, ['--checks', 'test'], { HOME: brokenHome, USERPROFILE: brokenHome });
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.match(result.stdout, /exited 0 at [0-9a-f]{40} but no PASS is recorded/);
  assert.equal(git(world.dir, 'rev-parse', 'main'), before);
});

test('a GIT_DIR in the caller\'s environment does not redirect the tools it starts', () => {
  const world = makeWorld();
  const { tip } = laneAt(world, 'lane/x');
  const result = landed(world, 'lane/x', tip, ['--checks', 'test'], { GIT_DIR: join(world.home, 'not-a-repo'), GIT_WORK_TREE: world.home });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('suite reuse: a PASS already recorded for the tree is not run again', () => {
  const world = makeWorld({ suite: 'node -e "process.exit(process.env.LL_FAIL ? 1 : 0)"' });
  const { tip } = laneAt(world, 'lane/x');
  git(world.dir, 'checkout', '-q', 'lane/x');
  git(world.dir, 'rebase', '-q', 'main');
  const rebased = git(world.dir, 'rev-parse', 'HEAD');
  const preRun = world.runTestPass(['run', '--suite', '--repo', world.dir]);
  assert.equal(preRun.status, 0, preRun.stdout + preRun.stderr);
  git(world.dir, 'checkout', '-q', 'main');
  const result = landed(world, 'lane/x', rebased, ['--checks', 'test'], { LL_FAIL: '1' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /suite PASS already recorded/);
  assert.notEqual(tip, rebased);
});

test('worktree: the suite runs in --worktree when its HEAD is the rebased tip and it is clean, else in a temporary worktree', () => {
  for (const kind of ['clean', 'dirty', 'other commit']) {
    const dirty = kind === 'dirty';
    const marker = join(makeTempDir('land-lane-marker-'), 'cwd.txt');
    const world = makeWorld({ suite: 'node -e "require(\'fs\').writeFileSync(process.env.LL_MARKER, process.cwd())"' });
    const { tip } = laneAt(world, 'lane/x');
    const laneWorktree = addWorktree(world.dir, 'wt-x', 'lane/x', { create: false });
    if (dirty) writeFileSync(join(laneWorktree, 'scratch.txt'), 'untracked');
    const worktree = kind === 'other commit' ? addWorktree(world.dir, 'wt-other', 'lane/other') : laneWorktree; // a clean folder whose HEAD is not the rebased tip
    const result = landed(world, 'lane/x', tip, ['--checks', 'test', '--worktree', worktree], { LL_MARKER: marker });
    assert.equal(result.status, kind === 'clean' ? 0 : 1, result.stdout + result.stderr); // a kept worktree (untracked file, or the other lane's) stays a check finding
    const ranIn = readFileSync(marker, 'utf8'); // the folders are gone after the landing, so the text is compared, not resolved
    if (kind === 'clean') assert.equal(ranIn, worktree, 'a clean worktree at the rebased tip is used');
    else assert.notEqual(ranIn, worktree, `${kind}: the given worktree is not used`);
  }
});

test('red suite: exit 4 names each failing file with its first error line and the log path; nothing lands and the temporary worktree is gone', () => {
  const world = makeWorld({ suite: 'node --test tests/*.test.mjs' });
  git(world.dir, 'checkout', '-q', '-b', 'lane/r');
  mkdirSync(join(world.dir, 'tests'));
  commit(world.dir, 'tests/a.test.mjs', "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('parses', () => assert.equal(3, 2));\n");
  const tip = git(world.dir, 'rev-parse', 'HEAD');
  git(world.dir, 'checkout', '-q', 'main');
  commit(world.dir, 'moved.txt');
  const mainBefore = git(world.dir, 'rev-parse', 'main');
  const result = landed(world, 'lane/r', tip, ['--checks', 'test']);
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.equal(firstLineOf(result), 'land: red');
  assert.match(result.stdout, /tests\/a\.test\.mjs: parses: .*Expected values to be strictly equal/);
  const logPath = /log: (\S+)/.exec(result.stdout)?.[1];
  assert.ok(logPath && existsSync(logPath), 'the log path is printed and the log exists');
  assert.equal(git(world.dir, 'rev-parse', 'main'), mainBefore);
  assert.equal(git(world.dir, 'worktree', 'list').split('\n').length, 1);
  assert.doesNotMatch(readRow(world), /landed/);
});

// the refusals git-tidy makes -----------------------------------------------------------------------------------------------------------

test('new-file-size: a 5 MB file the brief does not name is exit 7; a brief that names it lets the lane land', () => {
  const world = makeWorld();
  git(world.dir, 'checkout', '-q', '-b', 'lane/big');
  const tip = commit(world.dir, 'big.bin', 'x'.repeat(5 * 1024 * 1024 + 1));
  git(world.dir, 'checkout', '-q', 'main');
  const refused = landed(world, 'lane/big', tip);
  assert.equal(refused.status, 7, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /file big\.bin/);
  const brief = join(makeTempDir('land-lane-brief-'), 'brief.md');
  writeFileSync(brief, 'The lane adds big.bin on purpose.\n');
  assert.equal(landed(world, 'lane/big', tip, ['--brief', brief]).status, 0);
});

test('ui-proof: with `ui` on, a changed UI file with no visual-qa PASS is exit 6 and nothing lands', () => {
  const world = makeWorld();
  git(world.dir, 'checkout', '-q', '-b', 'lane/ui');
  const tip = commit(world.dir, 'page.css', 'body { color: red; }\n');
  git(world.dir, 'checkout', '-q', 'main');
  const result = landed(world, 'lane/ui', tip, ['--checks', 'ui']);
  assert.equal(result.status, 6, result.stdout + result.stderr);
  assert.equal(firstLineOf(result), 'land: ui-proof');
  assert.ok(branches(world.dir).includes('lane/ui'));
});

test('upstream-moved: commits on the base\'s upstream that the base lacks are exit 8', () => {
  const world = makeWorld();
  const origin = withOrigin(world.dir);
  const other = join(realpathSync(makeTempDir('land-lane-clone-')), 'clone');
  git(world.dir, 'clone', '-q', '-b', 'main', origin, other);
  git(other, 'config', 'user.name', 't');
  git(other, 'config', 'user.email', 't@t');
  commit(other, 'elsewhere.txt');
  git(other, 'push', '-q', 'origin', 'main');
  const { tip } = laneAt(world, 'lane/x');
  const result = landed(world, 'lane/x', tip);
  assert.equal(result.status, 8, result.stdout + result.stderr);
  assert.equal(firstLineOf(result), 'land: upstream-moved');
});

// after the landing: audit, row, restart -------------------------------------------------------------------------------------------------

test('audit: --audit-base records a pending audit for the landed sha before the row is closed', () => {
  const world = makeWorld();
  const auditBase = git(world.dir, 'rev-parse', 'main');
  const { tip } = laneAt(world, 'lane/x');
  const result = landed(world, 'lane/x', tip, ['--audit-base', auditBase]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const record = JSON.parse(readFileSync(world.auditLog, 'utf8').trim().split('\n').at(-1));
  assert.equal(record.state, 'pending');
  assert.equal(record.tip, git(world.dir, 'rev-parse', 'main'));
});

test('audit: a record that fails is exit 12 "audit not recorded: gate holds nothing", the lane is landed and the row is closed', () => {
  const world = makeWorld();
  const auditBase = git(world.dir, 'rev-parse', 'main');
  const { tip } = laneAt(world, 'lane/x');
  const result = landed(world, 'lane/x', tip, ['--audit-base', auditBase], { REVIEW_AUDIT_LOG: join(world.statusFile, 'no', 'audit.jsonl') });
  assert.equal(result.status, 12, result.stdout + result.stderr);
  assert.equal(firstLineOf(result), 'land: audit-not-recorded');
  assert.match(result.stdout, /audit not recorded: gate holds nothing/);
  assert.match(readRow(world), /landed [0-9a-f]{40} on main from/);
  assert.deepEqual(branches(world.dir), ['main']);
});

test('row not closed: a status file that cannot be written is exit 13 after the landing, with the evidence to type by hand', () => {
  const world = makeWorld();
  const { tip } = laneAt(world, 'lane/x');
  const result = landed({ ...world, statusFile: join(world.home, 'no-such-folder', 'STATUS.md') }, 'lane/x', tip);
  assert.equal(result.status, 13, result.stdout + result.stderr);
  assert.equal(firstLineOf(result), 'land: row-not-closed');
  assert.match(result.stdout, /row close:1 not closed: .*; close it by hand with: landed [0-9a-f]{40} on main from/);
  assert.equal(git(world.dir, 'rev-list', '--merges', '--count', 'main'), '0');
  assert.deepEqual(branches(world.dir), ['main'], 'the lane did land');
});

/** What a run killed after the fast-forward leaves: the lane rebased and merged by hand; `deleteBranch` is a kill after the prune. */
function landByHand(world, name, { deleteBranch }) {
  git(world.dir, 'checkout', '-q', name);
  git(world.dir, 'rebase', '-q', 'main');
  git(world.dir, 'checkout', '-q', 'main');
  git(world.dir, 'merge', '-q', '--ff-only', name);
  if (deleteBranch) git(world.dir, 'branch', '-D', name);
}

test('restart: branch gone (killed after the land, before the row): the landing is found, the row is closed once, a re-run is clean (F2)', () => {
  const world = makeWorld();
  const auditBase = git(world.dir, 'rev-parse', 'main');
  const { tip } = laneAt(world, 'lane/x');
  const before = git(world.dir, 'rev-parse', 'main');
  landByHand(world, 'lane/x', { deleteBranch: true });
  const now = git(world.dir, 'rev-parse', 'main');
  const result = landed(world, 'lane/x', tip, ['--audit-base', auditBase]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(firstLineOf(result), 'land: already landed');
  assert.match(readRow(world), new RegExp(`landed ${now} on main from ${before} \\(found already on main after a restart\\)`));
  assert.equal(git(world.dir, 'rev-parse', 'main'), now, 'the base did not move');
  const again = landed(world, 'lane/x', tip);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /row close:1 was already closed/);
  assert.equal(readFileSync(world.statusFile, 'utf8').match(/landed [0-9a-f]{40}/g).length, 1, 'the row holds one landing');
});

test('restart: the branch gone and a patch missing on the base is exit 14, nothing recorded', () => {
  const world = makeWorld();
  const { tip } = laneAt(world, 'lane/x');
  git(world.dir, 'branch', '-D', 'lane/x');
  const result = landed(world, 'lane/x', tip);
  assert.equal(result.status, 14, result.stdout + result.stderr);
  assert.match(result.stdout, /lane\/x not found .* lacks patches/);
  assert.doesNotMatch(readRow(world), /landed/);
});

test('restart: branch at the landed tip (killed between the fast-forward and the prune): found, row closed, leftovers pruned', () => {
  const world = makeWorld();
  const { tip } = laneAt(world, 'lane/x');
  landByHand(world, 'lane/x', { deleteBranch: false });
  const result = landed(world, 'lane/x', tip);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(firstLineOf(result), 'land: already landed');
  assert.match(readRow(world), /landed [0-9a-f]{40} on main from [0-9a-f]{40} \(found already on main after a restart\)/);
  assert.deepEqual(branches(world.dir), ['main'], 'the leftover branch is pruned');
});

// failure classes -----------------------------------------------------------------------------------------------------------------------

test('F1 two runs at once: two lanes landed together never lose a commit or make a merge; each exit is a landing or a clean refusal', async () => {
  const world = makeWorld();
  const a = laneAt(world, 'lane/a', 'a.txt');
  const b = laneAt(world, 'lane/b', 'b.txt');
  const [first, second] = await Promise.all([world.runAsync(landArgs(world, 'lane/a', a.tip)), world.runAsync(landArgs(world, 'lane/b', b.tip, [], 'close:2'))]);
  const onMain = git(world.dir, 'ls-tree', '-r', '--name-only', 'main').split('\n');
  assert.equal(git(world.dir, 'rev-list', '--merges', '--count', 'main'), '0');
  for (const [result, file] of [[first, 'a.txt'], [second, 'b.txt']]) {
    assert.ok([0, 1, 5, 9, 12, 13, 14].includes(result.status), `${file}: exit ${result.status}\n${result.stdout}`);
    if (result.status === 0) assert.ok(onMain.includes(file), `${file} reported landed and is on main`);
  }
  assert.ok([first.status, second.status].some((status) => status === 0 || status === 1), `one of them lands: ${first.stdout}${second.stdout}`);
});

test('F3 hostile names: a branch named like an option or a shell line is exit 2 and nothing runs', () => {
  const world = makeWorld();
  const { tip } = laneAt(world, 'lane/x');
  const sentinel = join(world.home, 'ran');
  const before = snapshot(world.dir);
  for (const name of ['--help', '-x', `a;touch ${sentinel}`, `$(touch ${sentinel})`, 'a b', '..', 'a..b', 'a`touch x`', 'x'.repeat(101), '']) {
    const result = world.run(landArgs(world, name, tip));
    assert.equal(result.status, 2, `${JSON.stringify(name)}: ${result.stdout}${result.stderr}`);
    assert.equal(firstLineOf(result), 'land: usage');
  }
  assert.equal(existsSync(sentinel), false, 'no shell line ran');
  assert.equal(snapshot(world.dir), before);
  assert.doesNotMatch(readRow(world), /landed/);
});
