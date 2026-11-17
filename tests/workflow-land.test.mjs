// Behaviour of home/workflows/land.js (spec section 7 `land`): rebase-only check, suite PASS at the tip, then the ff-only land, with the
// results the caller branches on: landed, conflict, red, needs-review, failed. The git-tidy and test-pass tools have their own tests; here the
// runner agents are scripted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertWellFormedCalls, readMeta, runScript } from './workflow-sandbox.mjs';

const LAND = join(dirname(fileURLToPath(import.meta.url)), '..', 'home', 'workflows', 'land.js');
const ARGS = { row: 'close:4', closeRow: 'close:4', statusFile: '/p/STATUS.md', repo: '/p', base: 'main', branch: 'lane/a', worktree: '/p-wt/a', suite: 'npm test', tip: 'abc1234' };
const META = readMeta(readFileSync(LAND, 'utf8')).meta;
const rebased = (extra = {}) => ({ match: /:rebase$/, reply: { exit: 0, tip: 'abc1234', patchesChanged: 0, files: [], tail: 'tip abc1234', ...extra } });
const suite = (reply) => ({ match: /:suite$/, reply: { exit: 0, tip: 'abc1234', patchesChanged: 0, files: [], tail: 'PASS', ...reply } });
const landed = (reply) => ({ match: /:land$/, reply: { exit: 0, tip: 'def5678', patchesChanged: 0, files: [], tail: 'landed', ...reply } });
const atTip = (reply = {}) => ({ match: /:tip$/, reply: { exit: 0, tip: 'abc1234', patchesChanged: 0, files: [], tail: 'abc1234', ...reply } });
const baseAt = (tip) => ({ match: /:base$/, reply: { exit: 0, tip, patchesChanged: 0, files: [], tail: tip } });
const status = { match: /:status$/, reply: { exit: 0, tip: '', patchesChanged: 0, files: [], tail: 'ok' } };

test('a clean lane: rebase check, suite, land, then the close row is done with the landed sha; every call is well formed', async () => {
  const run = await runScript(LAND, ARGS, { replies: [atTip(), rebased(), suite({}), landed({}), status] });
  assert.equal(run.error, null);
  assert.deepEqual(run.result, { status: 'landed', sha: 'def5678', patchesChanged: 0, tidy: 'clean' });
  assert.deepEqual(run.started, ['close:4:tip', 'close:4:rebase', 'close:4:suite', 'close:4:land', 'close:4:status']);
  assertWellFormedCalls(run.calls, 'close:4', META);
  assert.match(run.calls[0].prompt, /git rev-parse --verify refs\/heads\/lane\/a/);
  assert.match(run.calls[1].prompt, /git-tidy\.mjs land lane\/a \/p --base main --rebase-only/);
  assert.match(run.calls[2].prompt, /test-pass\.mjs check abc1234 .*--suite/);
  assert.match(run.calls[2].prompt, /test-pass\.mjs run --repo <that folder> --suite \(no command after it/);
  assert.doesNotMatch(run.calls[2].prompt, /--suite -- /, 'the shell would expand a glob in the suite command and test-pass refuses it');
  assert.match(run.calls[4].prompt, /status\.mjs --file \/p\/STATUS\.md done close:4 .*def5678/);
});

test('git-tidy exit 1 (landed with findings) is landed with the findings as the tidy text', async () => {
  const run = await runScript(LAND, ARGS, { replies: [atTip(), rebased(), suite({}), landed({ exit: 1, tail: 'superseded-copy x' }), status] });
  assert.equal(run.result.status, 'landed');
  assert.equal(run.result.tidy, 'superseded-copy x');
});

test('a conflict (exit 3) returns conflict with the files named and starts no suite or land', async () => {
  const run = await runScript(LAND, ARGS, { replies: [atTip(), rebased({ exit: 3, files: ['a.mjs', 'b.mjs'], tail: 'conflict' })] });
  assert.deepEqual(run.result, { status: 'conflict', sha: 'abc1234', patchesChanged: 0, tidy: 'a.mjs, b.mjs' });
  assert.deepEqual(run.started, ['close:4:tip', 'close:4:rebase']);
});

test('patches changed by the rebase return needs-review: nothing lands', async () => {
  const run = await runScript(LAND, ARGS, { replies: [atTip(), rebased({ patchesChanged: 2 })] });
  assert.deepEqual(run.result, { status: 'needs-review', sha: 'abc1234', patchesChanged: 2, tidy: 'tip abc1234' });
  assert.deepEqual(run.started, ['close:4:tip', 'close:4:rebase']);
});

test('a red suite returns red with the tip and the suite tail, and never lands', async () => {
  const run = await runScript(LAND, ARGS, { replies: [atTip(), rebased(), suite({ exit: 1, tail: '3 failing' })] });
  assert.deepEqual(run.result, { status: 'red', sha: 'abc1234', patchesChanged: 0, tidy: '3 failing' });
  assert.ok(!run.started.includes('close:4:land'));
});

test('a red suite names the failing test files and their first error line, from the suite step, at the rebased tip (not the reviewed one)', async () => {
  const run = await runScript(LAND, ARGS, { replies: [atTip(), rebased({ tip: 'fed9876' }), suite({ exit: 1, tip: 'fed9876', files: ['tests/a.test.mjs', 'tests/b.test.mjs'], tail: 'not ok 1 - parses: expected 2, got 3' })] });
  assert.equal(run.result.status, 'red');
  assert.equal(run.result.sha, 'fed9876');
  assert.match(run.result.tidy, /tests\/a\.test\.mjs, tests\/b\.test\.mjs/);
  assert.match(run.result.tidy, /not ok 1 - parses: expected 2, got 3/);
  const suitePrompt = run.calls.find((call) => /:suite$/.test(call.label)).prompt;
  assert.match(suitePrompt, /failing test files/, 'the runner is told to report the failing files, not the last output lines');
  assert.match(suitePrompt, /check fed9876 /, 'the suite is checked at the rebased tip');
  assert.doesNotMatch(suitePrompt, /listed for a conflict|its last 3 output lines/, 'the shared field text must not contradict the suite step');
});

test('a base that moved during the land (exit 5) goes back to the rebase check and lands on the second try', async () => {
  let landTries = 0;
  const run = await runScript(LAND, ARGS, {
    replies: [atTip(), rebased(), suite({}), baseAt('b000001'), { match: /:land$/, reply: () => ((landTries += 1) === 1 ? { exit: 5, tip: 'x', patchesChanged: 0, files: [], tail: 'base moved' } : { exit: 0, tip: 'def5678', patchesChanged: 0, files: [], tail: 'landed' }) }, status],
  });
  assert.equal(run.result.status, 'landed');
  assert.equal(run.started.filter((label) => label.endsWith(':rebase')).length, 2);
});

test('exits 2 and 4 from the land step return failed with the tool output', async () => {
  for (const exit of [2, 4]) {
    const run = await runScript(LAND, ARGS, { replies: [atTip(), rebased(), suite({}), landed({ exit, tail: `refused ${exit}` })] });
    assert.equal(run.result.status, 'failed', `exit ${exit}`);
    assert.match(run.result.tidy, new RegExp(`refused ${exit}`));
  }
});

test('a runner that was stopped (null) returns failed instead of throwing', async () => {
  const run = await runScript(LAND, ARGS, { replies: [{ match: /./, reply: null }] });
  assert.equal(run.error, null);
  assert.equal(run.result.status, 'failed');
});

test('a branch that is not at the reviewed tip is never landed: the old branch of a re-done lane is refused (B1)', async () => {
  const run = await runScript(LAND, ARGS, { replies: [atTip({ tip: 'old9999' })] });
  assert.equal(run.result.status, 'failed');
  assert.match(run.result.tidy, /lane\/a is at old9999, not at the reviewed abc1234: nothing was landed/);
  assert.deepEqual(run.started, ['close:4:tip']);
});

test('a branch that does not exist, or a tip that is empty, fails before any rebase; a longer or shorter form of the same sha passes', async () => {
  for (const reply of [{ exit: 1, tip: '', tail: 'fatal: Needed a single revision' }, { exit: 0, tip: '' }]) {
    const run = await runScript(LAND, ARGS, { replies: [atTip(reply)] });
    assert.equal(run.result.status, 'failed');
    assert.deepEqual(run.started, ['close:4:tip']);
  }
  const full = await runScript(LAND, { ...ARGS, tip: 'abc1234def' }, { replies: [atTip({ tip: 'abc1234def5678' }), rebased(), suite({}), landed({}), status] });
  assert.equal(full.result.status, 'landed');
});

test('a base that is reported moved twice while it did not change fails instead of looping; a real second move lands', async () => {
  const exit5 = { exit: 5, tip: 'x', patchesChanged: 0, files: [], tail: 'base moved' };
  const stuck = await runScript(LAND, ARGS, { replies: [atTip(), rebased(), suite({}), baseAt('b000001'), { match: /:land$/, reply: exit5 }, status] });
  assert.equal(stuck.result.status, 'failed');
  assert.match(stuck.result.tidy, /said the base moved twice but main is still at b000001/);
  assert.equal(stuck.started.filter((label) => label.endsWith(':rebase')).length, 2);
  let bases = 0;
  let tries = 0;
  const moving = await runScript(LAND, ARGS, { replies: [atTip(), rebased(), suite({}),
    { match: /:base$/, reply: () => ({ exit: 0, tip: `b00000${(bases += 1)}`, patchesChanged: 0, files: [], tail: '' }) },
    { match: /:land$/, reply: () => ((tries += 1) < 3 ? exit5 : { exit: 0, tip: 'def5678', patchesChanged: 0, files: [], tail: 'landed' }) }, status] });
  assert.equal(moving.result.status, 'landed');
  assert.equal(tries, 3);
});

test('a failed branch lookup is a failure even when the runner still printed the expected sha; a base that cannot be read after exit 5 fails', async () => {
  const lookup = await runScript(LAND, ARGS, { replies: [atTip({ exit: 128, tip: 'abc1234' })] });
  assert.equal(lookup.result.status, 'failed');
  assert.match(lookup.result.tidy, /branch lane\/a not found/);
  assert.deepEqual(lookup.started, ['close:4:tip']);
  const exit5 = { exit: 5, tip: 'x', patchesChanged: 0, files: [], tail: 'base moved' };
  for (const base of [null, { exit: 128, tip: 'b000002', patchesChanged: 0, files: [], tail: 'fatal' }]) {
    const run = await runScript(LAND, ARGS, { replies: [atTip(), rebased(), suite({}), { match: /:base$/, reply: base }, { match: /:land$/, reply: exit5 }] });
    assert.equal(run.result.status, 'failed');
    assert.match(run.result.tidy, /could not be read after "base moved"/);
    assert.equal(run.started.filter((label) => label.endsWith(':rebase')).length, 1);
  }
});
