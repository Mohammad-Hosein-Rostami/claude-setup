// Behaviour of home/workflows/build.js added by round 5 (spec section 6, lane W2): lane contracts (principles, checkpoints, addClasses),
// the file-overlap check, the join's red-first checkpoints judged by exit code, locked contract files (`contract-touched`), land `red`,
// and the `auditLane` stage that runs after the land. Children and agents are scripted; no tool log is written (the audit-log CLI is only named
// in runner prompts, never run).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertWellFormedCalls, readMeta, runScript } from './workflow-sandbox.mjs';

const BUILD = join(dirname(fileURLToPath(import.meta.url)), '..', 'home', 'workflows', 'build.js');
const META = readMeta(readFileSync(BUILD, 'utf8')).meta;
const BASE_SHA = 'b1b1b1b1';
const TIP = 'a1a1a1a1';
const LANDED = 'c1c1c1c1';
const CHECKPOINT = { id: 'c1', run: 'node --test tests/a.test.mjs', exit: 0, files: ['tests/a.test.mjs'], kind: 'red-first' };
const lane = (name, extra = {}) => ({ row: `impl-${name}`, closeRow: `close-${name}`, branch: `lane/${name}`, spec: '/spec.md', files: [`${name}.mjs`], acceptanceTests: false, implementer: { model: 'sonnet', effort: 'medium' }, ...extra });
const contractLane = (extra = {}) => lane('a', { acceptanceTests: true, checkpoints: [CHECKPOINT], principles: [{ id: 'P1', question: 'is every read path trusted?' }], addClasses: ['audit'], ...extra });
const ARGS = (lanes, extra = {}) => ({ base: 'main', repo: '/p', suite: 'npm test', writers: 4, statusFile: '/p/STATUS.md', scriptsDir: '/scripts', lanes, ...extra });
const built = (name) => ({ branch: `lane/${name}`, worktree: `/wt/${name}`, sha: `s-${name}`, tests: { cmd: 't', exit: 0 }, tier: {} });
const checkpointResult = (extra = {}) => ({ id: 'c1', baseExit: 1, headExit: 0, tail: '', ...extra });
const joined = (name, extra = {}) => ({ red: false, tail: 'green', sha: `j-${name}`, worktree: `/wt/${name}`, vacuous: [], outOfScope: [], contractTouched: [], checkpoints: [checkpointResult()], ...extra });
const reviewedClean = (name, extra = {}) => ({ status: 'clean', rounds: 1, tip: TIP, baseSha: BASE_SHA, waived: true, worktree: `/wt/${name}`, tierFile: `/t-${name}.json`, suite: 'pass', findings: [], optional: [], leadList: [], text: '', ...extra });
const landedOk = (extra = {}) => ({ status: 'landed', sha: LANDED, patchesChanged: 0, tidy: 'clean', ...extra });
const TESTS = { match: /:tests$/, reply: { branch: 'lane/a--tests', worktree: '/wt/a-tests', sha: 'tw1' } };
const slugOf = (label) => label.split(':')[0];
const buildReplies = (joinReply, extra = []) => [
  ...extra,
  { match: /:disk$/, reply: { exit: 0, tail: 'ok    disk free 80.0 GB' } },
  { match: /:implement$/, reply: (p, o, call) => built(slugOf(call.label).replace('impl-', '')) },
  TESTS,
  { match: /:join$/, reply: joinReply },
];
const AUDIT_REPLIES = (overrides = {}) => [
  ...Object.entries(overrides).map(([name, reply]) => ({ match: new RegExp(`:audit-${name}$`), reply })),
  { match: /:audit-decide$/, reply: { recordExit: 0, shouldExit: 0, audit: true, reason: 'calibration', tail: '' } },
  { match: /:audit-prepare$/, reply: (prompt) => ({ ancestor: true, changedLines: 12, worktree: `/scratch/${/named (audit-\S+)/.exec(prompt)[1]}`, tail: '' }) },
  { match: /:audit-(finish|sampled|error)$/, reply: { exit: 0, tail: '' } },
];
const audited = (overrides = {}) => ({ status: 'clean', rounds: 1, tip: TIP, worktree: '/scratch/w', tierFile: '', suite: 'pass', findings: [], optional: [], leadList: [], text: '', ...overrides });
/** Runs one contract lane to the end; `reviewChild(args)` answers the landing review and the audit review, `land(args, tries)` the land child. */
const runContract = (laneObject, { join = joined('a'), review, land = () => landedOk(), replies = [] } = {}) => {
  let tries = 0;
  return runScript(BUILD, ARGS([laneObject]), {
    replies: [...replies, ...buildReplies(join), ...AUDIT_REPLIES()],
    children: { review: review ?? ((a) => (a.audit ? audited() : reviewedClean('a'))), land: (a) => land(a, (tries += 1)) },
  });
};
const call = (run, suffix) => run.calls.find((entry) => entry.label.endsWith(suffix));

test('checkArgs: two lanes that share a file throw unless the file is in appendOnly; a checkpoint may not list a file of its lane', async () => {
  const shared = [lane('a', { files: ['x.mjs', 'docs/catalog.md'] }), lane('b', { files: ['y.mjs', 'docs/catalog.md'] })];
  const refused = await runScript(BUILD, ARGS(shared), { replies: [] });
  assert.match(String(refused.error?.message), /lane\/?.*impl-a.*impl-b.*docs\/catalog\.md|docs\/catalog\.md.*impl-a.*impl-b/);
  assert.equal(refused.calls.length, 0);
  const allowed = await runScript(BUILD, ARGS(shared, { appendOnly: ['docs/catalog.md'] }), { replies: [] });
  assert.doesNotMatch(String(allowed.error?.message), /docs\/catalog\.md/);
  const own = lane('a', { files: ['a.mjs', 'tests/a.test.mjs'], checkpoints: [CHECKPOINT] });
  assert.match(String((await runScript(BUILD, ARGS([own]), { replies: [] })).error?.message), /checkpoint c1.*tests\/a\.test\.mjs|tests\/a\.test\.mjs.*checkpoint c1/);
});

test('checkArgs: a checkpoint needs id, run, exit, files and a known kind; principles need id and question', async () => {
  for (const bad of [{ ...CHECKPOINT, kind: 'maybe' }, { ...CHECKPOINT, exit: '0' }, { ...CHECKPOINT, run: undefined }, { ...CHECKPOINT, files: 'x' }]) {
    const run = await runScript(BUILD, ARGS([lane('a', { checkpoints: [bad] })]), { replies: [] });
    assert.match(String(run.error?.message), /args\.lanes\[0\]\.checkpoints\[0\]/);
  }
  const principles = await runScript(BUILD, ARGS([lane('a', { principles: [{ id: 'P1' }] })]), { replies: [] });
  assert.match(String(principles.error?.message), /args\.lanes\[0\]\.principles\[0\]/);
});

test('the implementer brief carries checkpoints, principle questions, locked files, the dispute line, the no-full-suite rule and the timeouts', async () => {
  const run = await runContract(contractLane());
  const { prompt } = call(run, ':implement');
  assert.match(prompt, /c1.*node --test tests\/a\.test\.mjs.*exit 0.*red-first/s);
  assert.match(prompt, /P1.*is every read path trusted\?/);
  assert.match(prompt, /locked files \(tests\/a\.test\.mjs.*lane\/a--tests\).*never edit/is);
  assert.match(prompt, /contract-dispute: <file>: <why>/);
  assert.match(prompt, /never run the full suite/i);
  assert.match(prompt, /timeout 600000.*60000/s);
  assert.match(prompt, /cherry-pick main\.\.lane\/a--tests before the last review-tier run/);
});

test('the join brief: cherry-pick only git-cherry + commits, vacuous, out of scope, contract-touched, base and head runs before the helper worktree goes', async () => {
  const run = await runContract(contractLane());
  const { prompt } = call(run, ':join');
  assert.match(prompt, /git cherry.*\+/s);
  assert.match(prompt, /vacuous/);
  assert.match(prompt, /outOfScope/);
  assert.match(prompt, /git diff tw1 HEAD --name-only -- .*tests\/a\.test\.mjs/);
  assert.match(prompt, /c1.*node --test tests\/a\.test\.mjs/s);
  assert.match(prompt, /timeout 600000/);
  assert.ok(prompt.indexOf('baseExit') < prompt.indexOf('delete the helper branch'), 'base-side runs happen before the test-writer worktree is removed');
  const without = await runScript(BUILD, ARGS([lane('a', { checkpoints: [CHECKPOINT] })]), { replies: buildReplies(joined('a')), children: { review: () => reviewedClean('a', { waived: false }), land: () => landedOk() } });
  assert.match(call(without, ':join').prompt, /git merge-base main HEAD/);
});

test('a join that reports a locked contract file touched refuses the lane: not reviewed, not landed, the dispute lines in the text', async () => {
  let reviews = 0;
  const run = await runContract(contractLane(), {
    join: joined('a', { contractTouched: ['tests/a.test.mjs'] }),
    review: () => { reviews += 1; return reviewedClean('a'); },
    replies: [{ match: /:implement$/, reply: { ...built('a'), disputes: ['tests/a.test.mjs: asserts the wrong exit'] } }],
  });
  assert.equal(reviews, 0);
  assert.equal(run.result.lanes[0].status, 'contract-touched');
  assert.match(run.result.lanes[0].text, /tests\/a\.test\.mjs/);
  assert.match(run.result.lanes[0].text, /asserts the wrong exit/);
  assert.ok(!run.calls.some((entry) => entry.workflow === 'land'));
});

test('a red-first checkpoint that fails at the base and passes at head, kept test files, no leftovers: the review gets waiverAt, principles and addClasses', async () => {
  const run = await runContract(contractLane());
  const review = run.calls.find((entry) => entry.workflow === 'review' && !entry.args.audit).args;
  assert.equal(review.waiverAt, 'j-a');
  assert.deepEqual(review.principles, [{ id: 'P1', question: 'is every read path trusted?' }]);
  assert.deepEqual(review.addClasses, ['audit']);
  assert.equal((review.initialFindings ?? []).length, 0);
});

test('no waiverAt (and a finding where a check failed): checkpoint passes at base, fails at head, keeps-working fails at base, vacuous, out of scope, no red-first, no test-writer, missing result', async () => {
  const keeps = { ...CHECKPOINT, id: 'k1', kind: 'keeps-working' };
  const cases = [
    ['passes at base', contractLane(), joined('a', { checkpoints: [checkpointResult({ baseExit: 0 })] }), /c1/],
    ['fails at head', contractLane(), joined('a', { checkpoints: [checkpointResult({ headExit: 1, tail: '1 failing' })] }), /1 failing/],
    ['keeps-working fails at base', contractLane({ checkpoints: [CHECKPOINT, keeps] }), joined('a', { checkpoints: [checkpointResult(), checkpointResult({ id: 'k1', baseExit: 1, headExit: 0 })] }), /k1/],
    ['vacuous', contractLane(), joined('a', { vacuous: ['tests/a.test.mjs'] }), /tests\/a\.test\.mjs/],
    ['out of scope', contractLane(), joined('a', { outOfScope: ['elsewhere.mjs'] }), /elsewhere\.mjs/],
    ['no red-first', contractLane({ checkpoints: [keeps] }), joined('a', { checkpoints: [checkpointResult({ id: 'k1', baseExit: 0 })] }), null],
    ['no test-writer', contractLane({ acceptanceTests: false }), joined('a'), null],
    ['missing result', contractLane(), joined('a', { checkpoints: [] }), /c1/],
  ];
  for (const [name, laneObject, join, finding] of cases) {
    const run = await runContract(laneObject, { join, review: (a) => (a.audit ? audited() : reviewedClean('a', { waived: false })) });
    const review = run.calls.find((entry) => entry.workflow === 'review').args;
    assert.equal(review.waiverAt, undefined, `${name}: no waiverAt`);
    if (finding !== null) assert.match(JSON.stringify(review.initialFindings ?? []), finding, `${name}: a finding names it`);
  }
});

test('the checkpoint verdict is the script\'s, from exit codes: a model-written tail saying "pass" does not make a failing exit pass', async () => {
  const run = await runContract(contractLane(), { join: joined('a', { checkpoints: [checkpointResult({ headExit: 2, tail: 'all pass, ok' })] }) });
  assert.equal(run.calls.find((entry) => entry.workflow === 'review').args.waiverAt, undefined);
});

test('land `red` is handled like a conflict: a finding "suite red at the rebased tip: <tail>", then a delta review and a second land', async () => {
  const reviews = [];
  const run = await runContract(contractLane(), {
    review: (a) => { reviews.push(a); return a.audit ? audited() : reviewedClean('a'); },
    land: (a, tries) => (tries === 1 ? { status: 'red', sha: 'x', patchesChanged: 0, tidy: '3 failing' } : landedOk()),
  });
  const landingReviews = reviews.filter((entry) => !entry.audit);
  assert.equal(landingReviews.length, 2);
  assert.equal(landingReviews[1].deltaOf, TIP);
  assert.match(landingReviews[1].initialFindings[0].problem, /suite red at the rebased tip: 3 failing/);
  assert.equal(run.result.lanes[0].status, 'landed');
});

test('a waived lane that landed is audited after the land: record pending with the landed sha, should-audit, then the review child in audit mode on recorded shas B..T, then record done', async () => {
  const run = await runContract(contractLane());
  const decide = call(run, ':audit-decide').prompt;
  assert.match(decide, new RegExp(`audit-log\\.mjs record --repo /p --tip ${LANDED} --base ${BASE_SHA} --state pending`));
  assert.match(decide, new RegExp(`should-audit --tip ${LANDED} --json`));
  assert.doesNotMatch(decide, /--escalate/);
  const prepare = call(run, ':audit-prepare').prompt;
  assert.match(prepare, new RegExp(`git merge-base --is-ancestor ${BASE_SHA} ${TIP}`));
  assert.match(prepare, new RegExp(`git diff --numstat ${BASE_SHA} ${TIP}`));
  assert.match(prepare, new RegExp(`audit-impl-a-${TIP.slice(0, 8)}`));
  const child = run.calls.find((entry) => entry.workflow === 'review' && entry.args.audit).args;
  assert.deepEqual(child.audit, { base: BASE_SHA, tip: TIP });
  assert.equal(child.range, `${BASE_SHA}..${TIP}`);
  assert.doesNotMatch(child.range, /main|lane\//, 'the range is recorded shas, never a branch name');
  assert.deepEqual([child.landing, child.fix, child.base, child.worktree, child.row], [false, false, BASE_SHA, `/scratch/audit-impl-a-${TIP}`, 'close-a']);
  const finish = call(run, ':audit-finish').prompt;
  assert.match(finish, new RegExp(`worktree remove --force /scratch/audit-impl-a-${TIP}`));
  assert.match(finish, new RegExp(`record --repo /p --tip ${LANDED} --base ${BASE_SHA} --state done --confirmed 0`));
  assert.deepEqual(run.result.lanes[0].audit, { status: 'clean', findings: [] });
  assert.equal(run.result.lanes[0].status, 'landed');
  assertWellFormedCalls(run.calls, 'impl-a', META);
});

test('an audit that confirms blocking or should-fix findings records them and makes the lane audit-findings, still landed', async () => {
  const findings = [{ id: 'F1', severity: 'blocking' }, { id: 'F2', severity: 'should-fix' }, { id: 'F3', severity: 'optional' }];
  const run = await runContract(contractLane(), { review: (a) => (a.audit ? audited({ status: 'findings', findings }) : reviewedClean('a')) });
  assert.match(call(run, ':audit-finish').prompt, /--state done --confirmed 2/);
  const [entry] = run.result.lanes;
  assert.equal(entry.status, 'audit-findings');
  assert.equal(entry.sha, LANDED);
  assert.deepEqual(entry.audit.findings.map((item) => item.id), ['F1', 'F2']);
  assert.equal(entry.audit.status, 'findings');
});

test('an audit review that failed or stopped is recorded as error, never done; the lane is audit-error', async () => {
  for (const status of ['failed', 'incomplete']) {
    const run = await runContract(contractLane(), { review: (a) => (a.audit ? audited({ status, text: 'empty audit' }) : reviewedClean('a')) });
    const finish = call(run, ':audit-finish').prompt;
    assert.match(finish, /--state error/);
    assert.doesNotMatch(finish, /--state done/);
    assert.equal(run.result.lanes[0].status, 'audit-error');
    assert.equal(run.result.lanes[0].audit.status, 'error');
  }
});

test('a range with 0 changed lines, or a base that is not an ancestor of the tip, is audit-error with an error record and no audit review', async () => {
  for (const numbers of [{ ancestor: true, changedLines: 0 }, { ancestor: false, changedLines: 4 }]) {
    const prepared = (prompt) => ({ ...numbers, worktree: `/scratch/${/named (audit-\S+)/.exec(prompt)[1]}`, tail: '' }); // a usable path, so only the numbers can refuse
    const recorded = [];
    const run = await runContract(contractLane(), { replies: [{ match: /:audit-prepare$/, reply: prepared }, { match: /:audit-error$/, reply: (p) => { recorded.push(p); return { exit: 0, tail: '' }; } }] });
    assert.equal(run.result.lanes[0].status, 'audit-error');
    assert.ok(!run.calls.some((entry) => entry.workflow === 'review' && entry.args.audit), 'no audit review ran');
    assert.equal(recorded.length, 1);
    assert.match(recorded[0], /--state error/);
    assert.ok(![...run.calls].some((entry) => /--state done/.test(entry.prompt)), 'never a done record');
  }
});

test('an unsafe audit worktree path is audit-error and no review runs on it', async () => {
  const run = await runContract(contractLane(), { replies: [{ match: /:audit-prepare$/, reply: { ancestor: true, changedLines: 3, worktree: '/tmp/x; rm -rf y', tail: '' } }] });
  assert.equal(run.result.lanes[0].status, 'audit-error');
  assert.ok(!run.calls.some((entry) => entry.workflow === 'review' && entry.args.audit));
});

test('should-audit saying sampled-out records sampled-out and runs no audit review; a non-zero should-audit audits (fail closed)', async () => {
  const sampled = await runContract(contractLane(), { replies: [{ match: /:audit-decide$/, reply: { recordExit: 0, shouldExit: 0, audit: false, reason: 'sampled-out', tail: '' } }, { match: /:audit-sampled$/, reply: { exit: 0, tail: '' } }] });
  assert.match(call(sampled, ':audit-sampled').prompt, new RegExp(`--tip ${LANDED} --base ${BASE_SHA} --state sampled-out`));
  assert.ok(!sampled.calls.some((entry) => entry.workflow === 'review' && entry.args.audit));
  assert.deepEqual(sampled.result.lanes[0].audit, { status: 'sampled-out', findings: [] });
  assert.equal(sampled.result.lanes[0].status, 'landed');
  const failedClosed = await runContract(contractLane(), { replies: [{ match: /:audit-decide$/, reply: { recordExit: 0, shouldExit: 1, audit: false, reason: '', tail: 'boom' } }] });
  assert.ok(failedClosed.calls.some((entry) => entry.workflow === 'review' && entry.args.audit), 'a failing should-audit still audits');
});

test('a pending record that failed is audit-error before any audit review: the gate cannot be trusted', async () => {
  const run = await runContract(contractLane(), { replies: [{ match: /:audit-decide$/, reply: { recordExit: 2, shouldExit: 0, audit: true, reason: '', tail: 'usage' } }] });
  assert.equal(run.result.lanes[0].status, 'audit-error');
  assert.ok(!run.calls.some((entry) => entry.workflow === 'review' && entry.args.audit));
});

test('--escalate when the land loop ran a review; the lane keeps the FIRST review\'s waived and the LAST review\'s baseSha and tip; the gate key is the landed sha', async () => {
  const run = await runContract(contractLane(), {
    review: (a) => (a.audit ? audited() : a.deltaOf ? reviewedClean('a', { waived: false, tip: 'd2d2d2d2', baseSha: 'e3e3e3e3' }) : reviewedClean('a')),
    land: (a, tries) => (tries === 1 ? { status: 'needs-review', sha: 'x', patchesChanged: 1, tidy: '' } : landedOk()),
  });
  assert.match(call(run, ':audit-decide').prompt, /should-audit --tip c1c1c1c1 --escalate --json/);
  const child = run.calls.find((entry) => entry.workflow === 'review' && entry.args.audit).args;
  assert.deepEqual(child.audit, { base: 'e3e3e3e3', tip: 'd2d2d2d2' });
  assert.match(call(run, ':audit-decide').prompt, /--tip c1c1c1c1 --base e3e3e3e3 --state pending/);
});

test('a lane whose first review was not waived, or that did not land, is not audited; other lanes go on', async () => {
  const notWaived = await runContract(contractLane(), { review: () => reviewedClean('a', { waived: false }) });
  assert.ok(!notWaived.started.some((label) => label.includes(':audit-')));
  assert.equal(notWaived.result.lanes[0].audit, undefined);
  const notLanded = await runContract(contractLane(), { land: () => ({ status: 'failed', sha: '', patchesChanged: 0, tidy: 'suite red' }) });
  assert.ok(!notLanded.started.some((label) => label.includes(':audit-')));
  assert.equal(notLanded.result.lanes[0].status, 'failed');
});

test('an audit that throws leaves the landed lane reported as audit-error, not lost as a failed lane', async () => {
  const run = await runContract(contractLane(), { review: (a) => { if (a.audit) throw new Error('child died'); return reviewedClean('a'); } });
  assert.equal(run.result.lanes[0].status, 'audit-error');
  assert.equal(run.result.lanes[0].sha, LANDED);
  assert.match(call(run, ':audit-finish').prompt, /--state error/);
});

const reviewOf = (run) => run.calls.find((entry) => entry.workflow === 'review' && !entry.args.audit).args;
const auditChildren = (run) => run.calls.filter((entry) => entry.workflow === 'review' && entry.args.audit);
const worktreeNameOf = (prompt) => /named (audit-\S+)/.exec(prompt)[1];

test('a lane with no checkpoints and no test-writer locks nothing: no empty-pathspec diff, no base-side run, and a contractTouched the runner lists anyway is ignored', async () => {
  const bare = lane('a');
  const run = await runScript(BUILD, ARGS([bare]), { replies: buildReplies(joined('a', { checkpoints: [], contractTouched: ['a.mjs', 'b.mjs'] })), children: { review: () => reviewedClean('a', { waived: false }), land: () => landedOk() } });
  const { prompt } = call(run, ':join');
  assert.doesNotMatch(prompt, /name-only -- *[`.]/, 'no diff with an empty pathspec');
  assert.doesNotMatch(prompt, /contractTouched = /);
  assert.doesNotMatch(prompt, /Base-side runs/);
  assert.equal(run.result.lanes[0].status, 'landed');
  assert.match(prompt, /outOfScope = /);
});

test('an implementer dispute goes to the lead (leadList), not into the review as a finding, and blocks waiverAt', async () => {
  const run = await runContract(contractLane(), { replies: [{ match: /:implement$/, reply: { ...built('a'), disputes: ['tests/a.test.mjs: asserts the wrong exit'] } }] });
  const review = reviewOf(run);
  assert.equal(review.waiverAt, undefined);
  assert.equal((review.initialFindings ?? []).length, 0);
  assert.equal(run.result.leadList.length, 1);
  assert.match(JSON.stringify(run.result.leadList[0]), /asserts the wrong exit/);
  assert.equal(run.result.lanes[0].status, 'landed');
  assert.equal(run.result.lanes[0].audit, undefined, 'a lane whose waiver was blocked is not audited');
});

test('a stopped should-audit runner (null) audits anyway: the spec says null means audit', async () => {
  const run = await runContract(contractLane(), { replies: [{ match: /:audit-decide$/, reply: null }] });
  assert.equal(auditChildren(run).length, 1);
  assert.equal(run.result.lanes[0].audit.status, 'clean');
});

test('shas that are not hex are audit-error before any agent runs: nothing is recorded, and the text says so', async () => {
  const run = await runContract(contractLane(), { review: (a) => (a.audit ? audited() : reviewedClean('a', { baseSha: 'not a sha; rm' })) });
  assert.equal(run.result.lanes[0].status, 'audit-error');
  assert.match(run.result.lanes[0].text, /nothing was recorded/);
  assert.ok(!run.started.some((label) => label.includes(':audit-')));
});

test('the audit worktree must be a safe path AND end with the name asked for: each check refuses alone, and a refused safe worktree is removed', async () => {
  const cases = [['unsafe path that ends right', (name) => `/scratch/$HOME/${name}`], ['safe path that ends wrong', () => '/scratch/other-audit']];
  for (const [name, pathOf] of cases) {
    const run = await runContract(contractLane(), { replies: [{ match: /:audit-prepare$/, reply: (p) => ({ ancestor: true, changedLines: 3, worktree: pathOf(worktreeNameOf(p)), tail: '' }) }] });
    assert.equal(run.result.lanes[0].status, 'audit-error', name);
    assert.equal(auditChildren(run).length, 0, name);
    assert.match(call(run, ':audit-error').prompt, /--state error/, name);
  }
  const goodName = (p) => worktreeNameOf(p);
  const empty = await runContract(contractLane(), { replies: [{ match: /:audit-prepare$/, reply: (p) => ({ ancestor: true, changedLines: 0, worktree: `/scratch/${goodName(p)}`, tail: '' }) }] });
  assert.match(call(empty, ':audit-error').prompt, new RegExp(`git worktree remove --force /scratch/audit-impl-a-${TIP}`), 'a refused worktree that was created is removed');
});

test('a throw outside the audit review (an audit step that dies) is audit-error with the landed sha, not a lost lane', async () => {
  const run = await runContract(contractLane(), { replies: [{ match: /:audit-prepare$/, reply: () => { throw new Error('runner died'); } }] });
  const [entry] = run.result.lanes;
  assert.equal(entry.status, 'audit-error');
  assert.equal(entry.sha, LANDED);
  assert.match(entry.text, /runner died/);
});

test('a review leadList item counts as confirmed in the done record and makes the lane audit-findings', async () => {
  const run = await runContract(contractLane(), { review: (a) => (a.audit ? audited({ leadList: [{ id: 'L1', file: 'a.mjs', line: 1, reason: 'weaker check' }] }) : reviewedClean('a')) });
  assert.match(call(run, ':audit-finish').prompt, /--state done --confirmed 1/);
  assert.equal(run.result.lanes[0].status, 'audit-findings');
  assert.deepEqual(run.result.lanes[0].audit.findings.map((item) => item.id), ['L1']);
});

test('a record that did not take (finish exit, sampled-out exit, or a null runner) is audit-error: the record stays pending', async () => {
  const finish = await runContract(contractLane(), { replies: [{ match: /:audit-finish$/, reply: { exit: 3, tail: 'no repo' } }] });
  assert.equal(finish.result.lanes[0].status, 'audit-error');
  assert.match(finish.result.lanes[0].text, /stay closed/);
  const finishNull = await runContract(contractLane(), { replies: [{ match: /:audit-finish$/, reply: null }] });
  assert.equal(finishNull.result.lanes[0].status, 'audit-error');
  const sampledOut = { match: /:audit-decide$/, reply: { recordExit: 0, shouldExit: 0, audit: false, reason: '', tail: '' } };
  const sampled = await runContract(contractLane(), { replies: [sampledOut, { match: /:audit-sampled$/, reply: { exit: 1, tail: '' } }] });
  assert.equal(sampled.result.lanes[0].status, 'audit-error');
  assert.equal(auditChildren(sampled).length, 0);
  const sampledNull = await runContract(contractLane(), { replies: [sampledOut, { match: /:audit-sampled$/, reply: null }] });
  assert.equal(sampledNull.result.lanes[0].status, 'audit-error');
});

test('checkArgs: lanes that list the same file written two ways, or a folder and a file inside it, are refused', async () => {
  for (const [first, second] of [['x.mjs', './x.mjs'], ['src', 'src/a.mjs'], ['src/', 'src/a.mjs']]) {
    const run = await runScript(BUILD, ARGS([lane('a', { files: [first] }), lane('b', { files: [second] })]), { replies: [] });
    assert.match(String(run.error?.message), /impl-a.*impl-b/, `${first} vs ${second}`);
  }
  const folder = lane('a', { files: ['tests'], checkpoints: [CHECKPOINT] });
  assert.match(String((await runScript(BUILD, ARGS([folder]), { replies: [] })).error?.message), /checkpoint c1/);
});

test('a checkpoint with no locked files still gets its base-side run (no test-writer): the verdict needs baseExit, and contractTouched stays off', async () => {
  const unlocked = lane('a', { checkpoints: [{ ...CHECKPOINT, files: [], kind: 'keeps-working' }] });
  const run = await runScript(BUILD, ARGS([unlocked]), { replies: buildReplies(joined('a', { checkpoints: [checkpointResult({ baseExit: 0 })] })), children: { review: () => reviewedClean('a', { waived: false }), land: () => landedOk() } });
  const { prompt } = call(run, ':join');
  assert.match(prompt, /Base-side runs, in a detached worktree at `git merge-base main HEAD`.*c1: node --test tests\/a\.test\.mjs/s);
  assert.doesNotMatch(prompt, /contractTouched = /);
  assert.equal((reviewOf(run).initialFindings ?? []).length, 0, 'baseExit 0 meets a keeps-working checkpoint');
});

test('checkArgs: two checkpoints of one lane may not share an id (the verdict keeps one result per id)', async () => {
  const twins = lane('a', { checkpoints: [CHECKPOINT, { ...CHECKPOINT, run: 'node --test tests/b.test.mjs', files: ['tests/b.test.mjs'] }] });
  assert.match(String((await runScript(BUILD, ARGS([twins]), { replies: [] })).error?.message), /id c1 is used twice/);
});

test('the audit review gets the lane\'s principles and added classes, like the landing review', async () => {
  const run = await runContract(contractLane());
  const [audit] = auditChildren(run);
  assert.deepEqual(audit.args.principles, [{ id: 'P1', question: 'is every read path trusted?' }]);
  assert.deepEqual(audit.args.addClasses, ['audit']);
});
