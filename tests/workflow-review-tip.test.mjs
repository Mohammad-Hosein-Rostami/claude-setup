// Behaviour of home/workflows/review.js when review-tier read another commit than the one the lane worktree is at (lane r7-delta, fix
// round 5, security B14): the `tip` of the tier JSON must be the full sha the runner reports, in every round (the first one, a round
// after a fix, a `deltaOf` run) and for a JSON the caller passed in; otherwise the round fails before any lens starts.
// Agents are scripted by label (workflow-sandbox.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScript } from './workflow-sandbox.mjs';
import { priorOfTierPrompt, withPriorLine } from './workflow-review-helpers.mjs';

const REVIEW = join(dirname(fileURLToPath(import.meta.url)), '..', 'home', 'workflows', 'review.js');
const ARGS = { row: 'close:2', repo: '/p', base: 'main', range: 'main...HEAD', landing: false, fix: true, branch: 'lane/a', worktree: '/p-wt/a', suite: 'npm test' };
const SONNET = { agent: 'reviewer', model: 'sonnet', effort: 'high', lens: 'correctness', rules: 'core', brief: 'brief', requiredReading: [], plan: {} };
const BASE_SHA = 'ba5e0001'.padEnd(40, '0');
const sha = (n) => `a1b2c3${n}`.padEnd(40, '0');
const OTHER_REPOSITORY_TIP = 'd0c5'.padEnd(40, '0');
const clean = { findings: [], verified: 'read it' };
const blocking = { findings: [{ id: 'F1', severity: 'blocking', file: 'a.mjs', line: 3, problem: 'a problem', fix: 'fix it', security: false }], verified: 'read it' };
const lensCalls = (run) => run.calls.filter((call) => /:review:/.test(call.label));

/**
 * Scripted replies: the i-th `:tier` call reports sha(firstSha + i) as the lane's HEAD and a tier JSON whose `tip` is `tipOf(i, thatSha)`
 * (the key is left out when that is undefined); the i-th lens call answers `lens(i)`; the fix returns sha(firstSha + 1).
 */
function world({ tipOf = (at, head) => head, lens = () => clean, firstSha = 1 }) {
  let [tierCalls, lensCount] = [0, 0];
  const tierAt = (at, prompt) => {
    const head = sha(firstSha + at);
    const tip = tipOf(at, head);
    return { exit: 0, baseSha: BASE_SHA, sha: head, reviewWorktree: `/scratch/close-2-${head.slice(0, 8)}`, tier: { ...(tip === undefined ? {} : { tip }), reviews: [SONNET], fileClasses: {}, laneClasses: ['logic'], ...priorOfTierPrompt(prompt) } };
  };
  return [
    { match: /:tier$/, reply: (prompt) => tierAt(tierCalls++, prompt) },
    { match: /:review:correctness$/, reply: (prompt) => withPriorLine(prompt, lens(lensCount++)) },
    { match: /:verify:/, reply: (prompt) => ({ verdicts: [...prompt.matchAll(/^- \[[a-z-]+\] (\S+) /gm)].map(([, id]) => ({ id, real: true, why: 'yes', reviewedSha: 'x', linesMoved: false })) }) },
    { match: /:base$/, reply: { exit: 0, tail: `${BASE_SHA}\n` } },
    { match: /:release$/, reply: { exit: 0, tail: '' } },
    { match: /:fix$/, reply: { branch: 'lane/a', worktree: '/p-wt/fix', sha: sha(firstSha + 1), tests: {}, deferred: [] } },
    { match: /:suite$/, reply: { exit: 0, tail: 'ok' } },
    { match: /:cleanup$/, reply: { exit: 0, tail: '' } },
  ];
}

test('the control: a tier JSON whose tip is the reviewed sha runs the round, in the first round and in the round after a fix', async () => {
  const run = await runScript(REVIEW, ARGS, { replies: world({ lens: (at) => (at === 0 ? blocking : clean) }) });
  assert.equal(run.error, null);
  assert.deepEqual([run.result.status, run.result.rounds, run.result.tip], ['clean', 2, sha(2)]);
  assert.equal(lensCalls(run).length, 2);
});

test('security B14: in the first round a tier JSON for another tip, for a short sha or with no tip at all fails the round before any lens starts', async () => {
  const wrong = [[OTHER_REPOSITORY_TIP, OTHER_REPOSITORY_TIP], [sha(1).slice(0, 12), sha(1).slice(0, 12)], [undefined, 'undefined'], [null, 'null'], [{ sha: sha(1) }, 'object Object'], ['HEAD', 'HEAD']];
  for (const [tip, shown] of wrong) {
    const run = await runScript(REVIEW, ARGS, { replies: world({ tipOf: () => tip }) });
    assert.equal(run.result.status, 'failed', JSON.stringify(tip));
    assert.ok(run.result.text.includes(`the tier JSON is for the tip "${shown}`) || run.result.text.includes(`the tier JSON is for the tip "[${shown}]`), run.result.text);
    assert.match(run.result.text, new RegExp(`not for the reviewed sha ${sha(1)}: review-tier did not read the commit the lane worktree is at`));
    assert.equal(lensCalls(run).length, 0, 'no lens read a review set made for other code');
    assert.equal(run.calls.filter((call) => /:fix$/.test(call.label)).length, 0);
  }
});

test('security B14: in the round after a fix a tier JSON for the tip before the fix, or for another repository, fails the round', async () => {
  for (const staleTip of [sha(1), OTHER_REPOSITORY_TIP]) {
    const run = await runScript(REVIEW, ARGS, { replies: world({ lens: () => blocking, tipOf: (at, head) => (at === 0 ? head : staleTip) }) });
    assert.equal(run.result.status, 'failed', staleTip);
    assert.ok(run.result.text.includes(`the tier JSON is for the tip "${staleTip}", not for the reviewed sha ${sha(2)}`), run.result.text);
    assert.equal(lensCalls(run).length, 1, 'only the first round\'s lens ran');
  }
});

test('security B14: a run that starts as a fix round (deltaOf) checks the tip too', async () => {
  const delta = { ...ARGS, deltaOf: sha(1), laneClasses: ['logic'], laneStart: BASE_SHA, priorFindings: [] };
  const honest = await runScript(REVIEW, delta, { replies: world({ firstSha: 2 }) });
  assert.equal(honest.result.status, 'clean', honest.result.text);
  const redirected = await runScript(REVIEW, delta, { replies: world({ firstSha: 2, tipOf: () => OTHER_REPOSITORY_TIP }) });
  assert.equal(redirected.result.status, 'failed');
  assert.match(redirected.result.text, /the tier JSON is for the tip "d0c5000000/);
  assert.equal(lensCalls(redirected).length, 0);
});

test('security B14: a tier JSON the caller passed in (args.tier) is held to the same check: one made at another commit fails the round', async () => {
  const known = { tip: sha(9), reviews: [SONNET], fileClasses: {}, laneClasses: ['logic'], base: BASE_SHA };
  const stale = await runScript(REVIEW, { ...ARGS, tier: known }, { replies: world({ tipOf: () => known.tip }) });
  assert.equal(stale.result.status, 'failed');
  assert.ok(stale.result.text.includes(`the tier JSON is for the tip "${sha(9)}", not for the reviewed sha ${sha(1)}`), stale.result.text);
  const current = await runScript(REVIEW, { ...ARGS, tier: { ...known, tip: sha(1) } }, { replies: world({}) });
  assert.equal(current.result.status, 'clean', current.result.text);
});
