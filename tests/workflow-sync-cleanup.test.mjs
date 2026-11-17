// Tests for home/workflows/sync-machines.js and git-cleanup.js against the stubbed runtime of tests/workflow-more-helpers.mjs.
// Exports: none (node:test file).
// Invariants: expected behaviour comes from the spec (section 7): sync stops unless the base folder is ready (no tracked
// changes, git-tidy clean, suite PASS at the tip), runs both machines side by side and never pushes; cleanup applies
// only what the plan cleared, one repo at a time without a barrier between repos, and hands owner items back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScript } from './workflow-more-helpers.mjs';

const SYNC_ARGS = { row: 's1', repo: '/r', base: 'main' };
const READY = { ok: true, sha: 'abc123', problems: [] };
const syncReplies = (overrides = []) => [
  ...overrides,
  { label: /:verify/, reply: READY },
  { label: /:sync:/, reply: (call) => ({ ok: true, sha: 'abc123', tail: call.label }) },
  { label: /:doctor:/, reply: { exit: 0, tail: 'ok' } },
  { label: /:diagnose:/, reply: 'cause' },
];

test('sync: a base folder that is not ready stops the run before any machine is touched', async () => {
  const notReady = { ok: false, sha: 'abc123', problems: ['no suite PASS at abc123'] };
  const run = await runScript('sync-machines', SYNC_ARGS, { replies: syncReplies([{ label: /:verify/, reply: notReady }]) });
  assert.deepEqual(run.result, { status: 'stopped', problems: ['no suite PASS at abc123'] });
  assert.deepEqual(run.calls.map((c) => c.label), ['s1:verify']);
});

test('sync: both machines sync side by side, then each runs doctor; the result has sha and doctor exit per machine', async () => {
  const waitForPc = async (call, ctx) => { await ctx.started(/:sync:pc/); return { ok: true, sha: 'abc123', tail: call.label }; };
  const run = await runScript('sync-machines', SYNC_ARGS, { replies: syncReplies([{ label: /:sync:macbook/, reply: waitForPc }]) });
  const at = (event) => run.events.indexOf(event);
  assert.ok(at('start:s1:sync:pc') < at('end:s1:sync:macbook'), 'the PC does not wait for the MacBook');
  assert.ok(at('end:s1:sync:pc') < at('start:s1:doctor:pc'));
  assert.deepEqual(run.result, { status: 'synced', machines: [
    { machine: 'macbook', synced: true, sha: 'abc123', doctorExit: 0, diagnosis: '' },
    { machine: 'pc', synced: true, sha: 'abc123', doctorExit: 0, diagnosis: '' },
  ] });
});

test('sync: a machine that cannot sync skips its doctor and gets a diagnosis; the other machine goes on', async () => {
  const failed = { label: /:sync:pc/, reply: { ok: false, sha: '', tail: 'not possible to fast-forward' } };
  const run = await runScript('sync-machines', SYNC_ARGS, { replies: syncReplies([failed]) });
  assert.equal(run.calls.some((c) => c.label === 's1:doctor:pc'), false);
  assert.equal(run.calls.some((c) => c.label === 's1:doctor:macbook'), true);
  assert.deepEqual(run.result.machines[1], { machine: 'pc', synced: false, sha: '', doctorExit: null, diagnosis: 'cause' });
});

test('sync: the PC steps are bundle, copy, ff-only pull, install, doctor over ssh; nothing pushes', async () => {
  const run = await runScript('sync-machines', SYNC_ARGS, { replies: syncReplies() });
  const pc = run.calls.find((c) => c.label === 's1:sync:pc').prompt;
  for (const part of ['git -C /r bundle create', 'scp', 'ssh pc', 'git pull --ff-only', 'scripts/install.sh']) assert.ok(pc.includes(part), part);
  for (const call of run.calls) {
    assert.doesNotMatch(call.prompt, /git push|reset --hard/, call.label);
    assert.deepEqual([call.agentType, call.model, call.effort].slice(0, 1), call.label.includes('diagnose') ? ['general-purpose'] : ['runner'], call.label);
    assert.match(call.label, /^s1:/);
  }
});

test('sync: a bad args object throws the named error before any agent starts', async () => {
  const run = await runScript('sync-machines', { row: 's1', repo: '/r' }, { replies: syncReplies() });
  assert.equal(run.error.message, 'sync-machines: args.base must be string');
  assert.equal(run.calls.length, 0);
});

const CLEAN_ARGS = { row: 'g1', repos: ['/repo-a', '/repo-b'] };
const repoOf = (call) => call.prompt.match(/Repo (\/repo-\w)/)[1];
const cleanReplies = (overrides = []) => [
  ...overrides,
  { label: /:inventory:/, reply: (call) => ({ repo: repoOf(call), checkFile: '/c.json', pruneFile: '/p.json', findings: 3, planned: 2 }) },
  { label: /:plan:/, reply: (call) => ({ repo: repoOf(call), safe: [{ ref: 'old-1', proof: 'patch-id equal' }], needsLanding: [{ ref: 'lane/x', why: 'unique commit' }], ownerDecisions: [{ ref: 'rescue', question: 'keep?' }], pruneVeto: [] }) },
  { label: /:apply:/, reply: (call) => ({ repo: repoOf(call), pruneExit: 0, checkExit: 0, remaining: 0 }) },
];

test('cleanup: each repo runs inventory, plan, apply in order, with no barrier between repos', async () => {
  const slowPlanA = async (call, ctx) => { await ctx.started(/:apply:repo-b/); return { repo: '/repo-a', safe: [], needsLanding: [], ownerDecisions: [], pruneVeto: [] }; };
  const run = await runScript('git-cleanup', CLEAN_ARGS, { replies: cleanReplies([{ label: /:plan:repo-a/, reply: slowPlanA }]) });
  assert.equal(run.error, null);
  const at = (event) => run.events.indexOf(event);
  for (const repo of ['repo-a', 'repo-b']) assert.ok(at(`end:g1:inventory:${repo}`) < at(`start:g1:plan:${repo}`) && at(`end:g1:plan:${repo}`) < at(`start:g1:apply:${repo}`), repo);
  assert.ok(at('start:g1:apply:repo-b') < at('end:g1:plan:repo-a'), 'repo B moves on while repo A is still planned');
});

test('cleanup: an item the plan vetoes stops the apply for that repo and goes to the owner list', async () => {
  const veto = { label: /:plan:repo-b/, reply: { repo: '/repo-b', safe: [], needsLanding: [], ownerDecisions: [], pruneVeto: [{ ref: 'feature/y', why: 'has 2 unique commits' }] } };
  const run = await runScript('git-cleanup', CLEAN_ARGS, { replies: cleanReplies([veto]) });
  assert.equal(run.calls.some((c) => c.label === 'g1:apply:repo-b'), false);
  assert.equal(run.calls.some((c) => c.label === 'g1:apply:repo-a'), true);
  const repoB = run.result.repos.find((r) => r.repo === '/repo-b');
  assert.equal(repoB.applied, false);
  assert.ok(run.result.ownerItems.some((i) => i.repo === '/repo-b' && i.ref === 'feature/y' && /unique commits/.test(i.question)));
});

test('cleanup: the apply step bundles first, applies only what prune lists, checks again; the owner items come back', async () => {
  const run = await runScript('git-cleanup', CLEAN_ARGS, { replies: cleanReplies() });
  const apply = run.calls.find((c) => c.label === 'g1:apply:repo-a').prompt;
  assert.ok(apply.includes('bundle create'), 'a backup bundle is made first');
  assert.ok(apply.indexOf('bundle create') < apply.indexOf('prune') && apply.indexOf('prune') < apply.lastIndexOf('check'), 'bundle, prune, then check');
  assert.match(apply, /prune \/repo-a --apply/);
  for (const call of run.calls) assert.doesNotMatch(call.prompt, /git push|branch -D|reset --hard/, call.label);
  assert.deepEqual(run.result.ownerItems.filter((i) => i.repo === '/repo-a'), [{ repo: '/repo-a', ref: 'rescue', question: 'keep?' }, { repo: '/repo-a', ref: 'lane/x', question: 'NEEDS LANDING: unique commit' }]);
  assert.equal(run.result.repos[0].applied, true);
});

test('cleanup: a bad args object throws the named error before any agent starts', async () => {
  const run = await runScript('git-cleanup', { row: 'g1', repos: '/repo-a' }, { replies: cleanReplies() });
  assert.equal(run.error.message, 'git-cleanup: args.repos must be array');
  assert.equal(run.calls.length, 0);
});
