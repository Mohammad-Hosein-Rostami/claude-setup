// Tests for home/workflows/sync-machines.js and git-cleanup.js in tests/workflow-sandbox.mjs.
// Exports: none (node:test file).
// Invariants: expected behaviour comes from the spec (section 7): sync stops unless the base folder is ready (no tracked
// changes, git-tidy clean, suite PASS at the tip), runs both machines side by side and never pushes; cleanup applies
// only what the plan cleared, one repo at a time without a barrier between repos, and hands owner items back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScript as runPath } from './workflow-sandbox.mjs';

const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), '..', 'home', 'workflows');
const runScript = (name, args, setup) => runPath(join(WORKFLOWS, `${name}.js`), args, setup);
const gate = () => { let open; const opened = new Promise((resolve) => { open = resolve; }); return { opened, open }; };

// The suite check (4) runs only with `test` on and the audit-log check (5) only with `review` on (spec-checks-off): these cases test the on path.
const SYNC_ARGS = { row: 's1', repo: '/r', base: 'main', checks: ['test', 'review'] };
const READY = { exits: [0, 0, 0, 0, 0], sha: 'abc123', problems: [], targets: [{ name: 'pc', ssh: 'pc' }] };
const PINNED_CLI = { version: '2.1.326', channel: 'latest', pinned: true, pin: '' };
const syncReplies = (overrides = []) => [
  ...overrides,
  { match: /:verify/, reply: READY },
  { match: /:cli:/, reply: PINNED_CLI },
  { match: /:sync:/, reply: (_prompt, opts) => ({ exits: [0], sha: 'abc123', tail: opts.label }) },
  { match: /:doctor:/, reply: { exit: 0, tail: 'ok' } },
  { match: /:diagnose:/, reply: 'cause' },
];

test('sync: a base folder that is not ready stops the run before any machine is touched', async () => {
  const notReady = { exits: [0, 0, 0, 1], sha: 'abc123', problems: ['no suite PASS at abc123'] };
  const run = await runScript('sync-machines', SYNC_ARGS, { replies: syncReplies([{ match: /:verify/, reply: notReady }]) });
  assert.deepEqual(run.result, { status: 'stopped', problems: ['no suite PASS at abc123'] });
  assert.deepEqual(run.started, ['s1:verify']);
});

test('sync: both machines sync side by side, then each runs doctor; the result has sha and doctor exit per machine', async () => {
  const pcStarted = gate();
  let pcStartedBeforeMacbookEnded = false;
  const syncOk = { exits: [0], sha: 'abc123', tail: '' };
  const run = await runScript('sync-machines', SYNC_ARGS, { replies: syncReplies([
    { match: /:sync:macbook/, reply: async () => { await pcStarted.opened; pcStartedBeforeMacbookEnded = true; return syncOk; } },
    { match: /:sync:pc/, reply: () => { pcStarted.open(); return syncOk; } },
  ]) });
  assert.equal(pcStartedBeforeMacbookEnded, true, 'the PC does not wait for the MacBook');
  assert.ok(run.started.indexOf('s1:sync:pc') < run.started.indexOf('s1:doctor:pc'));
  assert.deepEqual(run.result, { status: 'synced', machines: [
    { machine: 'macbook', synced: true, sha: 'abc123', doctorExit: 0, diagnosis: '' },
    { machine: 'pc', synced: true, sha: 'abc123', doctorExit: 0, diagnosis: '' },
  ] });
});

test('sync: a machine that cannot sync skips its doctor and gets a diagnosis; the other machine goes on', async () => {
  const failed = { match: /:sync:pc/, reply: { exits: [0, 1], sha: '', tail: 'not possible to fast-forward' } };
  const run = await runScript('sync-machines', SYNC_ARGS, { replies: syncReplies([failed]) });
  assert.equal(run.started.includes('s1:doctor:pc'), false);
  assert.equal(run.started.includes('s1:doctor:macbook'), true);
  assert.deepEqual(run.result.machines[1], { machine: 'pc', synced: false, sha: '', doctorExit: null, diagnosis: 'cause' });
  assert.equal(run.result.status, 'partial', 'a machine failed: not "synced"');
});

test('sync: a failed doctor is partial too, and a machine whose steps crash still gets its own row', async () => {
  const doctorFails = await runScript('sync-machines', SYNC_ARGS, { replies: syncReplies([{ match: /:doctor:pc/, reply: { exit: 1, tail: 'FAIL hooks' } }]) });
  assert.equal(doctorFails.result.status, 'partial');
  assert.equal(doctorFails.result.machines[1].doctorExit, 1);
  const crashed = await runScript('sync-machines', SYNC_ARGS, { replies: syncReplies([{ match: /:doctor:macbook/, reply: () => { throw new Error('runner died'); } }]) });
  assert.equal(crashed.result.status, 'partial');
  assert.deepEqual(crashed.result.machines.map((m) => [m.machine, m.synced]), [['macbook', false], ['pc', true]]);
  assert.match(crashed.result.machines[0].diagnosis, /returned nothing/);
});

test('sync: the PC steps are bundle, copy, ff-only pull, install, doctor over ssh; nothing pushes', async () => {
  const run = await runScript('sync-machines', SYNC_ARGS, { replies: syncReplies() });
  const pc = run.calls.find((c) => c.label === 's1:sync:pc').prompt;
  for (const part of ['git -C /r bundle create', 'scp', 'ssh pc', 'git pull --ff-only', 'scripts/install.sh']) assert.ok(pc.includes(part), part);
  for (const call of run.calls) {
    assert.doesNotMatch(call.prompt, /git push|reset --hard/, call.label);
    assert.equal(call.opts.agentType, call.label.includes('diagnose') ? 'general-purpose' : 'runner', call.label);
    assert.match(call.label, /^s1:/);
  }
});

// A target whose ssh host differs from its name, so a prompt that used the name instead of the host fails.
const PC_HOST = 'me@pc.local';
const PC_READY = { ...READY, targets: [{ name: 'pc', ssh: PC_HOST }] };
const pcReplies = (overrides = []) => syncReplies([{ match: /:verify/, reply: PC_READY }, ...overrides]);
const PATH_EXPORT = 'export PATH="$HOME/.volta/bin:/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$PATH";';
// perl's alarm survives exec; `or die` makes a failed exec exit non-zero instead of 0.
const alarmed = (seconds) => `perl -e 'alarm ${seconds}; exec @ARGV or die "exec: $!"'`;

test('sync: every remote command runs as an alarmed ssh to the checked host with the PATH export inside its quotes; the local ones do not', async () => {
  const run = await runScript('sync-machines', SYNC_ARGS, { replies: pcReplies() });
  // seconds per label: a remote check 120; the pull and install 540 (under the 600 s Bash maximum); doctor 660 (over its 600 s Bash timeout)
  for (const [label, seconds] of [['s1:cli:pc', 120], ['s1:sync:pc', 540], ['s1:doctor:pc', 660]]) {
    const prompt = run.calls.find((c) => c.label === label).prompt;
    assert.ok(prompt.includes(`${alarmed(seconds)} ssh ${PC_HOST} '${PATH_EXPORT} <command>'`), `${label}: alarmed ssh with the export inside the quotes`);
    assert.doesNotMatch(prompt, /ssh pc\b/, `${label}: the host, not the name`);
  }
  for (const label of ['s1:cli:macbook', 's1:sync:macbook', 's1:doctor:macbook']) {
    const prompt = run.calls.find((c) => c.label === label).prompt;
    assert.doesNotMatch(prompt, /export PATH|perl -e/, `${label}: local prompt unchanged`);
  }
});

test('sync: the bundle copy to the target runs under its own alarm, 300 s', async () => {
  const run = await runScript('sync-machines', SYNC_ARGS, { replies: pcReplies() });
  const prompt = run.calls.find((c) => c.label === 's1:sync:pc').prompt;
  assert.ok(prompt.includes(`${alarmed(300)} scp /tmp/s1-sync-pc.bundle /tmp/s1-local-shared.json ${PC_HOST}:/tmp/`), 'scp under the alarm');
  assert.match(prompt, /ssh and scp as a foreground Bash command with timeout: 600000/, 'the alarms fire inside the Bash tool maximum');
  assert.equal(prompt.split('scp /tmp/').length - 1, 1, 'one scp command, the alarmed one');
});

test('sync: the version check after the install runs inside the target step; the local one stays after the install step', async () => {
  const run = await runScript('sync-machines', SYNC_ARGS, { replies: pcReplies() });
  const pc = run.calls.find((c) => c.label === 's1:sync:pc').prompt;
  assert.equal(pc.split('claude --version').length - 1, 1, 'once');
  assert.ok(pc.indexOf('claude --version') > pc.indexOf('(2) On pc, over ssh'), 'inside step (2), which is over ssh with the export');
  assert.doesNotMatch(pc, /After the install run claude --version/);
  const local = run.calls.find((c) => c.label === 's1:sync:macbook').prompt;
  assert.match(local, /then report git rev-parse HEAD\. After the install run claude --version once/);
});

test('sync: the diagnose prompt for a target carries the same remote rule (the local one does not)', async () => {
  const failed = { match: /:sync:pc/, reply: { exits: [1], sha: '', tail: 'boom' } };
  const run = await runScript('sync-machines', SYNC_ARGS, { replies: pcReplies([failed]) });
  const pc = run.calls.find((c) => c.label === 's1:diagnose:pc').prompt;
  assert.ok(pc.includes(`${alarmed(120)} ssh ${PC_HOST} '${PATH_EXPORT} <command>'`), 'alarmed ssh with the export');
  assert.match(pc, /Read only/);
  assert.ok(pc.includes(`a fix command for pc starts with ${PATH_EXPORT}`), 'the fix command carries the export');
  const failedLocal = { match: /:sync:macbook/, reply: { exits: [1], sha: '', tail: 'boom' } };
  const localRun = await runScript('sync-machines', SYNC_ARGS, { replies: pcReplies([failedLocal]) });
  assert.doesNotMatch(localRun.calls.find((c) => c.label === 's1:diagnose:macbook').prompt, /export PATH|perl -e/);
});

test('sync: the doctor runner runs one foreground command with a 10 minute Bash timeout, never in the background and never polling', async () => {
  const run = await runScript('sync-machines', SYNC_ARGS, { replies: syncReplies() });
  for (const machine of ['macbook', 'pc']) {
    const prompt = run.calls.find((c) => c.label === `s1:doctor:${machine}`).prompt;
    assert.match(prompt, /timeout: 600000/);
    assert.match(prompt, /ONE foreground Bash command/);
    assert.match(prompt, /never in a polling loop/);
    assert.match(prompt, /never in the background/);
    assert.match(prompt, /never (start it )?in the background|do not background/i);
    assert.doesNotMatch(prompt, /start it in the background/);
  }
});

test('sync: the verify step also checks the audit-log gate for the tip when the tool exists', async () => {
  const run = await runScript('sync-machines', SYNC_ARGS, { replies: syncReplies() });
  const prompt = run.calls.find((c) => c.label === 's1:verify').prompt;
  // The repo's own copy, not the installed one: a copied or stale install would skip the gate or run an old one.
  assert.match(prompt, /\(5\) when \/r\/home\/tools\/review-tier\/audit-log\.mjs exists, node \/r\/home\/tools\/review-tier\/audit-log\.mjs gate --repo \/r --tip SHA exits 0/);
});

test('sync: a bad args object throws the named error before any agent starts', async () => {
  const run = await runScript('sync-machines', { row: 's1', repo: '/r' }, { replies: syncReplies() });
  assert.equal(run.error.message, 'sync-machines: args.base must be a string');
  assert.equal(run.calls.length, 0);
});

const CLEAN_ARGS = { row: 'g1', repos: ['/repo-a', '/repo-b'] };
const repoOf = (prompt) => prompt.match(/Repo (\/repo-\w)/)[1];
const cleanReplies = (overrides = []) => [
  ...overrides,
  { match: /:inventory:/, reply: (prompt) => ({ repo: repoOf(prompt), checkFile: '/c.json', pruneFile: '/p.json', findings: 3, planned: 2 }) },
  { match: /:plan:/, reply: (prompt) => ({ repo: repoOf(prompt), safe: [{ ref: 'old-1', proof: 'patch-id equal' }], needsLanding: [{ ref: 'lane/x', why: 'unique commit' }], ownerDecisions: [{ ref: 'rescue', question: 'keep?' }], pruneVeto: [] }) },
  { match: /:apply:/, reply: (prompt) => ({ repo: repoOf(prompt), pruneExit: 0, checkExit: 0, remaining: 0 }) },
];

test('cleanup: each repo runs inventory, plan, apply in order, with no barrier between repos', async () => {
  const repoBApplied = gate();
  const slowPlanA = async () => { await repoBApplied.opened; return { repo: '/repo-a', safe: [], needsLanding: [], ownerDecisions: [], pruneVeto: [] }; };
  let repoBAppliedBeforePlanAEnded = false;
  const run = await runScript('git-cleanup', CLEAN_ARGS, { replies: cleanReplies([
    { match: /:plan:repo-a/, reply: async () => { const planned = await slowPlanA(); repoBAppliedBeforePlanAEnded = true; return planned; } },
    { match: /:apply:repo-b/, reply: () => { repoBApplied.open(); return { repo: '/repo-b', pruneExit: 0, checkExit: 0, remaining: 0 }; } },
  ]) });
  assert.equal(run.error, null);
  const at = (label) => run.started.indexOf(label);
  for (const repo of ['repo-a', 'repo-b']) assert.ok(at(`g1:inventory:${repo}`) < at(`g1:plan:${repo}`) && at(`g1:plan:${repo}`) < at(`g1:apply:${repo}`), repo);
  assert.equal(repoBAppliedBeforePlanAEnded, true, 'repo B moves on while repo A is still planned');
});

test('cleanup: an item the plan vetoes stops the apply for that repo and goes to the owner list', async () => {
  const veto = { match: /:plan:repo-b/, reply: { repo: '/repo-b', safe: [], needsLanding: [], ownerDecisions: [], pruneVeto: [{ ref: 'feature/y', why: 'has 2 unique commits' }] } };
  const run = await runScript('git-cleanup', CLEAN_ARGS, { replies: cleanReplies([veto]) });
  assert.equal(run.started.includes('g1:apply:repo-b'), false);
  assert.equal(run.started.includes('g1:apply:repo-a'), true);
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
  assert.equal(run.error.message, 'git-cleanup: args.repos must be an array');
  assert.equal(run.calls.length, 0);
});

test('sync: checks off (no args.checks) skips the suite and audit-log checks, so four exit codes are enough and the machines sync', async () => {
  const { checks, ...checksOff } = SYNC_ARGS;
  const verified = { ...READY, exits: [0, 0, 0, 0] };
  const run = await runScript('sync-machines', checksOff, { replies: syncReplies([{ match: /:verify/, reply: verified }]) });
  assert.equal(run.result.status, 'synced');
  const prompt = run.calls.find((call) => call.label === 's1:verify').prompt;
  assert.match(prompt, /\(4\) skipped \(test check off\)/);
  assert.match(prompt, /\(5\) skipped \(review check off\)/);
  assert.doesNotMatch(prompt, /test-pass\.mjs check|audit-log\.mjs gate/);
});
