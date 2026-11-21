// Behaviour of home/workflows/review.js and build.js around the lane start (lane r7-delta, fix round 4: F4 and D7). No runner runs
// `git merge-base` in the lane's repository (a commit-graph forged there moves its answer: security B8); round 0's start is the `base`
// of review-tier's own JSON; a fix round does not rebase; a run that fixes first rebases onto the base tip read before the fix; and the
// start moves to that tip only when the caller recorded the old start and that very tip itself (args.laneStart, args.baseTips).
// The three ancestry tests of the tool are in review-tier-rebased-onto.test.mjs. Agents are scripted by label (workflow-sandbox.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScript } from './workflow-sandbox.mjs';
import { priorOfTierPrompt, withPriorLine } from './workflow-review-helpers.mjs';

const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), '..', 'home', 'workflows');
// build runs its writers and its join as child scripts (split out of build.js, C4), in the same sandbox with the same replies.
const BUILD_CHILDREN = { implement: join(WORKFLOWS, 'implement.js'), join: join(WORKFLOWS, 'join.js') };
const [REVIEW, BUILD] = [join(WORKFLOWS, 'review.js'), join(WORKFLOWS, 'build.js')];
const TOOL = 'node ~/.claude/tools/review-tier/review-tier.mjs';
const ARGS = { row: 'close:2', repo: '/p', base: 'main', range: 'main...HEAD', landing: false, fix: true, branch: 'lane/a', worktree: '/p-wt/a', suite: 'npm test' };
const SONNET = { agent: 'reviewer', model: 'sonnet', effort: 'high', lens: 'correctness', rules: 'core', brief: 'brief', requiredReading: [], plan: {} };
const hex = (prefix) => prefix.padEnd(40, '0'); // a git sha is hex: the scripts check the shape before one goes into a command
const sha = (n) => hex(`a1b2c3${n}`);
// START: where the lane started; TIP: the base tip the `base` step reads; OTHER_TIP: a tip the caller recorded; ROGUE: a sha nobody recorded.
const [START, TIP, OTHER_TIP, ROGUE] = [hex('ba5e0001'), hex('ba5e0002'), hex('ba5e0003'), hex('bad0bad0')];
const finding = (id, extra = {}) => ({ id, severity: 'blocking', file: 'a.mjs', line: 3, problem: `problem ${id}`, fix: 'fix it', security: false, ...extra });
const clean = { findings: [], verified: 'read it' };
const callsOf = (run, label) => run.calls.filter((call) => call.label === label);
// build's land loop: `deltaOf` is the reviewed tip and a conflict is the finding to fix first.
const LAND_LOOP = { ...ARGS, landing: true, deltaOf: sha(1), laneClasses: ['logic'] };
const CONFLICT = finding('conflict-close:2', { file: 'src/a.mjs', line: 0, problem: 'rebasing lane/a onto main conflicts in src/a.mjs' });

/**
 * Scripted replies. The i-th `:tier` call reports sha(firstSha + i), the runner's own `baseSha` (`runnerBase`) and a tier JSON whose
 * `base` is `tierBase(i)` (undefined: a JSON without the field); the `base` step prints TIP; `lens(i)` answers the i-th lens call;
 * every finding a verifier is shown is real; the n-th fix commits sha(2 + n).
 */
function world({ firstSha = 1, tierBase = () => undefined, runnerBase = START, lens = () => clean } = {}) {
  let [tierCalls, lensCalls, fixCalls] = [0, 0, 0];
  const tierOf = (at, prompt) => ({ reviews: [SONNET], fileClasses: {}, ...(tierBase(at) === undefined ? {} : { base: tierBase(at) }), ...priorOfTierPrompt(prompt) });
  return [
    { match: /:tier$/, reply: (prompt) => { const at = tierCalls++; return { exit: 0, baseSha: runnerBase, sha: sha(firstSha + at), reviewWorktree: `/scratch/close-2-${sha(firstSha + at).slice(0, 8)}`, tier: { tip: sha(firstSha + at), ...tierOf(at, prompt) } }; } },
    { match: /:review:correctness$/, reply: (prompt) => withPriorLine(prompt, lens(lensCalls++)) },
    { match: /:verify:/, reply: (prompt) => ({ verdicts: [...prompt.matchAll(/^- \[[a-z-]+\] (\S+) /gm)].map(([, id]) => ({ id, real: true, why: 'yes', reviewedSha: 'x', linesMoved: false })) }) },
    { match: /:base$/, reply: { exit: 0, tail: `${TIP}\n` } },
    { match: /:release$/, reply: { exit: 0, tail: '' } },
    { match: /:fix$/, reply: () => ({ branch: 'lane/a', worktree: '/p-wt/fix', sha: sha(2 + fixCalls++), tests: {}, deferred: [] }) },
    { match: /:suite$/, reply: { exit: 0, tail: 'ok' } },
    { match: /:cleanup$/, reply: { exit: 0, tail: '' } },
  ];
}

test('F4 (security B8): no prompt asks for git merge-base; the lane start is the base review-tier printed for round 0, and a fix round does not rebase', async () => {
  const lens = (at) => (at === 0 ? { findings: [finding('F1')], verified: 'x' } : clean);
  const run = await runScript(REVIEW, ARGS, { replies: world({ tierBase: () => START, runnerBase: ROGUE, lens }) });
  assert.equal(run.error, null);
  assert.equal(run.result.status, 'clean', run.result.text);
  for (const call of run.calls) assert.doesNotMatch(call.prompt ?? '', /merge-base/, call.label);
  const [first, second] = callsOf(run, 'close:2:tier');
  assert.match(first.prompt, /Also report baseSha: the `base` field of that JSON/);
  assert.ok(second.prompt.includes(`${TOOL} --delta ${sha(1)} --base ${START} --prior `), second.prompt);
  assert.deepEqual([run.result.laneStart, run.result.baseSha], [START, START], 'what the tool printed, not the sha the runner reported beside it');
  assert.doesNotMatch(callsOf(run, 'close:2:fix')[0].prompt, /git rebase/, 'the lane is rebased when it lands');
  assert.equal(callsOf(run, 'close:2:base').length, 0, 'a run that does not fix first asks nothing of the base branch');
});

test('D7: a run that fixes first rebases onto the base tip read before the fix, and the start moves there only when the caller recorded that very tip', async () => {
  const cases = [
    { baseTips: [OTHER_TIP, TIP], tierBase: TIP, command: `--base ${START} --rebased-onto ${TIP} --prior `, laneStart: TIP },
    { baseTips: [OTHER_TIP], tierBase: START, command: `--base ${START} --prior `, laneStart: START }, // the base ref names a commit this build never landed
    { baseTips: [], tierBase: undefined, command: `--base ${START} --prior `, laneStart: START },
  ];
  for (const { baseTips, tierBase, command, laneStart } of cases) {
    const run = await runScript(REVIEW, { ...LAND_LOOP, initialFindings: [CONFLICT], laneStart: START, baseTips }, { replies: world({ firstSha: 2, tierBase: () => tierBase }) });
    assert.equal(run.result.status, 'clean', run.result.text);
    assert.deepEqual(run.started.slice(0, 4), ['close:2:base', 'close:2:release', 'close:2:fix', 'close:2:tier'], 'the base tip is read before the fix agent works');
    assert.ok(callsOf(run, 'close:2:fix')[0].prompt.includes(`\`git switch lane/a && git rebase ${TIP}\``), 'onto the sha, never onto the branch name');
    const [tier] = callsOf(run, 'close:2:tier');
    assert.ok(tier.prompt.includes(`${TOOL} --delta ${sha(1)} ${command}`), tier.prompt);
    assert.doesNotMatch(tier.prompt, /<the lane start>|merge-base/);
    assert.equal(run.result.laneStart, laneStart, JSON.stringify(baseTips));
  }
});

test('D7: a tier JSON that starts the lane anywhere but the recorded start or the base tip the command named ends the run failed', async () => {
  for (const [baseTips, tierBase] of [[[TIP], ROGUE], [[OTHER_TIP], TIP]]) {
    const run = await runScript(REVIEW, { ...LAND_LOOP, initialFindings: [CONFLICT], laneStart: START, baseTips }, { replies: world({ firstSha: 2, tierBase: () => tierBase }) });
    assert.equal(run.result.status, 'failed', tierBase);
    assert.ok(run.result.text.includes(`the tier JSON starts the lane at ${tierBase}, which is neither the lane start ${START} nor a base tip the command named`), run.result.text);
    assert.equal(callsOf(run, 'close:2:review:correctness').length, 0, 'no lens reads a round that was not run as written');
  }
});

test('D7: a delta run that does not fix first reads the base tip only when the caller gave its own record of the tips', async () => {
  const recorded = await runScript(REVIEW, { ...LAND_LOOP, priorFindings: [], laneStart: START, baseTips: [TIP] }, { replies: world({ firstSha: 2, tierBase: () => TIP }) });
  assert.equal(recorded.result.status, 'clean', recorded.result.text);
  assert.deepEqual(recorded.started.slice(0, 2), ['close:2:base', 'close:2:tier']);
  assert.ok(callsOf(recorded, 'close:2:tier')[0].prompt.includes(`--base ${START} --rebased-onto ${TIP} --prior `), 'a lane that land rebased');
  assert.equal(recorded.result.laneStart, TIP);

  const startOnly = await runScript(REVIEW, { ...LAND_LOOP, priorFindings: [], laneStart: START }, { replies: world({ firstSha: 2 }) });
  assert.equal(callsOf(startOnly, 'close:2:base').length, 0);
  assert.ok(callsOf(startOnly, 'close:2:tier')[0].prompt.includes(`--base ${START} --prior `));
  assert.equal(startOnly.result.laneStart, START);

  const noRecord = await runScript(REVIEW, { ...LAND_LOOP, priorFindings: [] }, { replies: world({ firstSha: 2, tierBase: () => START }) });
  const [tier] = callsOf(noRecord, 'close:2:tier');
  assert.ok(tier.prompt.includes(`The lane start is the \`base\` field of the JSON that \`${TOOL} main...${sha(1)} --json\` prints`), tier.prompt);
  assert.ok(tier.prompt.includes('--base <the lane start> --prior '));
  assert.doesNotMatch(tier.prompt, /merge-base/);
  assert.equal(noRecord.result.laneStart, START, 'the start the tier JSON says it took');
});

test('laneStart and baseTips are refused before anything runs: a name, a short sha, tips without a start, and either without deltaOf', async () => {
  const refused = [
    [{ laneStart: 'main' }, /args\.laneStart must be the full 40-character sha the lane started from/],
    [{ laneStart: START.slice(0, 12) }, /args\.laneStart must be the full 40-character sha/],
    [{ baseTips: [TIP] }, /args\.baseTips must hold full 40-character shas and comes with args\.laneStart/],
    [{ laneStart: START, baseTips: [TIP, 'main'] }, /args\.baseTips must hold full 40-character shas/],
  ];
  for (const [extra, why] of refused) {
    const run = await runScript(REVIEW, { ...LAND_LOOP, priorFindings: [], ...extra }, { replies: world() });
    assert.equal(run.result.status, 'failed', JSON.stringify(extra));
    assert.match(run.result.text, why);
    assert.deepEqual(run.started, [], 'nothing starts');
  }
  for (const extra of [{ laneStart: START }, { laneStart: START, baseTips: [TIP] }]) {
    const run = await runScript(REVIEW, { ...ARGS, ...extra }, { replies: world() });
    assert.match(run.error?.message ?? '', /^review: args\.laneStart belongs to a deltaOf run/, JSON.stringify(extra));
  }
});

test('build gives a land-loop review the start its first review recorded and its own base tips: the tip at its start and each sha it landed', async () => {
  const LANDED = hex('1a4ded0a');
  const key = (label) => label.split(':')[0].replace('impl-', '');
  const lane = (name) => ({ row: `impl-${name}`, closeRow: `close-${name}`, branch: `lane/${name}`, spec: '/spec.md', files: [`${name}.mjs`], acceptanceTests: false, implementer: { model: 'sonnet', effort: 'medium' } });
  const replies = [
    { match: /:disk$/, reply: { exit: 0, tail: 'ok    disk free 80.0 GB', baseTip: TIP, sessionBranch: 'main', sessionHead: TIP } }, // r9-wf-guards: started from the base checkout
    { match: /:implement$/, reply: (prompt, opts, call) => ({ branch: `lane/${key(call.label)}`, worktree: `/wt/${key(call.label)}`, sha: `s-${key(call.label)}`, tests: { cmd: 't', exit: 0 }, tier: {} }) },
    { match: /:join$/, reply: (prompt, opts, call) => ({ red: false, tail: 'green', sha: `j-${key(call.label)}`, worktree: `/wt/${key(call.label)}`, vacuous: [], outOfScope: [], contractTouched: [], checkpoints: [] }) },
  ];
  for (const start of [{ laneStart: START }, {}]) {
    const reviews = [];
    const review = (args) => { reviews.push(args); return { status: 'clean', rounds: 1, tip: sha(reviews.length), worktree: args.worktree, laneClasses: ['logic'], suite: 'pass', findings: [], optional: [], leadList: [], text: '', ...start }; };
    let landTries = 0;
    // The first lane lands, the second needs a re-review after land rebased it, then lands.
    const land = () => ((landTries += 1) === 2 ? { status: 'needs-review', sha: 'x', patchesChanged: 2, tidy: '' } : { status: 'landed', sha: landTries === 1 ? LANDED : hex('1a4ded0b'), patchesChanged: 0, tidy: 'clean' });
    const run = await runScript(BUILD, { base: 'main', repo: '/p', suite: 'npm test', writers: 4, statusFile: '/p/STATUS.md', scriptsDir: '/scripts', lanes: [lane('a'), lane('b')] }, { replies, children: { ...BUILD_CHILDREN, review, land } });
    assert.equal(run.error, null);
    assert.deepEqual(run.result.lanes.map(({ status }) => status), ['landed', 'landed']);
    assert.match(callsOf(run, 'impl-a:disk')[0].prompt, /Then run: git -C \/p rev-parse --verify refs\/heads\/main\./, 'the base tip is read once, before any lane is built');
    const [again] = reviews.filter((args) => args.deltaOf !== undefined);
    if (start.laneStart === undefined) assert.deepEqual(['laneStart' in again, 'baseTips' in again], [false, false], 'no recorded start: the child reads it through review-tier and never moves it');
    else assert.deepEqual([again.laneStart, [...again.baseTips]], [START, [TIP, LANDED]], 'a base ref moved by anyone else is in neither list');
  }
});
