// Behaviour of home/workflows/build.js (spec section 7 `build`): per lane implementer (+ test-writer) in worktrees, a join, the review child,
// a serial land queue that lets lane A land while lane B is still in review, and the conflict / needs-review loops. Children are scripted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertWellFormedCalls, readMeta, runScript } from './workflow-sandbox.mjs';

const BUILD = join(dirname(fileURLToPath(import.meta.url)), '..', 'home', 'workflows', 'build.js');
const META = readMeta(readFileSync(BUILD, 'utf8')).meta;
const lane = (key, extra = {}) => ({ row: `impl-${key}`, closeRow: `close-${key}`, branch: `lane/${key}`, spec: '/spec.md', files: ['a.mjs'], acceptanceTests: false, implementer: { model: 'sonnet', effort: 'medium' }, ...extra });
const ARGS = (lanes, extra = {}) => ({ base: 'main', repo: '/p', suite: 'npm test', writers: 4, statusFile: '/p/STATUS.md', scriptsDir: '/scripts', lanes, ...extra });
const built = (key) => ({ branch: `lane/${key}`, worktree: `/wt/${key}`, sha: `s-${key}`, tests: { cmd: 't', exit: 0 }, tier: {} });
const joined = (key, extra = {}) => ({ red: false, tail: 'green', sha: `j-${key}`, worktree: `/wt/${key}`, ...extra });
const reviewed = (key) => ({ status: 'clean', rounds: 1, tip: `t-${key}`, worktree: `/wt/${key}`, tierFile: `/t-${key}.json`, suite: 'pass', findings: [], optional: [], leadList: [], text: '' });
const landedOk = (key) => ({ status: 'landed', sha: `m-${key}`, patchesChanged: 0, tidy: 'clean' });
const key = (label) => label.split(':')[0].replace('impl-', '');
const standard = (overrides = {}) => [
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
    replies: [{ match: /impl-a:implement/, reply: writer('a') }, { match: /impl-b:implement/, reply: writer('b') }, { match: /impl-c:implement/, reply: writer('c') },
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
    assert.equal(reviews[1].laneClasses, '/t-a.json');
    assert.equal((reviews[1].initialFindings ?? []).length, expectFinding ? 1 : 0);
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
    replies: [{ match: /impl-a:implement/, reply: null }, { match: /impl-b:implement/, reply: built('b') }, { match: /:join$/, reply: joined('b') }],
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
