// Behaviour of home/workflows/review.js around a delta run's edges (lane r7-delta, fix round 2): a run that starts with findings fixes
// first, a fix that committed nothing is named, the prior line is read in every delta round, `needs the full range` stops a round, and a
// `deltaOf` run needs the earlier round's findings and classes. Fixtures: the reviewers' sandbox scenarios W1-W5 and `e-reviewjs.mjs` 2-3.
// Agents are scripted by label (workflow-sandbox.mjs); workflow-review-prior.test.mjs covers the prior file itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScript } from './workflow-sandbox.mjs';
import { priorOfTierPrompt, withPriorLine } from './workflow-review-helpers.mjs';

const REVIEW = join(dirname(fileURLToPath(import.meta.url)), '..', 'home', 'workflows', 'review.js');
const ARGS = { row: 'close:2', repo: '/p', base: 'main', range: 'main...HEAD', landing: false, fix: true, branch: 'lane/a', worktree: '/p-wt/a', suite: 'npm test' };
const SONNET = { agent: 'reviewer', model: 'sonnet', effort: 'high', lens: 'correctness', rules: 'core', brief: 'brief', requiredReading: [], plan: {} };
const finding = (id, extra = {}) => ({ id, severity: 'blocking', file: 'a.mjs', line: 3, problem: `problem ${id}`, fix: 'fix it', security: false, ...extra });
const sha = (n) => `a1b2c3${n}`;
const clean = { findings: [], verified: 'read it' };
const callsOf = (run, label) => run.calls.filter((call) => call.label === label);
const priorLines = (prompt) => prompt.match(/^- \[[^\n]*$/gm) ?? [];

/**
 * Scripted replies. The i-th `:tier` call reports sha(firstSha + i) (or `tier(i, prompt)` when given); `lens(i, prompt)` answers the i-th
 * lens call (a reply without `prior` gets a correct prior line); every finding a verifier is shown is real; the n-th fix returns `fixShas[n]`.
 */
function world({ lens = () => clean, firstSha = 1, tier, fixShas = [sha(2), sha(3)], fix, verdictOf = () => ({}) }) {
  let [tierCalls, lensCalls, fixCalls] = [0, 0, 0];
  const tierAt = (at, prompt) => ({ exit: 0, baseSha: 'ba5e0001', sha: sha(firstSha + at), reviewWorktree: `/scratch/close-2-${sha(firstSha + at)}`, tierFile: `/t${at}.json`, tier: { reviews: [SONNET], fileClasses: {}, ...priorOfTierPrompt(prompt) } });
  return [
    { match: /:tier$/, reply: (prompt) => { const at = tierCalls++; return tier === undefined ? tierAt(at, prompt) : tier(at, prompt, tierAt(at, prompt)); } },
    { match: /:review:correctness$/, reply: (prompt) => withPriorLine(prompt, lens(lensCalls++, prompt)) },
    { match: /:verify:/, reply: (prompt) => ({ verdicts: [...prompt.matchAll(/^- \[[a-z-]+\] (\S+) /gm)].map(([, id]) => ({ id, real: true, why: 'yes', reviewedSha: 'x', linesMoved: false, ...verdictOf(id) })) }) },
    { match: /:diagnose$/, reply: 'the cause' }, // the same file blocking two rounds in a row
    { match: /:release$/, reply: { exit: 0, tail: '' } },
    { match: /:fix$/, reply: () => (fix === undefined ? { branch: 'lane/a', worktree: '/p-wt/fix', sha: fixShas[fixCalls++], tests: {}, deferred: [] } : fix(fixCalls++)) },
    { match: /:suite$/, reply: { exit: 0, tail: 'ok' } },
    { match: /:cleanup$/, reply: { exit: 0, tail: '' } },
  ];
}

// build's land loop: `deltaOf` is the reviewed tip, the lane has not moved, and the conflict or the red suite is the finding to fix.
const LAND_LOOP = { ...ARGS, landing: true, deltaOf: sha(1), laneClasses: '/t-lane.json' };
const CONFLICT = finding('conflict-close:2', { file: 'src/a.mjs', line: 0, problem: 'rebasing lane/a onto main conflicts in src/a.mjs' });
const RED = finding('red-close:2', { file: '(suite)', line: 0, problem: 'suite red at the rebased tip: 3 failing' });

test('review N1 (W3): a delta run that starts with a conflict or a red suite fixes first, then reviews the fix as a delta round and ends clean', async () => {
  for (const initial of [CONFLICT, RED]) {
    const run = await runScript(REVIEW, { ...LAND_LOOP, initialFindings: [initial] }, { replies: world({ firstSha: 2 }) });
    assert.equal(run.error, null);
    assert.equal(run.result.status, 'clean', run.result.text);
    assert.equal(run.result.rounds, 2);
    assert.equal(run.result.tip, sha(2), 'the reviewed tip is the fix');
    assert.deepEqual(run.started.slice(0, 3), ['close:2:release', 'close:2:fix', 'close:2:tier'], 'the fix runs before review-tier is asked');
    const [fix] = callsOf(run, 'close:2:fix');
    assert.ok(fix.prompt.includes(`] ${initial.id} `), fix.prompt);
    assert.equal(fix.opts.model, 'opus', 'no tier exists yet to say the files are not concurrency code: the stronger model fixes');
    const tiers = callsOf(run, 'close:2:tier');
    assert.equal(tiers.length, 1, 'one review round after the fix');
    assert.match(tiers[0].prompt, /review-tier\.mjs --delta a1b2c31 --prior <the prior findings file> --prior-sha256 <its sha256> --base main --landing --lane-classes \/t-lane\.json --json/);
    assert.deepEqual(priorLines(tiers[0].prompt).map((line) => line.split(' ').slice(0, 3).join(' ')), [`- [blocking] ${initial.id}`], 'the fixed finding is the prior finding of the round');
    assert.ok(callsOf(run, 'close:2:review:correctness')[0].prompt.includes(`- [fixed] ${initial.id} `), 'the lens verifies the fix agent\'s claim');
  }
});

test('review N1: a first fix that committed nothing ends failed with the ids, before review-tier is asked', async () => {
  const run = await runScript(REVIEW, { ...LAND_LOOP, initialFindings: [CONFLICT, RED] }, { replies: world({ fixShas: [sha(1)] }) });
  assert.equal(run.result.status, 'failed');
  assert.match(run.result.text, /^the fix committed nothing for conflict-close:2, red-close:2: the lane is still at a1b2c31, so there is nothing to review again\. Read why the fix agent changed nothing/);
  assert.equal(callsOf(run, 'close:2:tier').length, 0);
  assert.deepEqual(run.result.findings.map(({ id }) => id), ['conflict-close:2', 'red-close:2'], 'the result still holds what is not fixed');
});

test('a first fix that was stopped or left the lane branch ends failed and starts no review', async () => {
  for (const [fix, why] of [[() => null, /the fix agent was stopped/], [() => ({ branch: 'other', worktree: '/p-wt/fix', sha: sha(2), tests: {}, deferred: [] }), /not the lane lane\/a/]]) {
    const run = await runScript(REVIEW, { ...LAND_LOOP, initialFindings: [CONFLICT] }, { replies: world({ fix }) });
    assert.equal(run.result.status, 'failed');
    assert.match(run.result.text, why);
    assert.equal(callsOf(run, 'close:2:tier').length, 0);
  }
});

test('review N1: a later round whose fix left HEAD where it was ends failed with the ids; a finding called moved when no fix ran does too', async () => {
  const same = await runScript(REVIEW, ARGS, { replies: world({ lens: (at) => (at === 0 ? { findings: [finding('F1')], verified: 'x' } : clean), fixShas: [sha(1)] }) });
  assert.equal(same.result.status, 'failed');
  assert.match(same.result.text, /^the fix committed nothing for F1: the lane is still at a1b2c31/);
  assert.equal(callsOf(same, 'close:2:tier').length, 1, 'review-tier is not asked for an empty delta');
  const moved = await runScript(REVIEW, ARGS, { replies: world({ lens: (at) => (at === 0 ? { findings: [finding('O1')], verified: 'x' } : clean), verdictOf: () => ({ linesMoved: true }) }) });
  assert.equal(moved.result.status, 'failed');
  assert.match(moved.result.text, /^the fix committed nothing for O1/);
  assert.equal(callsOf(moved, 'close:2:fix').length, 0);
});

test('review S3 (W1): a prior finding a lens counted open without returning it stays open in the next prior file', async () => {
  const lens = (at) => {
    if (at === 0) return { findings: [finding('A')], verified: 'r0' };
    if (at === 1) return { findings: [finding('B', { file: 'b.mjs' })], verified: 'r1', prior: 'prior: 0 fixed, 1 open' };
    return clean;
  };
  const run = await runScript(REVIEW, ARGS, { replies: world({ lens }) });
  assert.equal(run.error, null);
  const tiers = callsOf(run, 'close:2:tier');
  assert.deepEqual(priorLines(tiers[2].prompt), ['- [blocking] A a.mjs:3: "problem A"', '- [blocking] B b.mjs:3: "problem B"'], 'A is verified again');
  const third = callsOf(run, 'close:2:review:correctness')[2].prompt;
  assert.ok(third.includes('- [open] A a.mjs:3: "problem A"') && third.includes('- [fixed] B b.mjs:3: "problem B"'), third);
  assert.equal(run.result.status, 'clean', 'the third round closes both');
  assert.equal(run.result.rounds, 3);
});

test('review S3: a prior finding the lens returned again is not carried twice, and one open count with nothing left to fix is incomplete', async () => {
  const again = (at) => {
    if (at === 0) return { findings: [finding('A'), finding('C', { file: 'c.mjs' })], verified: 'r0' };
    if (at === 1) return { findings: [finding('A')], verified: 'r1', prior: 'prior: 1 fixed, 1 open' };
    return clean;
  };
  const run = await runScript(REVIEW, ARGS, { replies: world({ lens: again }) });
  assert.deepEqual(priorLines(callsOf(run, 'close:2:tier')[2].prompt), ['- [blocking] A a.mjs:3: "problem A"'], 'A was returned and fixed again; C was closed');
  assert.equal(run.result.status, 'clean');
  const silent = (at) => (at === 0 ? { findings: [finding('A')], verified: 'r0' } : { ...clean, prior: 'prior: 0 fixed, 1 open' });
  const stuck = await runScript(REVIEW, ARGS, { replies: world({ lens: silent }) });
  assert.equal(stuck.result.status, 'incomplete');
  assert.match(stuck.result.text, /lens correctness still sees 1 of the 1 prior findings open/);
});

test('review S3: the prior line is read in every delta round, also one that still has a new finding to fix', async () => {
  for (const [prior, why] of [[undefined, /lens correctness returned no `prior: <n> fixed, <m> open` line/], ['prior: 2 fixed, 0 open', /lens correctness counted 2 fixed and 0 open, the prior findings file holds 1/]]) {
    const lens = (at) => (at === 0 ? { findings: [finding('A')], verified: 'r0' } : { findings: [finding('B', { file: 'b.mjs' })], verified: 'r1', prior });
    const run = await runScript(REVIEW, ARGS, { replies: world({ lens: (at) => { const reply = lens(at); return prior === undefined && at === 1 ? { ...reply, prior: '' } : reply; } }) });
    assert.equal(run.result.status, 'incomplete', String(prior));
    assert.match(run.result.text, why);
    assert.equal(callsOf(run, 'close:2:tier').length, 2, 'no third round on a round nobody verified');
    assert.deepEqual(run.result.findings.map(({ id }) => id), ['B'], 'the new finding is still reported');
  }
});

test('review N2 (W2): a lens that says it needs the full range ends the delta round incomplete, whatever its prior line says', async () => {
  const replies = [
    { verified: 'needs the full range: the fix changes a shared default whose readers I cannot bound', prior: 'prior: 1 fixed, 0 open' },
    { verified: 'read it', prior: 'prior: 1 fixed, 0 open\nNeeds the full range' },
  ];
  for (const reply of replies) {
    const run = await runScript(REVIEW, ARGS, { replies: world({ lens: (at) => (at === 0 ? { findings: [finding('A')], verified: 'r0' } : { findings: [], ...reply }) }) });
    assert.equal(run.result.status, 'incomplete', JSON.stringify(reply));
    assert.match(run.result.text, /lens correctness says it needs the full range, so the delta was not enough to judge the fix: run the review again without deltaOf/);
  }
  const whole = await runScript(REVIEW, ARGS, { replies: world({ lens: () => ({ findings: [], verified: 'nothing here needs the full range' }) }) });
  assert.equal(whole.result.status, 'clean', 'a whole-range round has no delta to leave');
});

const DELTA = { ...ARGS, deltaOf: sha(0), laneClasses: '/t-lane.json' };

test('review N6 (W4): a deltaOf run needs the earlier round\'s findings, and each of them reaches the prior file and every lens', async () => {
  const none = await runScript(REVIEW, DELTA, { replies: world({}) });
  assert.equal(none.error, null, 'returned, not thrown: build does not catch its review child');
  assert.equal(none.result.status, 'failed');
  assert.match(none.result.text, /^args\.deltaOf needs args\.priorFindings: the blocking and should-fix findings of the round that reviewed deltaOf .* Pass \[\] only when that round ended clean, on purpose/);
  assert.equal(none.calls.length, 0, 'no agent runs');
  const run = await runScript(REVIEW, { ...DELTA, priorFindings: [finding('A'), finding('n1', { severity: 'optional' })] }, { replies: world({}) });
  assert.equal(run.error, null);
  assert.deepEqual(priorLines(callsOf(run, 'close:2:tier')[0].prompt), ['- [blocking] A a.mjs:3: "problem A"'], 'the counted finding is in the prior file');
  const lens = callsOf(run, 'close:2:review:correctness')[0].prompt;
  assert.ok(lens.includes('- [open] A a.mjs:3: "problem A"'), lens);
  assert.match(lens, /prior: <n> fixed, <m> open` over those 1 findings/);
  assert.equal(run.result.status, 'clean');
  const open = await runScript(REVIEW, { ...DELTA, priorFindings: [finding('A')] }, { replies: world({ lens: () => ({ ...clean, prior: 'prior: 0 fixed, 1 open' }) }) });
  assert.equal(open.result.status, 'incomplete', 'a prior finding the lens still sees is never clean');
  const onPurpose = await runScript(REVIEW, { ...DELTA, priorFindings: [] }, { replies: world({}) });
  assert.equal(onPurpose.result.status, 'clean', 'an empty list given on purpose (the earlier round was clean) runs');
  assert.match(onPurpose.calls[0].prompt, /with exactly these 0 lines \(an empty file\)/);
});

test('a deltaOf run needs the lane classes of the earlier round, and bad delta args name what to pass', async () => {
  const noClasses = await runScript(REVIEW, { ...ARGS, deltaOf: sha(0), priorFindings: [] }, { replies: world({}) });
  assert.equal(noClasses.result.status, 'failed');
  assert.match(noClasses.result.text, /^args\.deltaOf needs args\.laneClasses: the tierFile of the round that reviewed deltaOf\..* leave deltaOf out for a whole-range review/);
  assert.equal(noClasses.calls.length, 0);
  for (const [args, why] of [
    [{ ...DELTA, priorFindings: [{ id: 'A' }] }, /args\.priorFindings entries must be \{id, severity \(blocking\|should-fix\|optional\), file, line \(a number\), problem\}/],
    [{ ...DELTA, priorFindings: [finding('A', { severity: 'fixed' })] }, /args\.priorFindings entries must be/],
    [{ ...ARGS, priorFindings: [] }, /args\.priorFindings belongs to a deltaOf run/],
    // review n7, security N14 (W5): a given tier JSON would be a delta round with no prior file and no forced lane set.
    [{ ...DELTA, priorFindings: [], tier: { reviews: [SONNET], fileClasses: {} } }, /args\.tier cannot be combined with args\.deltaOf: a delta round runs review-tier itself/],
  ]) {
    const run = await runScript(REVIEW, args, { replies: world({}) });
    assert.match(run.error?.message ?? '', why);
    assert.equal(run.calls.length, 0);
  }
});

test('security N10: a delta round whose tier names no lens and carries nothing is failed, never clean with no lens', async () => {
  const run = await runScript(REVIEW, { ...DELTA, priorFindings: [] }, { replies: world({ tier: (at, prompt, reply) => ({ ...reply, tier: { ...reply.tier, reviews: [] } }) }) });
  assert.equal(run.result.status, 'failed');
  assert.match(run.result.text, /the delta review set of a1b2c31 is empty: review-tier gives at least one lens for a landing diff and for every fix round/);
  assert.equal(callsOf(run, 'close:2:review:correctness').length, 0);
});

test('security N11: the prior line is the whole line: a remark after it, a fence or another case is no prior line', async () => {
  for (const prior of ['prior: 0 fixed, 0 open (B1 is still open)', 'prior: 0 fixed, 0 open, B1 open', '```\nprior: 0 fixed, 0 open\n```', 'Prior: 0 fixed, 0 open']) {
    const run = await runScript(REVIEW, { ...DELTA, priorFindings: [] }, { replies: world({ lens: () => ({ ...clean, prior }) }) });
    assert.equal(run.result.status, 'incomplete', prior);
    assert.match(run.result.text, /returned no `prior: <n> fixed, <m> open` line/);
  }
  const exact = await runScript(REVIEW, { ...DELTA, priorFindings: [] }, { replies: world({ lens: () => ({ ...clean, prior: '  prior: 0 fixed, 0 open\n' }) }) });
  assert.equal(exact.result.status, 'clean', 'space around the line is not a remark');
});

test('review n9: a deltaOf that is the lane\'s HEAD names its cause; any other refusal of review-tier keeps its exit code', async () => {
  const refused = (shaOf) => world({ tier: (at, prompt, reply) => ({ ...reply, exit: 2, sha: shaOf, reviewWorktree: `/scratch/close-2-${shaOf}`, tier: {} }) });
  const atHead = await runScript(REVIEW, { ...DELTA, priorFindings: [] }, { replies: refused(sha(0)) });
  assert.equal(atHead.result.status, 'failed');
  assert.match(atHead.result.text, /^nothing to review: the lane's HEAD a1b2c30 is deltaOf itself, so nothing was committed since the reviewed sha and review-tier refused the empty delta \(exit 2\)\. Pass the sha the last review read, after a fix was committed; for a whole-range review leave deltaOf out\./);
  const other = await runScript(REVIEW, { ...DELTA, priorFindings: [] }, { replies: refused(sha(5)) });
  assert.match(other.result.text, /^review-tier exited 2, so no review set exists/);
});

test('review S3: a prior finding one lens left out and another lens returned again is carried once, as fixed', async () => {
  const RISK = { ...SONNET, model: 'opus', effort: 'max', lens: 'risk' };
  let tierCalls = 0;
  const round = () => tierCalls - 1;
  const replies = [
    { match: /:tier$/, reply: (prompt) => { const at = tierCalls++; return { exit: 0, baseSha: 'ba5e0001', sha: sha(at + 1), reviewWorktree: `/scratch/close-2-${sha(at + 1)}`, tierFile: `/t${at}.json`, tier: { reviews: [SONNET, RISK], fileClasses: {}, ...priorOfTierPrompt(prompt) } }; } },
    // Round 1: this lens counts A open and returns nothing; the risk lens returns A again, and that is fixed.
    { match: /:review:correctness$/, reply: (prompt) => withPriorLine(prompt, round() === 0 ? { findings: [finding('A')], verified: 'r0' } : round() === 1 ? { ...clean, prior: 'prior: 0 fixed, 1 open' } : clean) },
    { match: /:review:risk$/, reply: (prompt) => withPriorLine(prompt, round() === 1 ? { findings: [finding('A')], verified: 'r1', prior: 'prior: 0 fixed, 1 open' } : clean) },
    { match: /:verify:/, reply: { verdicts: [{ id: 'A', real: true, why: 'yes', reviewedSha: 'x', linesMoved: false }] } },
    { match: /:diagnose$/, reply: 'the cause' },
    { match: /:release$/, reply: { exit: 0, tail: '' } },
    { match: /:fix$/, reply: () => ({ branch: 'lane/a', worktree: '/p-wt/fix', sha: sha(tierCalls + 1), tests: {}, deferred: [] }) },
    { match: /:cleanup$/, reply: { exit: 0, tail: '' } },
  ];
  const run = await runScript(REVIEW, ARGS, { replies });
  assert.equal(run.error, null);
  assert.deepEqual(priorLines(callsOf(run, 'close:2:tier')[2].prompt), ['- [blocking] A a.mjs:3: "problem A"'], 'one line for A, so the count review-tier prints is the round\'s');
  assert.equal(run.result.status, 'clean', run.result.text);
  assert.equal(run.result.rounds, 3);
});
