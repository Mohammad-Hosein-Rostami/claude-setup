// Tests for home/workflows/bugfix.js: reproduce, parallel hypotheses, early fix, judge, verify, review and land children.
// Exports: none (node:test file). Runs the script against the stubbed runtime of tests/workflow-more-helpers.mjs.
// Invariants: expected orders come from the spec (section 7 `bugfix`): the fix may start while other hypotheses still
// run, but verify, review and land wait for every hypothesis and for the judge on 0 or 2+ confirmed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScript } from './workflow-more-helpers.mjs';

const ARGS = {
  row: 'b1', closeRow: 'close:b1', statusFile: '/s/STATUS.md', repo: '/r', base: 'main',
  symptom: 'parse() throws on empty input', suite: 'node --test tests/*.test.mjs', scriptsDir: '/w',
};
const HYPOTHESES = { hypotheses: ['h1', 'h2', 'h3'].map((id) => ({ id, claim: `claim ${id}`, observation: `look at ${id}` })) };
const REPRO = { reproduces: true, cmd: 'node --test t.mjs', exit: 1, branch: 'lane/b1', worktree: '/wt/b1', sha: 'a1', tail: 'fail' };
const FIX = { branch: 'lane/b1', worktree: '/wt/b2', sha: 'b1', tests: { cmd: 'node --test t.mjs', exit: 0 }, tier: {} };
const VERIFIED = { reproGreen: true, relatedExit: 0, mutantKilled: true, treeClean: true, tail: '' };
const LANDED = { status: 'landed', sha: 'c1', patchesChanged: 0, tidy: 'clean' };
const NO = (id) => ({ id, confirmed: false, rootCause: '', evidence: '', minimalFix: '' });
const YES = (id) => ({ id, confirmed: true, rootCause: `cause ${id}`, evidence: 'file:1', minimalFix: `fix ${id}` });

function replies(overrides = []) {
  return [
    ...overrides,
    { label: /:reproduce/, reply: REPRO },
    { label: /:hypotheses/, reply: HYPOTHESES },
    { label: /:probe:h1/, reply: YES('h1') },
    { label: /:probe:h2/, reply: NO('h2') },
    { label: /:probe:h3/, reply: NO('h3') },
    { label: /:judge/, reply: { found: true, hypothesisId: 'h1', rootCause: 'cause h1', minimalFix: 'fix h1' } },
    { label: /:(release|status)/, reply: 'ok' },
    { label: /:fix:/, reply: FIX },
    { label: /:verify/, reply: VERIFIED },
  ];
}

const CHILDREN = { 'review.js': { clean: true }, 'land.js': LANDED };

test('bugfix: the fix starts while a slower hypothesis still runs, review waits for every hypothesis', async () => {
  const slow = async (_call, ctx) => { await ctx.started(/:fix:/); return NO('h3'); };
  const run = await runScript('bugfix', ARGS, { replies: replies([{ label: /:probe:h3/, reply: slow }]), children: CHILDREN });
  assert.equal(run.error, null);
  const at = (event) => run.events.indexOf(event);
  assert.ok(at('start:b1:fix:early') < at('end:b1:probe:h3'), 'the early fix starts before the slowest probe returns');
  assert.ok(at('end:b1:probe:h3') < at('start:b1:verify'), 'verify waits for every hypothesis');
  assert.ok(at('start:b1:verify') < at('child:review.js') && at('child:review.js') < at('child:land.js'));
  assert.deepEqual(run.result, { status: 'landed', sha: 'c1', tidy: 'clean' });
  assert.equal(run.calls.some((c) => /:judge/.test(c.label)), false, 'exactly one confirmed: no judge');
});

test('bugfix: two confirmed hypotheses go to the judge; a root cause other than the early fix is redone', async () => {
  const run = await runScript('bugfix', ARGS, {
    replies: replies([
      { label: /:fix:early/, reply: async (_call, ctx) => { await ctx.started(/:judge/); await new Promise(setImmediate); return FIX; } },
      { label: /:probe:h2/, reply: YES('h2') },
      { label: /:judge/, reply: { found: true, hypothesisId: 'h2', rootCause: 'cause h2', minimalFix: 'fix h2' } },
    ]),
    children: CHILDREN,
  });
  const at = (event) => run.events.indexOf(event);
  assert.ok(at('end:b1:probe:h3') < at('start:b1:judge') && at('end:b1:judge') < at('start:b1:verify'));
  const judge = run.calls.find((c) => /:judge/.test(c.label));
  assert.deepEqual([judge.model, judge.effort], ['opus', 'xhigh']);
  assert.ok(at('end:b1:fix:early') >= 0, 'the early fix finished before the workflow returned');
  assert.ok(at('end:b1:fix:early') < at('start:b1:fix:redo'), 'one writer at a time on the lane');
  assert.ok(at('end:b1:fix:redo') < at('start:b1:verify'));
  assert.match(run.calls.find((c) => /:fix:redo/.test(c.label)).prompt, /revert/i);
});

test('bugfix: zero confirmed goes to the judge; a judge with no root cause escalates to the next effort', async () => {
  let round = 0;
  const hypotheses = () => { round += 1; return HYPOTHESES; };
  const run = await runScript('bugfix', ARGS, {
    replies: replies([
      { label: /:hypotheses/, reply: hypotheses },
      { label: /:probe:h1/, reply: () => (round === 1 ? NO('h1') : YES('h1')) },
      { label: /:judge/, reply: { found: false, hypothesisId: '', rootCause: '', minimalFix: '' } },
    ]),
    children: CHILDREN,
  });
  const efforts = run.calls.filter((c) => /:hypotheses/.test(c.label)).map((c) => c.effort);
  assert.deepEqual(efforts, ['high', 'xhigh']);
  assert.equal(run.calls.filter((c) => /:judge/.test(c.label)).length, 1);
  assert.equal(run.result.status, 'landed');
});

test('bugfix: a failed verify retries with new hypotheses at xhigh, then max, then returns unresolved', async () => {
  const run = await runScript('bugfix', ARGS, {
    replies: replies([{ label: /:verify/, reply: { ...VERIFIED, mutantKilled: false } }]),
    children: CHILDREN,
  });
  const efforts = run.calls.filter((c) => /:hypotheses/.test(c.label)).map((c) => c.effort);
  assert.deepEqual(efforts, ['high', 'xhigh', 'max']);
  assert.equal(run.result.status, 'unresolved');
  assert.deepEqual(run.children, [], 'nothing is reviewed or landed');
});

test('bugfix: a land conflict sends an implementer, then the delta goes back to review before landing again', async () => {
  const answers = [{ status: 'conflict', sha: '', patchesChanged: 0, tidy: '' }, { status: 'needs-review', sha: '', patchesChanged: 2, tidy: '' }, LANDED];
  const run = await runScript('bugfix', ARGS, { replies: replies(), children: { 'review.js': { clean: true }, 'land.js': () => answers.shift() } });
  assert.equal(run.result.status, 'landed');
  assert.deepEqual(run.children.map((c) => c.file), ['review.js', 'land.js', 'review.js', 'land.js', 'review.js', 'land.js']);
  assert.equal(run.calls.filter((c) => /:fix:conflict/.test(c.label)).length, 1);
});

test('bugfix: a review that returns nothing stops before land', async () => {
  const run = await runScript('bugfix', ARGS, { replies: replies(), children: { 'review.js': null, 'land.js': LANDED } });
  assert.equal(run.result.status, 'review-failed');
  assert.deepEqual(run.children.map((c) => c.file), ['review.js']);
});

test('bugfix: a bug that does not reproduce stops before any hypothesis', async () => {
  const run = await runScript('bugfix', ARGS, { replies: replies([{ label: /:reproduce/, reply: { ...REPRO, reproduces: false } }]), children: CHILDREN });
  assert.equal(run.result.status, 'not-reproduced');
  assert.equal(run.calls.some((c) => /:hypotheses/.test(c.label)), false);
});

test('bugfix: a given repro command runs in a runner, a missing one makes an implementer write the failing test', async () => {
  const given = await runScript('bugfix', { ...ARGS, repro: 'node t.mjs' }, { replies: replies(), children: CHILDREN });
  const written = await runScript('bugfix', ARGS, { replies: replies(), children: CHILDREN });
  assert.equal(given.calls.find((c) => /:reproduce/.test(c.label)).agentType, 'runner');
  assert.equal(written.calls.find((c) => /:reproduce/.test(c.label)).agentType, 'implementer');
});

test('bugfix: every agent call names a row label, a phase listed in meta, a model and an effort; no push anywhere', async () => {
  const run = await runScript('bugfix', ARGS, { replies: replies(), children: CHILDREN });
  const phases = run.meta.phases.map((p) => p.title);
  for (const call of run.calls) {
    assert.match(call.label, /^b1:/, call.label);
    assert.ok(phases.includes(call.phase), `${call.label}: phase ${call.phase}`);
    assert.ok(call.model && call.effort, `${call.label}: model and effort`);
    assert.doesNotMatch(call.prompt, /git push/, call.label);
  }
  const status = run.calls.filter((c) => /:status/.test(c.label)).map((c) => c.prompt);
  assert.ok(status.some((p) => p.includes('done b1')), 'row done after verify');
  assert.ok(status.some((p) => p.includes('start close:b1')), 'close row started before review');
});

test('bugfix: a bad args object throws the named error before any agent starts', async () => {
  const { symptom, ...missing } = ARGS;
  const run = await runScript('bugfix', missing, { replies: replies(), children: CHILDREN });
  assert.equal(run.error.message, 'bugfix: args.symptom must be string');
  assert.equal(run.calls.length, 0);
});
