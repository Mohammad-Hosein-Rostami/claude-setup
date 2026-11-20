// Behaviour of home/workflows/review.js in a delta round (lane r7-delta, decision D3): the prior findings go to review-tier as a file,
// every lens verifies each of them and returns `prior: <n> fixed, <m> open`, and a round is clean only when m is 0 and n + m is the
// number the tool counted. Agents are scripted by label (workflow-sandbox.mjs); workflow-review.test.mjs covers the rest.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScript } from './workflow-sandbox.mjs';
import { priorOfTierPrompt, withPriorLine } from './workflow-review-helpers.mjs';

const REVIEW = join(dirname(fileURLToPath(import.meta.url)), '..', 'home', 'workflows', 'review.js');
const ARGS = { row: 'close:2', repo: '/p', base: 'main', range: 'main...HEAD', landing: false, fix: true, branch: 'lane/a', worktree: '/p-wt/a', suite: 'npm test' };
const SONNET = { agent: 'reviewer', model: 'sonnet', effort: 'high', lens: 'correctness', rules: 'core', brief: 'brief', requiredReading: [], plan: {} };
const OPUS = { agent: 'reviewer', model: 'opus', effort: 'max', lens: 'risk', rules: 'core', brief: 'brief', requiredReading: [], plan: {} };
const finding = (id, extra = {}) => ({ id, severity: 'blocking', file: 'a.mjs', line: 3, problem: `problem ${id}`, fix: 'fix it', security: false, ...extra });
const sha = (n) => `a1b2c3${n}`;
const found = (...items) => ({ findings: items, verified: 'x' });
const clean = { findings: [], verified: 'read it' };

/**
 * Round 0: the correctness lens finds F1 (should-fix) and the risk lens O1 (blocking), both confirmed and fixed. Round 1 is the delta
 * round: `second` maps a lens name to its reply there (default: a clean reply with a correct prior line); `tierPrior` replaces what the
 * tier runner reports as review-tier's `prior`.
 */
async function deltaRound({ second = {}, tierPrior, args = {} } = {}) {
  let tierCalls = 0;
  const lensReply = (name, first) => ({ match: new RegExp(`:review:${name}$`), reply: (prompt) => (tierCalls === 1 ? first : second[name] !== undefined ? second[name] : withPriorLine(prompt, clean)) });
  const replies = [
    { match: /:tier$/, reply: (prompt) => { const at = tierCalls++; return { exit: 0, baseSha: 'ba5e0001', sha: sha(at + 1), reviewWorktree: `/scratch/close-2-${sha(at + 1)}`, tierFile: `/t${at}.json`, tier: { reviews: [SONNET, OPUS], fileClasses: {}, ...(tierPrior === undefined ? priorOfTierPrompt(prompt) : tierPrior) } }; } },
    lensReply('correctness', found(finding('F1', { severity: 'should-fix', problem: 'first line\nsecond line' }))),
    lensReply('risk', found(finding('O1'))),
    { match: /:verify:/, reply: (prompt) => ({ verdicts: ['F1', 'O1'].filter((id) => prompt.includes(`] ${id} `)).map((id) => ({ id, real: true, why: 'yes', reviewedSha: sha(1), linesMoved: false })) }) },
    { match: /:release$/, reply: { exit: 0, tail: '' } },
    { match: /:fix$/, reply: { branch: 'lane/a', worktree: '/p-wt/fix', sha: sha(2), tests: {}, deferred: [] } },
    { match: /:cleanup$/, reply: { exit: 0, tail: '' } },
  ];
  const run = await runScript(REVIEW, { ...ARGS, ...args }, { replies });
  assert.equal(run.error, null);
  return run;
}
const callsOf = (run, label) => run.calls.filter((call) => call.label === label);

test('a delta round hands review-tier the prior findings as a file: one line per finding with its severity, no fixed or open claim', async () => {
  const run = await deltaRound();
  const [first, second] = callsOf(run, 'close:2:tier');
  assert.doesNotMatch(first.prompt, /--prior/, 'round 0 reads the whole range: no prior file');
  assert.match(second.prompt, /review-tier\.mjs --delta a1b2c31 --prior <the prior findings file> --lane-classes \/t0\.json --json/);
  assert.match(second.prompt, /write the prior findings file \$\{TMPDIR:-\/tmp\}\/close-2-prior-<sha8>\.md \(give review-tier its absolute path\) with exactly these 2 lines/);
  assert.ok(second.prompt.includes('- [blocking] O1 a.mjs:3: problem O1\n'), second.prompt);
  assert.ok(second.prompt.includes('- [should-fix] F1 a.mjs:3: first line second line\n'), 'a finding stays one line, so the tool counts it once');
  assert.doesNotMatch(second.prompt, /\[fixed\]|\[open\]/, 'the file holds the findings, not the fix agent\'s claim');
});

test('every lens of a delta round gets every prior finding, the file with its hash and count, and is asked for the prior line', async () => {
  const run = await deltaRound();
  assert.equal(run.result.status, 'clean');
  assert.equal(run.result.rounds, 2);
  for (const name of ['correctness', 'risk']) {
    const [first, second] = callsOf(run, `close:2:review:${name}`);
    assert.doesNotMatch(first.prompt, /Prior findings/);
    assert.ok(second.prompt.includes(`Prior findings file: /scratch/close-2-prior.md (sha256 ${'ab'.repeat(32)}; 2 blocking or should-fix findings)`), second.prompt);
    assert.match(second.prompt, /Check the hash before you read it/);
    assert.match(second.prompt, /`fixed` below is the fix agent's claim, never evidence: verify each one yourself in the code at a1b2c32 and return one that is still present again as a finding with its id/);
    assert.match(second.prompt, /In prior, return the line `prior: <n> fixed, <m> open` over those 2 findings/);
    for (const id of ['F1', 'O1']) assert.ok(second.prompt.includes(`] ${id} a.mjs:3`), `${name} gets ${id}`);
  }
});

test('a delta round is not clean when a lens returns no prior line, an open count, or counts that do not add up to the tool\'s', async () => {
  for (const [reply, why] of [
    [clean, /lens risk returned no `prior: <n> fixed, <m> open` line/],
    [{ ...clean, prior: 'prior: all fixed' }, /lens risk returned no `prior: <n> fixed, <m> open` line/],
    [{ ...clean, prior: 'prior: 1 fixed, 1 open' }, /lens risk still sees 1 of the 2 prior findings open/],
    [{ ...clean, prior: 'prior: 1 fixed, 0 open' }, /lens risk counted 1 fixed and 0 open, the prior findings file holds 2/],
    [{ ...clean, prior: 'prior: 3 fixed, 0 open' }, /lens risk counted 3 fixed and 0 open, the prior findings file holds 2/],
  ]) {
    const run = await deltaRound({ second: { risk: reply } });
    assert.equal(run.result.status, 'incomplete', JSON.stringify(reply));
    assert.match(run.result.text, why);
    assert.equal(callsOf(run, 'close:2:tier').length, 2, 'no further round: the lead reads the result');
  }
});

test('with fix:false a delta round with an open prior count is not clean either', async () => {
  let tierCalls = 0;
  const replies = [
    { match: /:tier$/, reply: (prompt) => { tierCalls += 1; return { exit: 0, baseSha: 'ba5e0001', sha: sha(1), reviewWorktree: `/scratch/close-2-${sha(1)}`, tierFile: '/t0.json', tier: { reviews: [SONNET], fileClasses: {}, ...priorOfTierPrompt(prompt) } }; } },
    { match: /:review:correctness$/, reply: { ...clean, prior: 'prior: 0 fixed, 0 open' } },
    { match: /:cleanup$/, reply: { exit: 0, tail: '' } },
  ];
  const good = await runScript(REVIEW, { ...ARGS, fix: false, deltaOf: sha(0) }, { replies });
  assert.equal(good.result.status, 'clean', good.result.text);
  assert.match(good.calls[0].prompt, /with exactly these 0 lines \(an empty file\)/, 'a delta round with nothing carried still names a report: an empty one');
  replies[1] = { match: /:review:correctness$/, reply: clean };
  const bad = await runScript(REVIEW, { ...ARGS, fix: false, deltaOf: sha(0) }, { replies });
  assert.equal(bad.result.status, 'incomplete');
  assert.equal(tierCalls, 2);
});

test('a tier whose prior count is not the number of findings the round carries ends the run failed before any lens starts', async () => {
  for (const tierPrior of [{}, { prior: { file: '/scratch/close-2-prior.md', sha256: 'ab'.repeat(32), blocking: 1, shouldFix: 0, findings: 1 } }, { prior: { file: '/scratch/x y.md', sha256: 'ab'.repeat(32), findings: 2 } }, { prior: { file: '/scratch/p.md', sha256: 'nope', findings: 2 } }]) {
    let delta = false;
    const run = await deltaRoundWithTier(tierPrior, () => { delta = true; });
    assert.equal(run.result.status, 'failed', JSON.stringify(tierPrior));
    assert.match(run.result.text, /prior findings file/);
    assert.equal(delta, false, 'no lens of the delta round started');
  }
});

/** As deltaRound, but only the delta round's tier reports `tierPrior`; `onDeltaLens` is called when a lens of that round starts. */
async function deltaRoundWithTier(tierPrior, onDeltaLens) {
  let tierCalls = 0;
  const lens = (name, first) => ({ match: new RegExp(`:review:${name}$`), reply: () => { if (tierCalls > 1) onDeltaLens(); return first; } });
  const replies = [
    { match: /:tier$/, reply: () => { const at = tierCalls++; return { exit: 0, baseSha: 'ba5e0001', sha: sha(at + 1), reviewWorktree: `/scratch/close-2-${sha(at + 1)}`, tierFile: `/t${at}.json`, tier: { reviews: [SONNET, OPUS], fileClasses: {}, ...(at === 0 ? {} : tierPrior) } }; } },
    lens('correctness', found(finding('F1'))),
    lens('risk', found(finding('O1'))),
    { match: /:verify:/, reply: (prompt) => ({ verdicts: ['F1', 'O1'].filter((id) => prompt.includes(`] ${id} `)).map((id) => ({ id, real: true, why: 'yes', reviewedSha: sha(1), linesMoved: false })) }) },
    { match: /:release$/, reply: { exit: 0, tail: '' } },
    { match: /:fix$/, reply: { branch: 'lane/a', worktree: '/p-wt/fix', sha: sha(2), tests: {}, deferred: [] } },
    { match: /:cleanup$/, reply: { exit: 0, tail: '' } },
  ];
  return runScript(REVIEW, ARGS, { replies });
}

test('the final verdict field still works: a lens returns findings and verified as before, and prior is asked only in a delta round', async () => {
  const run = await deltaRound();
  const [first, second] = callsOf(run, 'close:2:review:correctness');
  for (const call of [first, second]) {
    assert.deepEqual(call.opts.schema.required, ['findings', 'verified'], 'the schema every lens answers is unchanged in what it requires');
    assert.match(call.prompt, /Return findings \(severity blocking\|should-fix\|optional; security true for an exploitable or secret\/auth\/injection\/data issue\) and, in verified, what you ran or read\./);
  }
  assert.equal(first.opts.schema.properties.prior.type, 'string');
  assert.doesNotMatch(first.prompt, /In prior, return the line/);
});

test('a landing delta round whose tier names no lens still re-checks an open item it carries: the empty-set stop counts carried items', async () => {
  let tierCalls = 0;
  const replies = [
    { match: /:tier$/, reply: (prompt) => { const at = tierCalls++; return { exit: 0, baseSha: 'ba5e0001', sha: sha(at + 1), reviewWorktree: `/scratch/close-2-${sha(at + 1)}`, tierFile: `/t${at}.json`, tier: { reviews: at === 0 ? [SONNET] : [], fileClasses: {}, ...priorOfTierPrompt(prompt) } }; } },
    { match: /:review:correctness$/, reply: (prompt) => (tierCalls === 1 ? found(finding('F1')) : withPriorLine(prompt, clean)) },
    // The verifier confirms F1 but a fix already moved its lines: it is carried as an open item, and nothing is fixed in round 0.
    { match: /:verify:/, reply: { verdicts: [{ id: 'F1', real: true, why: 'yes', reviewedSha: sha(1), linesMoved: true }] } },
    { match: /:suite$/, reply: { exit: 0, tail: 'ok' } },
    { match: /:cleanup$/, reply: { exit: 0, tail: '' } },
  ];
  const run = await runScript(REVIEW, { ...ARGS, landing: true }, { replies });
  assert.equal(run.error, null);
  assert.equal(run.result.status, 'clean', run.result.text);
  const again = callsOf(run, 'close:2:review:correctness')[1];
  assert.ok(again, 'the lens that found the open item runs again although the delta tier named no lens');
  assert.match(again.prompt, /\[open\] F1 a\.mjs:3/);
});
