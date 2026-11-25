// Tests that a failed git read or setup step in the e2e scenarios is a FAIL, never "unchanged" (review round 2, R5): gitOut's
// failure text, the read comparers in tests/e2e/lib/common.mjs, makeLibrary's setup steps, and the check lines of E1, E5, E6,
// E7 and E11 on reads that failed, each next to its twin whose reads work and pass.
// Why: two failed reads used to give '' twice, and '' === '' read as "the origin is unchanged" or "main unmoved".
// No real `claude` runs: the scenario contexts are plain objects with a fake git; transcripts come from tests/e2e-fixtures.mjs.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { call, result, writeSession } from './e2e-fixtures.mjs';
import { GIT_FAILED, gitOut, readFailed, readText, sameRead } from './e2e/lib/common.mjs';
import { leakSnapshot } from './e2e/lib/leaks.mjs';
import { makeLibrary } from './e2e/lib/repo.mjs';
import * as E1 from './e2e/scenarios/E1.mjs';
import * as E5 from './e2e/scenarios/E5.mjs';
import * as E6 from './e2e/scenarios/E6.mjs';
import * as E7 from './e2e/scenarios/E7.mjs';
import * as E11 from './e2e/scenarios/E11.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const REFS = 'aaaa111 refs/heads/main';
const MAIN_BEFORE = 'a'.repeat(40);
const MAIN_AFTER = 'b'.repeat(40);
const GIT_ERROR = { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
const ok = (stdout) => ({ code: 0, stdout, stderr: '' });
const failingGit = () => GIT_ERROR;
const byName = (lines) => Object.fromEntries(lines.map((line) => [line.check, line]));

test('gitOut names a failed command; readFailed, sameRead and readText never call two failed reads the same', () => {
  const failed = gitOut({ repo: '/r', git: failingGit }, ['show-ref']);
  assert.ok(failed.startsWith(GIT_FAILED) && failed.includes('git show-ref') && failed.includes('exit 128'), failed);
  assert.equal(gitOut({ repo: '/r', git: () => ok(`${REFS}\n`) }, ['show-ref']), REFS);
  assert.equal(readFailed(failed), true);
  assert.equal(readFailed(undefined), true, 'a read that never happened is failed too');
  assert.equal(readFailed(''), false, 'an empty output of a git that worked is a real read');
  assert.equal(sameRead(failed, failed), false);
  assert.equal(sameRead(REFS, REFS), true);
  assert.equal(readText(failed, REFS), failed);
  assert.equal(readText(REFS, REFS), 'unchanged');
  assert.equal(readText(REFS, `${REFS}x`), 'changed');
});

test('makeLibrary: a git setup step that fails throws naming it (no scenario runs on a repo that is not there)', () => {
  const dir = makeTempDir('harness-reads-lib-');
  const ctx = { dir, repo: join(dir, 'repo'), origin: join(dir, 'origin.git'), mkdir() {}, write() {}, git: failingGit };
  assert.throws(() => makeLibrary(ctx), /setup step failed: git init .*exit 128.*not a git repository/);
});

const E1_LINE = 'main was moved by land, in a straight line, the lane cleaned up';

function e1Line(git) {
  const projects = join(makeTempDir('harness-reads-e1-'), 'projects');
  const land = [call('l1', 'Bash', { command: 'node ~/.claude/tools/land/land.mjs lane/x' }, 1), result('l1', 'landed lane/x on main', { seconds: 2 })];
  writeSession(projects, '/w/E1/repo', { sessionId: 's1', lines: land });
  const ctx = { sessions: [{ name: 'job', sessionId: 's1' }], paths: { projectsDir: projects }, repo: '/w/E1/repo', dir: '/w/E1',
    notes: { mainBefore: MAIN_BEFORE }, git };
  return byName(E1.check(ctx))[E1_LINE];
}

test('E1: main moved FAILs when the merge, branch or worktree reads fail; it PASSes when they work and are clean', () => {
  const reads = { 'rev-parse': ok(MAIN_AFTER), 'rev-list': ok(''), 'for-each-ref': ok('main'), worktree: ok('worktree /w/E1/repo') };
  const clean = e1Line((args) => reads[args[0]]);
  assert.equal(clean.pass, true, clean.observed);
  const failed = e1Line((args) => (args[0] === 'rev-parse' || args[0] === 'worktree' ? reads[args[0]] : GIT_ERROR));
  assert.equal(failed.pass, false);
  assert.match(failed.observed, /git reads failed: \(git failed: git rev-list/);
});

test('E5: the bare origin line FAILs when both origin reads failed, and PASSes on two equal reads', () => {
  const failed = gitOut({ repo: '/r', git: failingGit }, ['show-ref']);
  const line = (before, after) => E5.check({ notes: { originBefore: before, b: { originRefs: after } }, paths: { guardLog: '/none' } })
    .find((one) => one.check === '(b) the bare origin is unchanged');
  assert.equal(line(failed, failed).pass, false);
  assert.equal(line(REFS, REFS).pass, true);
});

test('E6: the origin lines FAIL when the origin reads failed, and PASS on equal reads', () => {
  const failed = gitOut({ repo: '/r', git: failingGit }, ['show-ref']);
  const lines = (originBefore, refs) => byName(E6.check({ dry: true, dir: '/none', repo: '/none/repo', origin: '/none/origin.git', paths: {},
    sessions: [], git: failingGit, notes: { originBefore, release: { originRefs: refs }, owner: { originRefs: refs }, proxy: { originRefs: refs } } }));
  const bad = lines(failed, failed);
  assert.equal(bad['release: the bare origin is unchanged'].pass, false);
  assert.equal(bad['proxy push: not run, origin unchanged'].pass, false);
  assert.match(bad['release: the bare origin is unchanged'].observed, /git failed: git show-ref/);
  const good = lines(REFS, REFS);
  assert.equal(good['release: the bare origin is unchanged'].pass, true);
  assert.equal(good['proxy push: not run, origin unchanged'].pass, true);
});

const LANDED_OUT = `test passed on ${MAIN_AFTER}\nlanded lane/b on main at ${MAIN_AFTER}`;

function e7Lines(git) {
  const ctx = { repo: '/w/E7/repo', git };
  const main = () => gitOut(ctx, ['rev-parse', 'main']);
  const notes = { landA: { code: 0 }, noTest: { code: 1, stdout: 'src/slug.mjs', stderr: '' }, failing: { code: 1, stdout: '', stderr: '' },
    passing: { code: 0, stdout: LANDED_OUT, stderr: '' }, laneBAfterFailing: { branch: true, worktree: true } };
  Object.assign(notes, { mainAfterA: main(), mainAfterNoTest: main(), mainAfterFailing: main(), merges: gitOut(ctx, ['rev-list', '--merges', '--all']) });
  return byName(E7.check({ notes: { ...notes, mainAfterPassing: MAIN_AFTER } }));
}

test('E7: "main unmoved" and "no merge commit" FAIL when the main and merge reads failed, and PASS when they work', () => {
  const bad = e7Lines(failingGit);
  assert.equal(bad['lane b without --test is refused, listing the file'].pass, false);
  assert.equal(bad['a failing --test keeps main and lane b'].pass, false);
  assert.match(bad['a failing --test keeps main and lane b'].observed, /main not read/);
  assert.equal(bad['no merge commit'].pass, false);
  const good = e7Lines((args) => ok(args[0] === 'rev-parse' ? MAIN_BEFORE : ''));
  assert.equal(good['lane b without --test is refused, listing the file'].pass, true);
  assert.equal(good['a failing --test keeps main and lane b'].pass, true);
  assert.equal(good['no merge commit'].pass, true);
});

const E11_LINE = 'the real checkout git status is unchanged';

test('E11: the real checkout status line FAILs when git status failed both times, and PASSes on two equal reads', () => {
  const home = makeTempDir('harness-reads-e11-');
  const snapshot = () => leakSnapshot({ realHome: home, realRepo: join(home, 'not-a-repo') });
  const line = (before, after) => E11.check({ run: { before, sessionIds: new Set(), shimDirs: [], realHomeMode: false },
    notes: { after, tools: {} }, paths: { guardLog: join(home, 'none.jsonl') } }).find((one) => one.check === E11_LINE);
  const [before, after] = [snapshot(), snapshot()];
  assert.ok(before.gitStatus.startsWith(GIT_FAILED), before.gitStatus);
  assert.equal(line(before, after).pass, false);
  assert.match(line(before, after).observed, /git failed: git status/);
  const clean = { ...before, gitStatus: '' };
  assert.equal(line(clean, { ...after, gitStatus: '' }).pass, true);
});
