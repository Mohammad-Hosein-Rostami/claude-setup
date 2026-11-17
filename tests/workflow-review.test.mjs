// Behaviour of home/workflows/review.js (spec round 4, section 7 `review`, lane W1 acceptance): lenses as a pipeline, verifiers, the Opus-max
// judge, the serial fix queue, delta rounds. Agents are scripted by label; a test can hold an agent back with a promise to prove the order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertWellFormedCalls, readMeta, runScript } from './workflow-sandbox.mjs';

const REVIEW = join(dirname(fileURLToPath(import.meta.url)), '..', 'home', 'workflows', 'review.js');
const META = readMeta(readFileSync(REVIEW, 'utf8')).meta;
const ARGS = { row: 'close:2', repo: '/p', base: 'main', range: 'main...HEAD', landing: false, fix: true, branch: 'lane/a', worktree: '/p-wt/a', suite: 'npm test' };
const SONNET = { agent: 'reviewer', model: 'sonnet', effort: 'high', lens: 'correctness', rules: 'core', brief: 'brief', requiredReading: [], plan: {} };
const OPUS = { agent: 'reviewer', model: 'opus', effort: 'max', lens: 'risk', rules: 'core', brief: 'brief', requiredReading: [], plan: {} };
const finding = (id, extra = {}) => ({ id, severity: 'blocking', file: 'a.mjs', line: 3, problem: `problem ${id}`, fix: 'fix it', security: false, ...extra });
const clean = { findings: [], verified: 'read it' };
const verdict = (id, real, extra = {}) => ({ id, real, why: `because ${id}`, reviewedSha: 'sha1', linesMoved: false, ...extra });
const implemented = (sha, extra = {}) => ({ branch: 'lane/a', worktree: '/p-wt/fix', sha, tests: { cmd: 'npm test', exit: 0 }, deferred: [], ...extra });

/** Scripted replies: tiers[i] answers the i-th `:tier` call (round i); lens/verify/judge/fix replies are functions of the round. */
function world({ tiers, lens = {}, verify = () => ({ verdicts: [] }), judge = () => ({ id: 'x', real: true, why: 'w' }), fix = (n) => implemented(`sha${n + 2}`), suite = { exit: 0, tail: 'ok' } }) {
  let tierCalls = 0;
  let fixCalls = 0;
  const round = () => tierCalls - 1;
  return {
    counts: () => ({ tierCalls, fixCalls }),
    replies: [
      { match: /:tier$/, reply: () => { const at = tierCalls++; return { sha: `sha${at + 1}`, reviewWorktree: `/rw${at}`, tierFile: `/t${at}.json`, tier: tiers[Math.min(at, tiers.length - 1)] }; } },
      ...Object.entries(lens).map(([name, reply]) => ({ match: new RegExp(`:review:${name}$`), reply: (...rest) => reply(round(), ...rest) })),
      { match: /:verify:/, reply: (prompt, opts, call) => verify(round(), call.label, prompt) },
      { match: /:judge:/, reply: (...rest) => judge(...rest) },
      { match: /:diagnose$/, reply: 'the cause' },
      { match: /:release$/, reply: { exit: 0, tail: '' } },
      { match: /:fix$/, reply: () => fix(fixCalls++) },
      { match: /:suite$/, reply: suite },
      { match: /:cleanup$/, reply: { exit: 0, tail: '' } },
    ],
  };
}
const tierOf = (...reviews) => ({ reviews, fileClasses: {} });
const labels = (run, pattern) => run.started.filter((label) => pattern.test(label));

test('a clean review: lenses return nothing, one round, no fix, every call well formed', async () => {
  const w = world({ tiers: [tierOf(SONNET, OPUS)], lens: { correctness: () => clean, risk: () => clean } });
  const run = await runScript(REVIEW, ARGS, { replies: w.replies });
  assert.equal(run.error, null);
  assert.equal(run.result.status, 'clean');
  assert.equal(run.result.rounds, 1);
  assert.equal(labels(run, /:fix$/).length, 0);
  assertWellFormedCalls(run.calls, 'close:2', META);
  const opus = run.calls.find((call) => call.label === 'close:2:review:risk');
  assert.deepEqual([opus.opts.model, opus.opts.effort, opus.opts.agentType], ['opus', 'max', 'reviewer']);
});

test('a Sonnet blocking finding starts its fix before the Opus-max lens returns; the round ends only when that lens is in', async () => {
  let releaseOpus;
  const opusHeld = new Promise((resolve) => { releaseOpus = resolve; });
  const w = world({
    tiers: [tierOf(SONNET, OPUS)],
    lens: { correctness: (round) => (round === 0 ? { findings: [finding('F1')], verified: 'x' } : clean), risk: (round) => (round === 0 ? opusHeld : clean) },
    verify: () => ({ verdicts: [verdict('F1', true)] }),
  });
  const running = runScript(REVIEW, ARGS, { replies: w.replies });
  let settled = false;
  running.then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 50)); // long enough for every agent that is not held back to run
  // The fix agent was started while the Opus lens was still reading, and the run cannot be over.
  assert.equal(w.counts().fixCalls, 1, 'fix started before the Opus lens returned');
  assert.equal(settled, false, 'the round is not over while a required lens has not returned');
  releaseOpus(clean);
  const run = await running;
  assert.equal(run.result.status, 'clean');
  assert.equal(run.result.rounds, 2, 'the fix is reviewed in a delta round');
  const order = run.started;
  assert.ok(order.indexOf('close:2:fix') < order.lastIndexOf('close:2:tier'), 'fix before the next tier');
});

test('each fix round uses the --delta set with the lane classes, and a fix agent starts from a released lane worktree', async () => {
  const w = world({
    tiers: [tierOf(SONNET)],
    lens: { correctness: (round) => (round === 0 ? { findings: [finding('F1')], verified: 'x' } : clean) },
    verify: () => ({ verdicts: [verdict('F1', true)] }),
  });
  const run = await runScript(REVIEW, ARGS, { replies: w.replies });
  const fix = run.calls.find((call) => call.label === 'close:2:fix');
  assert.equal(run.result.worktree, '/p-wt/fix', 'the result names the lane worktree the fix agent left');
  assert.match(fix.prompt, /review-tier\.mjs --delta sha1 --lane-classes \/t0\.json --json/);
  assert.match(fix.prompt, /git switch lane\/a && git rebase main/);
  assert.equal(fix.opts.isolation, 'worktree');
  assert.ok(run.started.indexOf('close:2:release') < run.started.indexOf('close:2:fix'), 'release before the fix');
  const second = run.calls.filter((call) => call.label === 'close:2:tier')[1];
  assert.match(second.prompt, /--delta sha1 .*--lane-classes \/t0\.json/);
});

test('a fix agent that returns its own delta tier hands it to the next round as it is', async () => {
  const deltaTier = tierOf(SONNET);
  const w = world({
    tiers: [tierOf(SONNET)],
    lens: { correctness: (round) => (round === 0 ? { findings: [finding('F1')], verified: 'x' } : clean) },
    verify: () => ({ verdicts: [verdict('F1', true)] }),
    fix: () => implemented('sha9', { tier: { ...deltaTier, deltaOf: 'sha1' } }),
  });
  const run = await runScript(REVIEW, ARGS, { replies: w.replies });
  const second = run.calls.filter((call) => call.label === 'close:2:tier')[1];
  assert.match(second.prompt, /Use this review-tier JSON as it is: .*"deltaOf":"sha1"/);
  assert.doesNotMatch(second.prompt, /Run: node/);
});

test('a security finding is never dropped by a verdict: real false goes to the Opus-max judge, and a judge that agrees puts it on the lead list', async () => {
  const w = world({
    tiers: [tierOf(SONNET)],
    lens: { correctness: () => ({ findings: [finding('S1', { security: true })], verified: 'x' }) },
    verify: () => ({ verdicts: [verdict('S1', false)] }),
    judge: () => ({ id: 'S1', real: false, why: 'not reachable' }),
  });
  const run = await runScript(REVIEW, ARGS, { replies: w.replies });
  const judge = run.calls.find((call) => call.label === 'close:2:judge:S1');
  assert.deepEqual([judge.opts.model, judge.opts.effort], ['opus', 'max']);
  assert.equal(run.result.leadList.length, 1);
  assert.equal(run.result.leadList[0].reason, 'not reachable');
  assert.equal(labels(run, /:fix$/).length, 0, 'not fixed when the judge rules it not real');
});

test('a judge that rules a security finding real sends it to the fix queue', async () => {
  const w = world({
    tiers: [tierOf(SONNET)],
    lens: { correctness: (round) => (round === 0 ? { findings: [finding('S1', { security: true })], verified: 'x' } : clean) },
    verify: () => ({ verdicts: [verdict('S1', false)] }),
    judge: () => ({ id: 'S1', real: true, why: 'reachable' }),
  });
  const run = await runScript(REVIEW, ARGS, { replies: w.replies });
  assert.equal(w.counts().fixCalls, 1);
  assert.equal(run.result.leadList.length, 0);
});

test('a non-security finding that an equally strong verifier calls not real is dropped with no judge', async () => {
  const w = world({
    tiers: [tierOf(SONNET)],
    lens: { correctness: () => ({ findings: [finding('N1')], verified: 'x' }) },
    verify: () => ({ verdicts: [verdict('N1', false)] }),
  });
  const run = await runScript(REVIEW, ARGS, { replies: w.replies });
  assert.equal(labels(run, /:judge:/).length, 0);
  assert.equal(run.result.status, 'clean');
  const verify = run.calls.find((call) => call.label.includes(':verify:'));
  assert.deepEqual([verify.opts.model, verify.opts.effort], ['sonnet', 'high']);
});

test('an Opus-lens finding that a Sonnet verifier calls not real goes to the Opus-max judge, never dropped; a missing verdict goes there too', async () => {
  const w = world({
    tiers: [tierOf(OPUS)],
    lens: { risk: () => ({ findings: [finding('N1'), finding('N2')], verified: 'x' }) },
    verify: () => ({ verdicts: [verdict('N1', false)] }), // N2 has no verdict
    judge: () => ({ id: 'N', real: false, why: 'no' }),
  });
  const run = await runScript(REVIEW, ARGS, { replies: w.replies });
  assert.deepEqual(labels(run, /:judge:/), ['close:2:judge:N1', 'close:2:judge:N2']);
  const judge = run.calls.find((call) => call.label === 'close:2:judge:N1');
  assert.deepEqual([judge.opts.model, judge.opts.effort], ['opus', 'max']);
  assert.equal(run.result.status, 'clean');
});

test('an Opus-lens finding the judge rules real is fixed', async () => {
  const w = world({
    tiers: [tierOf(OPUS)],
    lens: { risk: (round) => (round === 0 ? { findings: [finding('N1')], verified: 'x' } : clean) },
    verify: () => ({ verdicts: [verdict('N1', false)] }),
    judge: () => ({ id: 'N1', real: true, why: 'it is' }),
  });
  await runScript(REVIEW, ARGS, { replies: w.replies });
  assert.equal(w.counts().fixCalls, 1);
});

test('an Opus-max finding whose lines a fix changed is not judged at the new HEAD: it is an open item in the next round brief', async () => {
  const w = world({
    tiers: [tierOf(SONNET, OPUS)],
    lens: {
      correctness: (round) => (round === 0 ? { findings: [finding('F1')], verified: 'x' } : clean),
      risk: (round) => (round === 0 ? { findings: [finding('O1', { file: 'b.mjs' })], verified: 'x' } : clean),
    },
    verify: (round, label) => (label.includes('risk') ? { verdicts: [verdict('O1', true, { linesMoved: true })] } : { verdicts: [verdict('F1', true)] }),
  });
  const run = await runScript(REVIEW, ARGS, { replies: w.replies });
  const secondRisk = run.calls.filter((call) => call.label === 'close:2:review:risk')[1];
  assert.match(secondRisk.prompt, /\[open\] O1 b\.mjs:3/);
  assert.equal(run.calls.filter((call) => call.label === 'close:2:fix').length, 1, 'the moved finding was not fixed in the first round');
  assert.equal(run.result.status, 'clean');
});

test('a fix agent that defers a finding (an earlier fix moved its lines) carries it into the next round', async () => {
  const w = world({
    tiers: [tierOf(SONNET)],
    lens: { correctness: (round) => (round === 0 ? { findings: [finding('F1'), finding('F2', { line: 9 })], verified: 'x' } : clean) },
    verify: () => ({ verdicts: [verdict('F1', true), verdict('F2', true)] }),
    fix: () => implemented('sha2', { deferred: ['F2'] }),
  });
  const run = await runScript(REVIEW, ARGS, { replies: w.replies });
  const second = run.calls.filter((call) => call.label === 'close:2:review:correctness')[1];
  assert.match(second.prompt, /\[open\] F2/);
  assert.match(second.prompt, /\[fixed\] F1/);
});

test('the same file blocking in two rounds in a row calls the deep-debugger before the second fix', async () => {
  const w = world({
    tiers: [tierOf(SONNET)],
    lens: { correctness: (round) => (round < 2 ? { findings: [finding(`B${round}`)], verified: 'x' } : clean) },
    verify: (round) => ({ verdicts: [verdict(`B${round}`, true)] }),
  });
  const run = await runScript(REVIEW, ARGS, { replies: w.replies });
  const diagnose = run.started.indexOf('close:2:diagnose');
  assert.ok(diagnose > run.started.indexOf('close:2:fix'), 'not before the first fix');
  assert.ok(diagnose < run.started.lastIndexOf('close:2:fix'), 'before the second fix');
  const call = run.calls.find((entry) => entry.label === 'close:2:diagnose');
  assert.equal(call.opts.agentType, 'deep-debugger');
});

test('with landing the suite runs beside the reviews on the tip; a red suite is a blocking finding and nothing is clean until it passes', async () => {
  let suiteRuns = 0;
  const w = world({ tiers: [tierOf(SONNET)], lens: { correctness: () => clean } });
  w.replies.unshift({ match: /:suite$/, reply: () => ((suiteRuns += 1) === 1 ? { exit: 1, tail: '2 failing' } : { exit: 0, tail: 'ok' }) });
  const run = await runScript(REVIEW, { ...ARGS, landing: true }, { replies: w.replies });
  assert.equal(run.result.status, 'clean');
  assert.equal(run.result.rounds, 2);
  assert.equal(run.result.suite, 'pass');
  const fix = run.calls.find((call) => call.label === 'close:2:fix');
  assert.match(fix.prompt, /the full suite is red at sha1: 2 failing/);
  assert.ok(run.started.indexOf('close:2:suite') < run.started.indexOf('close:2:review:correctness') + 1, 'the suite starts with the reviews');
  const first = run.calls.find((call) => call.label === 'close:2:suite');
  assert.match(first.prompt, /test-pass\.mjs run --repo .*--suite -- npm test/);
});

test('fix:false only reports: findings come back, no fix agent starts', async () => {
  const w = world({
    tiers: [tierOf(SONNET)],
    lens: { correctness: () => ({ findings: [finding('F1'), finding('P1', { severity: 'optional' })], verified: 'x' }) },
    verify: () => ({ verdicts: [verdict('F1', true)] }),
  });
  const run = await runScript(REVIEW, { ...ARGS, fix: false }, { replies: w.replies });
  assert.equal(run.result.status, 'findings');
  assert.equal(run.result.findings.length, 1);
  assert.equal(run.result.optional.length, 1);
  assert.equal(labels(run, /:fix$/).length, 0);
});

test('a lens that was stopped makes the round incomplete, never clean', async () => {
  const w = world({ tiers: [tierOf(SONNET, OPUS)], lens: { correctness: () => clean, risk: () => null } });
  const run = await runScript(REVIEW, ARGS, { replies: w.replies });
  assert.equal(run.result.status, 'incomplete');
});

test('the delta round re-runs the lens of a fixed finding even when the delta tier no longer names it', async () => {
  const w = world({
    tiers: [tierOf(OPUS), tierOf()],
    lens: { risk: (round) => (round === 0 ? { findings: [finding('O1')], verified: 'x' } : clean) },
    verify: () => ({ verdicts: [verdict('O1', true)] }),
  });
  const run = await runScript(REVIEW, ARGS, { replies: w.replies });
  const again = run.calls.filter((call) => call.label === 'close:2:review:risk');
  assert.equal(again.length, 2);
  assert.match(again[1].prompt, /\[fixed\] O1/);
  assert.deepEqual([again[1].opts.model, again[1].opts.effort], ['opus', 'max']);
});

test('initialFindings go to the fix queue in round 0, and a concurrency file gets an Opus fix agent', async () => {
  const w = world({ tiers: [{ reviews: [SONNET], fileClasses: { 'a.mjs': ['logic', 'concurrency'] } }], lens: { correctness: () => clean } });
  const run = await runScript(REVIEW, { ...ARGS, initialFindings: [finding('J1')] }, { replies: w.replies });
  const fix = run.calls.find((call) => call.label === 'close:2:fix');
  assert.match(fix.prompt, /J1/);
  assert.equal(fix.opts.model, 'opus');
  assert.equal(run.result.rounds, 2);
});

test('a lane worktree that cannot be released ends the run as failed, naming why', async () => {
  const w = world({ tiers: [tierOf(SONNET)], lens: { correctness: () => ({ findings: [finding('F1')], verified: 'x' }) }, verify: () => ({ verdicts: [verdict('F1', true)] }) });
  w.replies.unshift({ match: /:release$/, reply: { exit: 1, tail: ' M a.mjs' } });
  const run = await runScript(REVIEW, ARGS, { replies: w.replies });
  assert.equal(run.result.status, 'failed');
  assert.match(run.result.text, /release .* failed: .* M a\.mjs/);
});
