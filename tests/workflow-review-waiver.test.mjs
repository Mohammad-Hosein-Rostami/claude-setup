// Behaviour of home/workflows/review.js added in round 5 (spec section 6, lane W1): the waiver decided at round 0, audit mode on a recorded
// base..tip range, baseSha in the result, and principles and weakened checks in the lens prompts. Agents are scripted by label (see
// workflow-sandbox.mjs); the sibling file workflow-review.test.mjs covers the older behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScript } from './workflow-sandbox.mjs';
import { priorOfTierPrompt, withPriorLine } from './workflow-review-helpers.mjs';

const REVIEW = join(dirname(fileURLToPath(import.meta.url)), '..', 'home', 'workflows', 'review.js');
const BASE_SHA = 'ba5e0001'.padEnd(40, '0');
const TIP = 'a1b2c31'.padEnd(40, '0'); // the sha the first tier call reports
const sha = (n) => `a1b2c3${n}`.padEnd(40, '0');
const lens = (name, model, effort, agent = 'reviewer') => ({ agent, model, effort, lens: name, rules: 'core', brief: 'brief', requiredReading: [], plan: {} });
const CORRECTNESS = lens('correctness', 'sonnet', 'high');
const RISK = lens('risk', 'opus', 'max');
const AUDITOR = lens('audit', 'opus', 'max', 'security-auditor');
const finding = (id) => ({ id, severity: 'blocking', file: 'a.mjs', line: 3, problem: `problem ${id}`, fix: 'fix it', security: false });
const clean = { findings: [], verified: 'read it' };
const ARGS = { row: 'close:2', repo: '/p', base: 'main', range: 'main...HEAD', landing: true, fix: true, branch: 'lane/a', worktree: '/p-wt/a', suite: 'npm test', waiverAt: TIP };
const AUDIT_ARGS = { ...ARGS, waiverAt: undefined, landing: false, fix: false, range: 'main...HEAD', worktree: '/scratch/audit-1', audit: { base: BASE_SHA, tip: TIP } };

/** A review-tier JSON of a tier-1 non-gate landing: the full set, and the waiver's two halves. */
const tierJson = (extra = {}) => ({
  reviews: [CORRECTNESS, RISK, AUDITOR], fileClasses: {}, laneClasses: ['logic'], changedLines: 12, weakened: [], principles: [],
  waivable: { reviews: [CORRECTNESS], audit: [RISK, AUDITOR] }, ...extra,
});

/** Scripted replies: the i-th `:tier` call answers `tiers[i]`; `lenses` maps a lens name to a function of (round). */
function world({ tiers, lenses, bases = [BASE_SHA], found = {}, suite = { exit: 0, tail: 'ok' } }) {
  let tierCalls = 0;
  let fixCalls = 0;
  const round = () => tierCalls - 1;
  return {
    counts: () => ({ tierCalls, fixCalls }),
    replies: [
      { match: /:tier$/, reply: (prompt) => { const at = tierCalls++; return { exit: 0, baseSha: bases[Math.min(at, bases.length - 1)], sha: sha(at + 1), reviewWorktree: `/scratch/close-2-${sha(at + 1).slice(0, 8)}`, tier: { tip: sha(at + 1), ...tiers[Math.min(at, tiers.length - 1)], ...priorOfTierPrompt(prompt) }, ...found }; } },
      ...Object.entries(lenses).map(([name, reply]) => ({ match: new RegExp(`:review:${name}$`), reply: (prompt) => withPriorLine(prompt, reply(round())) })),
      { match: /:verify:/, reply: () => ({ verdicts: [{ id: 'F1', real: true, why: 'yes', reviewedSha: TIP, linesMoved: false }] }) },
      { match: /:release$/, reply: { exit: 0, tail: '' } },
      { match: /:fix$/, reply: () => { fixCalls += 1; return { branch: 'lane/a', worktree: '/p-wt/fix', sha: sha(fixCalls + 1), tests: {}, deferred: [] }; } },
      { match: /:suite$/, reply: suite },
      { match: /:cleanup$/, reply: { exit: 0, tail: '' } },
    ],
  };
}
const everyLens = { correctness: () => clean, risk: () => clean, audit: () => clean };
const labels = (run, pattern) => run.started.filter((label) => pattern.test(label));
const lensLabels = (run) => labels(run, /:review:/).sort();

test('a waived round 0 runs only the waiver lenses, and a clean round 0 returns waived true with the baseSha', async () => {
  const w = world({ tiers: [tierJson()], lenses: everyLens });
  const run = await runScript(REVIEW, ARGS, { replies: w.replies });
  assert.equal(run.error, null);
  assert.deepEqual(lensLabels(run), ['close:2:review:correctness']);
  assert.equal(run.result.status, 'clean');
  assert.equal(run.result.waived, true);
  assert.equal(run.result.baseSha, BASE_SHA);
  assert.equal(run.result.tip, TIP);
});

test('without waiverAt, or with a different sha, or after a delta, the full set runs and waived is false', async () => {
  for (const change of [{ waiverAt: undefined }, { waiverAt: 'deadbee' }, { deltaOf: sha(9), laneClasses: ['logic'], priorFindings: [] }]) {
    const w = world({ tiers: [tierJson()], lenses: everyLens });
    const run = await runScript(REVIEW, { ...ARGS, ...change }, { replies: w.replies });
    assert.deepEqual(lensLabels(run), ['close:2:review:audit', 'close:2:review:correctness', 'close:2:review:risk'], JSON.stringify(change));
    assert.equal(run.result.waived, false, JSON.stringify(change));
  }
});

test('a tier the caller supplied never waives, even with a waivable part and a matching waiverAt', async () => {
  const w = world({ tiers: [tierJson()], lenses: everyLens });
  const run = await runScript(REVIEW, { ...ARGS, tier: tierJson() }, { replies: w.replies });
  assert.equal(lensLabels(run).length, 3);
  assert.equal(run.result.waived, false);
});

test('a tier whose waivable is null does not waive', async () => {
  const w = world({ tiers: [tierJson({ waivable: null })], lenses: everyLens });
  const run = await runScript(REVIEW, ARGS, { replies: w.replies });
  assert.equal(lensLabels(run).length, 3);
  assert.equal(run.result.waived, false);
});

test('a weakened entry blocks the waiver and is listed in every lens prompt as a finding unless the lane spec asks for it', async () => {
  const weakened = [{ path: 'tests/a.test.mjs', line: 7, kind: 'skip' }];
  const w = world({ tiers: [tierJson({ weakened })], lenses: everyLens });
  const run = await runScript(REVIEW, ARGS, { replies: w.replies });
  assert.equal(lensLabels(run).length, 3);
  assert.equal(run.result.waived, false);
  for (const call of run.calls.filter((entry) => /:review:/.test(entry.label))) {
    assert.match(call.prompt, /tests\/a\.test\.mjs:7 skip/);
    assert.match(call.prompt, /each is a finding unless the lane spec asks for it/);
  }
});

test('a waived round 0 with a confirmed finding makes round 1 a whole-range full-set round, never a delta', async () => {
  const w = world({
    tiers: [tierJson()],
    lenses: { correctness: (round) => (round === 0 ? { findings: [finding('F1')], verified: 'x' } : clean), risk: () => clean, audit: () => clean },
  });
  const run = await runScript(REVIEW, ARGS, { replies: w.replies });
  const tiers = run.calls.filter((call) => call.label === 'close:2:tier');
  assert.equal(tiers.length, 2);
  assert.doesNotMatch(tiers[1].prompt, /--delta/);
  assert.match(tiers[1].prompt, /review-tier\.mjs main\.\.\.HEAD --landing --lane-classes logic --json/);
  assert.deepEqual(labels(run, /:review:/).slice(1).sort(), ['close:2:review:audit', 'close:2:review:correctness', 'close:2:review:risk']);
  assert.equal(run.result.status, 'clean');
  assert.equal(run.result.waived, false, 'the lane was escalated, so it is not waived');
});

test('a waived round 0 with a red suite also escalates to the whole range with the full set', async () => {
  let suiteCalls = 0;
  const w = world({ tiers: [tierJson()], lenses: everyLens });
  w.replies.find((entry) => String(entry.match) === String(/:suite$/)).reply = () => ({ exit: suiteCalls++ === 0 ? 1 : 0, tail: 'red' });
  const run = await runScript(REVIEW, ARGS, { replies: w.replies });
  const tiers = run.calls.filter((call) => call.label === 'close:2:tier');
  assert.equal(tiers.length, 2);
  assert.doesNotMatch(tiers[1].prompt, /--delta/);
  assert.equal(run.result.waived, false);
  assert.equal(lensLabels(run).length, 4, 'one waiver lens, then the three of the full set');
});

test('baseSha and tip of the last round are returned', async () => {
  const w = world({
    tiers: [tierJson({ waivable: null })], bases: [BASE_SHA, 'ba5e0002'.padEnd(40, '0')],
    lenses: { correctness: (round) => (round === 0 ? { findings: [finding('F1')], verified: 'x' } : clean), risk: () => clean, audit: () => clean },
  });
  const run = await runScript(REVIEW, ARGS, { replies: w.replies });
  assert.equal(run.result.baseSha, 'ba5e0002'.padEnd(40, '0'));
  assert.equal(run.result.tip, sha(2));
  assert.equal(labels(run, /:tier$/).length, 2);
});

test('a tier answer whose baseSha is not a git sha fails the run', async () => {
  const w = world({ tiers: [tierJson()], lenses: everyLens, found: { baseSha: 'main; rm -rf /' } });
  const run = await runScript(REVIEW, ARGS, { replies: w.replies });
  assert.equal(run.result.status, 'failed');
  assert.match(run.result.text, /baseSha .* is not a full 40-character git sha/);
  assert.equal(labels(run, /:review:/).length, 0);
});

test('the lens prompts list the principles of the args united with the tier principles, ids only when the args have no question', async () => {
  const w = world({ tiers: [tierJson({ principles: ['P1', 'P5'] })], lenses: everyLens });
  const principles = [{ id: 'P1', question: 'Is every path under the repo?' }, { id: 'P9', question: 'Does a timer have a bound?' }];
  const run = await runScript(REVIEW, { ...ARGS, waiverAt: undefined, principles }, { replies: w.replies });
  for (const call of run.calls.filter((entry) => /:review:/.test(entry.label))) {
    assert.match(call.prompt, /answer each yes\/no with file:line in verified; a no is a finding/);
    assert.match(call.prompt, /P1: Is every path under the repo\?/);
    assert.match(call.prompt, /P9: Does a timer have a bound\?/);
    assert.match(call.prompt, /P5(?!:)/);
    assert.equal((call.prompt.match(/P1\b/g) ?? []).length, 1, 'a principle in both lists is named once');
  }
});

test('audit mode runs review-tier on the recorded range, reviews with the audit set, and never fixes or runs the suite', async () => {
  const w = world({ tiers: [tierJson()], lenses: everyLens });
  const run = await runScript(REVIEW, AUDIT_ARGS, { replies: w.replies });
  assert.equal(run.error, null);
  const tier = run.calls.find((call) => call.label === 'close:2:tier');
  assert.match(tier.prompt, new RegExp(`review-tier\\.mjs ${BASE_SHA}\\.\\.${TIP} --landing --json`));
  assert.doesNotMatch(tier.prompt, /main\.\.\.HEAD/, 'the recorded range, not args.range, goes to review-tier');
  for (const call of run.calls.filter((entry) => /:review:/.test(entry.label))) {
    assert.match(call.prompt, new RegExp(`range ${BASE_SHA}\\.\\.${TIP}`));
    assert.doesNotMatch(call.prompt, /main\.\.\.HEAD/);
  }
  assert.deepEqual(lensLabels(run), ['close:2:review:audit', 'close:2:review:risk']);
  assert.equal(labels(run, /:suite$|:fix$/).length, 0);
  assert.equal(run.result.status, 'clean');
  assert.equal(run.result.baseSha, BASE_SHA);
});

test('audit mode reports a finding as findings and does not fix', async () => {
  const w = world({ tiers: [tierJson()], lenses: { risk: () => ({ findings: [finding('F1')], verified: 'x' }), audit: () => clean, correctness: () => clean } });
  const run = await runScript(REVIEW, AUDIT_ARGS, { replies: w.replies });
  assert.equal(run.result.status, 'findings');
  assert.equal(run.result.findings.length, 1);
  assert.equal(labels(run, /:fix$/).length, 0);
});

test('an audit of 0 changed lines, or with an empty set, is failed with "empty audit", never clean', async () => {
  for (const tier of [tierJson({ changedLines: 0 }), tierJson({ waivable: { reviews: [CORRECTNESS], audit: [] } }), tierJson({ changedLines: undefined })]) {
    const w = world({ tiers: [tier], lenses: everyLens });
    const run = await runScript(REVIEW, AUDIT_ARGS, { replies: w.replies });
    assert.equal(run.result.status, 'failed');
    assert.match(run.result.text, /empty audit/);
    assert.equal(labels(run, /:review:/).length, 0);
  }
});

test('an audit whose range is no longer tier 1 non-gate (waivable null) runs the full review set instead of failing (N3)', async () => {
  const w = world({ tiers: [tierJson({ waivable: null })], lenses: everyLens });
  const run = await runScript(REVIEW, AUDIT_ARGS, { replies: w.replies });
  assert.deepEqual(lensLabels(run), ['close:2:review:audit', 'close:2:review:correctness', 'close:2:review:risk']);
  assert.equal(run.result.status, 'clean');
});

test('audit mode refuses a tier reviewed at another sha or based on another base', async () => {
  for (const [found, why] of [[{ sha: 'deadbee'.padEnd(40, '0'), reviewWorktree: '/scratch/close-2-deadbee0' }, /not the audit tip/], [{ baseSha: 'ba5e0009' }, /not the audit base/]]) {
    const w = world({ tiers: [tierJson()], lenses: everyLens, found });
    const run = await runScript(REVIEW, AUDIT_ARGS, { replies: w.replies });
    assert.equal(run.result.status, 'failed', JSON.stringify(found));
    assert.match(run.result.text, why);
    assert.equal(labels(run, /:review:/).length, 0);
  }
});

test('audit mode with fix true, with landing true, or with a base or tip that is not a sha throws', async () => {
  for (const change of [{ fix: true }, { landing: true }, { audit: { base: 'main', tip: TIP } }, { audit: { base: BASE_SHA, tip: 'x; y' } }, { audit: 'B..T' }]) {
    const run = await runScript(REVIEW, { ...AUDIT_ARGS, ...change }, { replies: world({ tiers: [tierJson()], lenses: everyLens }).replies });
    assert.ok(run.error, JSON.stringify(change));
    assert.match(run.error.message, /^review: args\./);
    assert.equal(run.calls.length, 0);
  }
});

test('waiverAt, principles and audit with the wrong type throw', async () => {
  for (const change of [{ waiverAt: 7 }, { principles: 'P1' }, { audit: 7 }]) {
    const run = await runScript(REVIEW, { ...ARGS, ...change }, { replies: [] });
    assert.match(run.error?.message ?? '', /^review: args\./, JSON.stringify(change));
  }
});

test('audit mode throws on deltaOf, tier, waiverAt and initialFindings: each would let a clean audit cover less than the recorded range', async () => {
  for (const change of [{ deltaOf: sha(9) }, { tier: tierJson() }, { waiverAt: TIP }, { initialFindings: [finding('F1')] }]) {
    const run = await runScript(REVIEW, { ...AUDIT_ARGS, ...change }, { replies: world({ tiers: [tierJson()], lenses: everyLens }).replies });
    assert.match(run.error?.message ?? '', /^review: args\.audit cannot be combined with/, JSON.stringify(change));
    assert.equal(run.calls.length, 0);
  }
});

test('a principles entry that is not {id, question} strings throws', async () => {
  for (const principles of [['P1'], [{ id: 'P1' }], [{ id: 'P1', question: 7 }], [null]]) {
    const run = await runScript(REVIEW, { ...ARGS, principles }, { replies: [] });
    assert.match(run.error?.message ?? '', /^review: args\.principles/, JSON.stringify(principles));
  }
});

test('a tier without a weakened list never waives', async () => {
  const w = world({ tiers: [tierJson({ weakened: undefined })], lenses: everyLens });
  const run = await runScript(REVIEW, ARGS, { replies: w.replies });
  assert.equal(lensLabels(run).length, 3);
  assert.equal(run.result.waived, false);
});

test('fix false with a finding in the waived round returns findings and waived false', async () => {
  const w = world({ tiers: [tierJson()], lenses: { correctness: () => ({ findings: [finding('F1')], verified: 'x' }), risk: () => clean, audit: () => clean } });
  const run = await runScript(REVIEW, { ...ARGS, fix: false, landing: false }, { replies: w.replies });
  assert.equal(run.result.status, 'findings');
  assert.equal(run.result.waived, false);
  assert.equal(labels(run, /:fix$/).length, 0);
});
