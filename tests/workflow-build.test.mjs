// Behaviour of home/workflows/build.js (spec section 7 `build`): per lane implementer (+ test-writer) in worktrees, a join, the review child,
// a serial land queue that lets lane A land while lane B is still in review, and the conflict / needs-review loops. Children are scripted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertWellFormedCalls, readMeta, runScript } from './workflow-sandbox.mjs';
import { priorOfTierPrompt, withPriorLine } from './workflow-review-helpers.mjs';

const BUILD = join(dirname(fileURLToPath(import.meta.url)), '..', 'home', 'workflows', 'build.js');
const META = readMeta(readFileSync(BUILD, 'utf8')).meta;
const lane = (key, extra = {}) => ({ row: `impl-${key}`, closeRow: `close-${key}`, branch: `lane/${key}`, spec: '/spec.md', files: [`${key}.mjs`], acceptanceTests: false, implementer: { model: 'sonnet', effort: 'medium' }, ...extra });
const ARGS = (lanes, extra = {}) => ({ base: 'main', repo: '/p', suite: 'npm test', writers: 4, statusFile: '/p/STATUS.md', scriptsDir: '/scripts', lanes, ...extra });
const built = (key) => ({ branch: `lane/${key}`, worktree: `/wt/${key}`, sha: `s-${key}`, tests: { cmd: 't', exit: 0 }, tier: {} });
const joined = (key, extra = {}) => ({ red: false, tail: 'green', sha: `j-${key}`, worktree: `/wt/${key}`, vacuous: [], outOfScope: [], contractTouched: [], checkpoints: [], ...extra });
const reviewed = (key) => ({ status: 'clean', rounds: 1, tip: `t-${key}`, worktree: `/wt/${key}`, laneClasses: ['logic'], suite: 'pass', findings: [], optional: [], leadList: [], text: '' });
const landedOk = (key) => ({ status: 'landed', sha: `m-${key}`, patchesChanged: 0, tidy: 'clean' });
const key = (label) => label.split(':')[0].replace('impl-', '');
const diskOk = { match: /:disk$/, reply: { exit: 0, tail: 'ok    disk free 80.0 GB' } };
const standard = (overrides = {}) => [
  diskOk,
  ...Object.entries(overrides).map(([name, reply]) => ({ match: new RegExp(`:${name}$`), reply })), // the first matching reply wins
  { match: /:implement$/, reply: (prompt, opts, call) => built(key(call.label)) },
  { match: /:join$/, reply: (prompt, opts, call) => joined(key(call.label)) },
];
const children = (review, land) => ({ review, land });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('one lane: implement, join, review child (landing, fix), land child; the result lists the landed sha; every call is well formed', async () => {
  const seen = [];
  const run = await runScript(BUILD, ARGS([lane('a')]), {
    replies: standard(),
    children: children((a) => { seen.push(['review', a]); return reviewed('a'); }, (a) => { seen.push(['land', a]); return landedOk('a'); }),
  });
  assert.equal(run.error, null);
  assert.deepEqual(run.result.lanes, [{ row: 'impl-a', closeRow: 'close-a', status: 'landed', sha: 'm-a', text: '' }]);
  assertWellFormedCalls(run.calls, 'impl-a', META);
  const [[, reviewArgs], [, landArgs]] = seen;
  assert.deepEqual([reviewArgs.row, reviewArgs.landing, reviewArgs.fix, reviewArgs.range, reviewArgs.worktree], ['close-a', true, true, 'main...lane/a', '/wt/a']);
  assert.deepEqual([landArgs.row, landArgs.closeRow, landArgs.branch, landArgs.statusFile, landArgs.worktree], ['close-a', 'close-a', 'lane/a', '/p/STATUS.md', '/wt/a']);
  const implement = run.calls.find((call) => call.label === 'impl-a:implement');
  assert.equal(implement.opts.isolation, 'worktree');
  assert.deepEqual([implement.opts.agentType, implement.opts.model, implement.opts.effort], ['implementer', 'sonnet', 'medium']);
  assert.match(implement.prompt, /review-tier.* --landing --json/);
  assert.match(implement.prompt, /git branch -m lane\/a/);
  assert.match(implement.prompt, /throwaway branch/);
  assert.match(implement.prompt, /already exists \(a re-done lane\) never make a copy: remove the old worktree .*git switch lane\/a && git rebase main.*git branch -d/);
  assert.equal(landArgs.tip, 't-a', 'land gets the reviewed tip');
  const join = run.calls.find((call) => call.label === 'impl-a:join');
  assert.match(join.prompt, /status\.mjs --file \/p\/STATUS\.md done impl-a/);
  assert.match(join.prompt, /status\.mjs --file \/p\/STATUS\.md start close-a/);
});

test('acceptanceTests adds a test-writer in its own worktree on <branch>--tests, in parallel with the implementer, and the join cherry-picks it', async () => {
  const run = await runScript(BUILD, ARGS([lane('a', { acceptanceTests: true })]), {
    replies: [...standard(), { match: /:tests$/, reply: { branch: 'lane/a--tests', worktree: '/wt/a-tests', sha: 'tw1' } }],
    children: children(() => reviewed('a'), () => landedOk('a')),
  });
  const writer = run.calls.find((call) => call.label === 'impl-a:tests');
  assert.deepEqual([writer.opts.agentType, writer.opts.isolation, writer.opts.model, writer.opts.effort], ['test-writer', 'worktree', 'sonnet', 'medium']);
  assert.match(writer.prompt, /git branch -m lane\/a--tests/);
  const order = run.started;
  assert.ok(order.indexOf('impl-a:tests') < order.indexOf('impl-a:join') && order.indexOf('impl-a:implement') < order.indexOf('impl-a:join'));
  assert.match(run.calls.find((call) => call.label === 'impl-a:join').prompt, /Cherry-pick.*lane\/a--tests.*tw1/s);
});

test('red related tests at the join go to the review child as the first finding to fix', async () => {
  let reviewArgs;
  const run = await runScript(BUILD, ARGS([lane('a')]), {
    replies: standard({ join: joined('a', { red: true, tail: '2 failing' }) }),
    children: children((a) => { reviewArgs = a; return reviewed('a'); }, () => landedOk('a')),
  });
  assert.equal(run.result.lanes[0].status, 'landed');
  assert.equal(reviewArgs.initialFindings.length, 1);
  assert.match(reviewArgs.initialFindings[0].problem, /2 failing/);
});

test('lane A lands while lane B is still in review, and land calls never overlap', async () => {
  let releaseB;
  const reviewBHeld = new Promise((resolve) => { releaseB = resolve; });
  const events = [];
  let landing = 0;
  const land = async (a) => {
    landing += 1;
    assert.equal(landing, 1, 'two land calls at once');
    events.push(`land:${a.branch}`);
    await sleep(10);
    landing -= 1;
    return landedOk(a.branch.slice(-1));
  };
  const review = async (a) => {
    events.push(`review:${a.branch}`);
    if (a.branch === 'lane/b') { await reviewBHeld; events.push('review-b-done'); }
    return reviewed(a.branch.slice(-1));
  };
  const running = runScript(BUILD, ARGS([lane('a'), lane('b')]), { replies: standard(), children: children(review, land) });
  await sleep(60);
  assert.deepEqual(events.filter((event) => event !== 'review-b-done'), ['review:lane/a', 'review:lane/b', 'land:lane/a']);
  assert.ok(!events.includes('review-b-done'), 'lane B is still in review when lane A has landed');
  releaseB();
  const run = await running;
  assert.deepEqual(run.result.lanes.map((entry) => entry.status), ['landed', 'landed']);
  assert.deepEqual(events.slice(-2), ['review-b-done', 'land:lane/b']);
});

test('writers: 1 lets only one writer agent run at a time across lanes', async () => {
  let running = 0;
  let peak = 0;
  const writer = (key) => async () => {
    running += 1;
    peak = Math.max(peak, running);
    await sleep(15);
    running -= 1;
    return built(key);
  };
  const run = await runScript(BUILD, ARGS([lane('a'), lane('b'), lane('c')], { writers: 1 }), {
    replies: [diskOk, { match: /impl-a:implement/, reply: writer('a') }, { match: /impl-b:implement/, reply: writer('b') }, { match: /impl-c:implement/, reply: writer('c') },
      { match: /:join$/, reply: (p, o, call) => joined(key(call.label)) }],
    children: children((a) => reviewed(a.branch.slice(-1)), (a) => landedOk(a.branch.slice(-1))),
  });
  assert.equal(peak, 1);
  assert.equal(run.result.lanes.length, 3);
});

test('a conflict goes back through the review child with the conflict as a finding, then lands; needs-review reviews the delta and lands', async () => {
  for (const [first, expectFinding] of [[{ status: 'conflict', sha: 'x', patchesChanged: 0, tidy: 'a.mjs' }, true], [{ status: 'needs-review', sha: 'x', patchesChanged: 2, tidy: '' }, false]]) {
    const reviews = [];
    let landTries = 0;
    const run = await runScript(BUILD, ARGS([lane('a')]), {
      replies: standard(),
      children: children((a) => { reviews.push(a); return reviewed('a'); }, () => ((landTries += 1) === 1 ? first : landedOk('a'))),
    });
    assert.equal(run.result.lanes[0].status, 'landed');
    assert.equal(reviews.length, 2);
    assert.equal(reviews[1].deltaOf, 't-a');
    assert.equal(String(reviews[1].laneClasses), 'logic', 'the class names of the reviewed round, inline: no tier file is handed on');
    assert.equal((reviews[1].initialFindings ?? []).length, expectFinding ? 1 : 0);
    assert.equal(JSON.stringify(reviews[1].priorFindings), expectFinding ? undefined : '[]', 'needs-review: the last review was clean, so the empty prior list is given on purpose');
    if (expectFinding) assert.match(reviews[1].initialFindings[0].problem, /a\.mjs/);
  }
});

test('a review that is not clean stops the lane before it lands; a failed land is reported with its text; other lanes go on', async () => {
  const run = await runScript(BUILD, ARGS([lane('a'), lane('b'), lane('c')]), {
    replies: standard(),
    children: children(
      (a) => (a.branch === 'lane/a' ? { ...reviewed('a'), status: 'incomplete', text: 'a lens stopped' } : reviewed(a.branch.slice(-1))),
      (a) => (a.branch === 'lane/b' ? { status: 'failed', sha: '', patchesChanged: 0, tidy: 'suite red' } : landedOk('c')),
    ),
  });
  assert.deepEqual(run.result.lanes.map((entry) => [entry.row, entry.status]), [['impl-a', 'review-incomplete'], ['impl-b', 'failed'], ['impl-c', 'landed']]);
  assert.match(run.result.lanes[0].text, /a lens stopped/);
  assert.match(run.result.lanes[1].text, /suite red/);
});

test('an implementer that was stopped ends only its lane', async () => {
  const run = await runScript(BUILD, ARGS([lane('a'), lane('b')]), {
    replies: [diskOk, { match: /impl-a:implement/, reply: null }, { match: /impl-b:implement/, reply: built('b') }, { match: /:join$/, reply: joined('b') }],
    children: children(() => reviewed('b'), () => landedOk('b')),
  });
  assert.deepEqual(run.result.lanes.map((entry) => entry.status), ['implementer-stopped', 'landed']);
});

test('the lead list of every review comes back', async () => {
  const run = await runScript(BUILD, ARGS([lane('a')]), {
    replies: standard(),
    children: children(() => ({ ...reviewed('a'), leadList: [{ id: 'S1', reason: 'not reachable' }] }), () => landedOk('a')),
  });
  assert.equal(run.result.leadList.length, 1);
});

test('two lanes whose reviews finish together still land one after the other', async () => {
  let landing = 0;
  let overlapped = false;
  const land = async (a) => {
    landing += 1;
    overlapped ||= landing > 1;
    await sleep(15);
    landing -= 1;
    return landedOk(a.branch.slice(-1));
  };
  const run = await runScript(BUILD, ARGS([lane('a'), lane('b')]), { replies: standard(), children: children((a) => reviewed(a.branch.slice(-1)), land) });
  assert.equal(overlapped, false);
  assert.deepEqual(run.result.lanes.map((entry) => entry.status), ['landed', 'landed']);
});

test('an implementer or test-writer on another branch than the lane\'s ends only that lane as wrong-branch: a re-done lane never lands its old branch (B1)', async () => {
  const run = await runScript(BUILD, ARGS([lane('a'), lane('b', { acceptanceTests: true }), lane('c')]), {
    replies: [diskOk,
      { match: /impl-a:implement/, reply: { ...built('a'), branch: 'worktree-wf_9' } },
      { match: /impl-b:implement/, reply: built('b') },
      { match: /impl-b:tests/, reply: { branch: 'worktree-wf_8', worktree: '/wt/bt', sha: 'tw' } },
      { match: /impl-c:implement/, reply: built('c') },
      { match: /:join$/, reply: (p, o, call) => joined(key(call.label)) },
    ],
    children: children((a) => reviewed(a.branch.slice(-1)), (a) => landedOk(a.branch.slice(-1))),
  });
  assert.deepEqual(run.result.lanes.map((entry) => entry.status), ['wrong-branch', 'wrong-branch', 'landed']);
  assert.match(run.result.lanes[0].text, /worktree-wf_9, not lane\/a/);
  assert.match(run.result.lanes[1].text, /worktree-wf_8, not lane\/b--tests/);
  assert.ok(!run.started.includes('impl-a:join') && !run.started.includes('impl-b:join'));
});

test('a clean review with a security finding ruled not real holds the lane for the lead: it is not landed, in the first review or after a conflict (S2)', async () => {
  const disputed = { id: 'S1', file: 'a.mjs', line: 3, reason: 'not reachable' };
  let landCalls = 0;
  const first = await runScript(BUILD, ARGS([lane('a')]), {
    replies: standard(),
    children: children(() => ({ ...reviewed('a'), leadList: [disputed], optional: [{ id: 'O1' }] }), () => { landCalls += 1; return landedOk('a'); }),
  });
  assert.equal(landCalls, 0);
  const [held] = first.result.lanes;
  assert.equal(held.status, 'lead-decision');
  assert.equal(held.sha, 't-a');
  assert.match(held.text, /S1 a\.mjs:3 \(not reachable\).*the land workflow at tip t-a/);
  assert.deepEqual(held.optional, [{ id: 'O1' }]);
  assert.equal(first.result.leadList.length, 1);

  let reviews = 0;
  let landTries = 0;
  const later = await runScript(BUILD, ARGS([lane('a')]), {
    replies: standard(),
    children: children(() => ({ ...reviewed('a'), leadList: (reviews += 1) === 2 ? [disputed] : [] }), () => ((landTries += 1) === 1 ? { status: 'needs-review', sha: 'x', patchesChanged: 1, tidy: '' } : landedOk('a'))),
  });
  assert.equal(later.result.lanes[0].status, 'lead-decision');
  assert.equal(landTries, 1, 'the second land never ran');
});

test('the findings and optional findings of a review come back with the lane, landed or not', async () => {
  const run = await runScript(BUILD, ARGS([lane('a'), lane('b')]), {
    replies: standard(),
    children: children(
      (a) => (a.branch === 'lane/a' ? { ...reviewed('a'), status: 'findings', findings: [{ id: 'F1' }], optional: [{ id: 'O1' }] } : { ...reviewed('b'), optional: [{ id: 'O2' }] }),
      () => landedOk('b'),
    ),
  });
  assert.deepEqual([run.result.lanes[0].status, run.result.lanes[0].findings, run.result.lanes[0].optional], ['review-findings', [{ id: 'F1' }], [{ id: 'O1' }]]);
  assert.deepEqual([run.result.lanes[1].status, run.result.lanes[1].optional, 'findings' in run.result.lanes[1]], ['landed', [{ id: 'O2' }], false]);
});

test('a ui-implementer lane needs a matrix and carries it as the MATRIX line; every build brief names the standing rules (S3)', async () => {
  const ui = lane('a', { implementer: { agentType: 'ui-implementer', model: 'sonnet', effort: 'medium' } });
  for (const matrix of [undefined, '', 'none: short']) {
    const run = await runScript(BUILD, ARGS([{ ...ui, matrix }]), { replies: standard() });
    assert.match(String(run.error?.message), /args\.lanes\[0\]\.matrix must be a coverage matrix path or `none: <reason of 15\+ characters>`/);
    assert.equal(run.calls.length, 0);
  }
  const run = await runScript(BUILD, ARGS([{ ...ui, matrix: '/p/matrix.json', acceptanceTests: true }]), {
    replies: [...standard(), { match: /:tests$/, reply: { branch: 'lane/a--tests', worktree: '/wt/at', sha: 'tw1' } }],
    children: children(() => reviewed('a'), () => landedOk('a')),
  });
  const implement = run.calls.find((call) => call.label === 'impl-a:implement');
  assert.match(implement.prompt, /^MATRIX: \/p\/matrix\.json\nRead the `## Standing rules` of \/p\/STATUS\.md/);
  assert.match(run.calls.find((call) => call.label === 'impl-a:tests').prompt, /^Read the `## Standing rules` of \/p\/STATUS\.md/);
  const plain = await runScript(BUILD, ARGS([lane('b')]), { replies: standard(), children: children(() => reviewed('b'), () => landedOk('b')) });
  assert.doesNotMatch(plain.calls.find((call) => call.label === 'impl-b:implement').prompt, /MATRIX/);
});

test('a Windows drive-letter worktree path, with / or \\, is a plain path and does not end the lane', async () => {
  const run = await runScript(BUILD, ARGS([lane('a'), lane('b')]), {
    replies: [diskOk,
      { match: /impl-a:implement/, reply: { ...built('a'), worktree: 'C:/wt/a' } },
      { match: /impl-b:implement/, reply: built('b') },
      { match: /impl-a:join/, reply: joined('a', { worktree: 'D:\\wt\\a' }) },
      { match: /impl-b:join/, reply: joined('b') },
    ],
    children: children((a) => reviewed(a.branch.slice(-1)), (a) => landedOk(a.branch.slice(-1))),
  });
  assert.deepEqual(run.result.lanes.map((entry) => entry.status), ['landed', 'landed']);
});

test('a worktree path with shell characters, from an agent or the join runner, ends only that lane (N1)', async () => {
  const run = await runScript(BUILD, ARGS([lane('a'), lane('b'), lane('c')]), {
    replies: [diskOk,
      { match: /impl-a:implement/, reply: { ...built('a'), worktree: '/wt/a; echo x' } },
      { match: /impl-b:implement/, reply: built('b') },
      { match: /impl-c:implement/, reply: built('c') },
      { match: /impl-b:join/, reply: joined('b', { worktree: '/wt/b $(x)' }) },
      { match: /impl-c:join/, reply: joined('c') },
    ],
    children: children((a) => reviewed(a.branch.slice(-1)), (a) => landedOk(a.branch.slice(-1))),
  });
  assert.deepEqual(run.result.lanes.map((entry) => entry.status), ['failed', 'join-failed', 'landed']);
  assert.match(run.result.lanes[0].text, /not a plain absolute path/);
});

test('disk: a low disk refuses the whole build before any implementer starts, naming the caches in the lane texts', async () => {
  const message = 'FAIL  disk free 3.0 GB is below 5 GB: agents and builds will fail with ENOSPC. Rebuildable caches to clear, biggest first: CoreSimulator 8.0 GB';
  const run = await runScript(BUILD, ARGS([lane('a'), lane('b')]), { replies: [{ match: /:disk$/, reply: { exit: 1, tail: message } }] });
  assert.equal(run.error, null);
  assert.deepEqual(run.started, ['impl-a:disk'], 'nothing else starts');
  assert.deepEqual(run.result.lanes.map((entry) => entry.status), ['failed', 'failed']);
  assert.match(run.result.lanes[0].text, /disk free 3\.0 GB is below 5 GB.*CoreSimulator/);
  assert.match(run.calls[0].prompt, /disk-free\.mjs check/);
});

test('disk: a disk check that could not run (exit 2) or was stopped refuses the build too', async () => {
  const broken = await runScript(BUILD, ARGS([lane('a')]), { replies: [{ match: /:disk$/, reply: { exit: 2, tail: 'DISK_FAIL_FREE_GB must be a positive number' } }] });
  assert.equal(broken.result.lanes[0].status, 'failed');
  assert.deepEqual(broken.started, ['impl-a:disk']);
  const stopped = await runScript(BUILD, ARGS([lane('a')]), { replies: [{ match: /:disk$/, reply: null }] });
  assert.equal(stopped.result.lanes[0].status, 'failed');
  assert.match(stopped.result.lanes[0].text, /disk/);
});

test('disk: a WARN (exit 0) does not stop the build, and a build with no lanes starts no agent', async () => {
  const run = await runScript(BUILD, ARGS([lane('a')]), {
    replies: [{ match: /:disk$/, reply: { exit: 0, tail: 'WARN  disk free 10.0 GB is below 15 GB' } }, ...standard()],
    children: children(() => reviewed('a'), () => landedOk('a')),
  });
  assert.equal(run.result.lanes[0].status, 'landed');
  const empty = await runScript(BUILD, ARGS([]), {});
  assert.equal(empty.error, null);
  assert.deepEqual(empty.result, { lanes: [], leadList: [] });
  assert.deepEqual(empty.started, []);
});

test('resume: a lane whose close row STATUS.md shows landed is not built again; the other lane runs normally; without resume nothing is asked', async () => {
  const replies = [{ match: /impl-a:resumed$/, reply: { landed: true, sha: 'm-old' } }, { match: /impl-b:resumed$/, reply: { landed: false, sha: '' } }, ...standard()];
  const run = await runScript(BUILD, ARGS([lane('a'), lane('b')], { resume: true }), { replies, children: children(() => reviewed('b'), () => landedOk('b')) });
  assert.equal(run.error, null);
  assert.deepEqual(run.result.lanes.map((entry) => [entry.row, entry.status, entry.sha]), [['impl-a', 'landed', 'm-old'], ['impl-b', 'landed', 'm-b']]);
  assert.ok(!run.started.includes('impl-a:implement') && run.started.includes('impl-b:implement'));
  const ask = run.calls.find((call) => call.label === 'impl-a:resumed');
  assert.match(ask.prompt, /\/p\/STATUS\.md.*close-a/s);
  assertWellFormedCalls(run.calls.filter((call) => call.label.startsWith('impl-a:')), 'impl-a', META);
  const plain = await runScript(BUILD, ARGS([lane('a')]), { replies: standard(), children: children(() => reviewed('a'), () => landedOk('a')) });
  assert.ok(!plain.started.some((label) => label.endsWith(':resumed')));
  const off = await runScript(BUILD, ARGS([lane('a')], { resume: false }), { replies: standard(), children: children(() => reviewed('a'), () => landedOk('a')) });
  assert.ok(!off.started.some((label) => label.endsWith(':resumed')));
  const bad = await runScript(BUILD, ARGS([lane('a')], { resume: 'yes' }), { replies: standard() });
  assert.match(String(bad.error?.message), /args\.resume must be a boolean/);
});

test('needs-review at land runs the real review script as a delta round: its lens is reached with an empty prior list, and the lane lands', async () => {
  const REVIEW = join(dirname(BUILD), 'review.js');
  const SONNET = { agent: 'reviewer', model: 'sonnet', effort: 'high', lens: 'correctness', rules: 'core', brief: 'brief', requiredReading: [], plan: {} };
  const tip = (n) => `a1b2c3d${n}`.padEnd(40, '0');
  let [tierCalls, landTries] = [0, 0];
  const [START, BASE_TIP] = ['ba5e0001'.padEnd(40, '0'), 'ba5e0002'.padEnd(40, '0')];
  const replies = [
    { match: /:disk$/, reply: { ...diskOk.reply, baseTip: BASE_TIP } }, // the base tip this build reads itself, at its start
    ...standard(),
    { match: /^close-a:base$/, reply: { exit: 0, tail: `${BASE_TIP}\n` } },
    { match: /^close-a:tier$/, reply: (prompt) => { const at = tierCalls++; return { exit: 0, baseSha: START, sha: tip(at + 1), reviewWorktree: `/scratch/close-a-${tip(at + 1).slice(0, 8)}`, tier: { tip: tip(at + 1), reviews: [SONNET], fileClasses: {}, ...priorOfTierPrompt(prompt) } }; } },
    { match: /^close-a:review:correctness$/, reply: (prompt) => withPriorLine(prompt, { findings: [], verified: 'read it' }) },
    { match: /^close-a:suite$/, reply: { exit: 0, tail: 'ok' } },
    { match: /^close-a:cleanup$/, reply: { exit: 0, tail: '' } },
  ];
  const land = () => ((landTries += 1) === 1 ? { status: 'needs-review', sha: 'x', patchesChanged: 2, tidy: '' } : landedOk('a'));
  const run = await runScript(BUILD, ARGS([lane('a')]), { replies, children: { review: REVIEW, land } });
  assert.equal(run.error, null);
  assert.deepEqual(run.result.lanes.map(({ status, text }) => [status, text]), [['landed', '']], 'not review-failed');
  const reviews = run.calls.filter((call) => call.workflow === 'review').map((call) => call.args);
  assert.equal(reviews.length, 2);
  assert.deepEqual([reviews[1].deltaOf, reviews[1].laneClasses, reviews[1].priorFindings, reviews[1].initialFindings], [tip(1), ['logic'], [], undefined]);
  const [, deltaTier] = run.calls.filter((call) => call.label === 'close-a:tier');
  assert.match(deltaTier.prompt, new RegExp(`review-tier\\.mjs --delta ${tip(1)} --base ${START} --rebased-onto ${BASE_TIP} --prior <the prior findings file> --prior-sha256 <its sha256> --landing --lane-classes logic --json`), 'the start the first review recorded, and the one tip this build read itself (D7)');
  assert.deepEqual([reviews[1].laneStart, reviews[1].baseTips], [START, [BASE_TIP]]);
  assert.doesNotMatch(deltaTier.prompt, /merge-base|<the lane start>/);
  assert.match(deltaTier.prompt, /with exactly these 0 lines \(an empty file\)/);
  const lenses = run.calls.filter((call) => call.label === 'close-a:review:correctness');
  assert.equal(lenses.length, 2, 'the delta round reaches its lens');
  assert.ok(lenses[1].prompt.includes(`the change to review is the delta since ${tip(1)}`), lenses[1].prompt);
  assert.match(lenses[1].prompt, /prior: <n> fixed, <m> open` over those 0 findings/);
  assert.equal(run.calls.filter((call) => call.workflow === 'land').at(-1).args.tip, tip(2), 'land gets the tip the delta round reviewed');
});
