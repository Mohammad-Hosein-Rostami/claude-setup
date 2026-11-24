// Tests for home/hooks/git-tidy-gate.mjs, now SessionStart only: it names the lanes of the session's repo that are not yet landed,
// never blocks, caches the check verdict per repo state, never runs a program the repository config names, and says nothing (exit 0)
// outside a repository, on bad input or on another event. Every repo and HOME is a cs-test temp folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cachedVerdict, storeVerdict } from '../home/hooks/lib/tidy-gate-store.mjs';
import { addWorktree, CLEAN_ENV, commit, git, makeRepo } from './git-tidy-helpers.mjs';
import { gateSession, HOOK, inProcessGate, oldLane, SESSION } from './git-tidy-gate-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const MINUTE_MS = 60_000;
const REFRESH_WAIT_MS = 20_000; // the detached refresh of a loaded machine
const POLL_MS = 100;

test('a repo with no unlanded lane prints nothing at session start', () => {
  assert.equal(gateSession().start(makeRepo()), null);
});

test('an unlanded lane is named at session start, one line each, under the repo folder', () => {
  const dir = makeRepo();
  oldLane(dir, 'lane/one');
  const text = gateSession().start(dir);
  assert.match(text, /^git: lanes not yet landed in .+ \(land or prune them, one line of history\):\n- lane\/one: /);
  assert.equal(text.split('\n').length, 2, text);
});

test('a cache hit runs no check; a verdict older than ten minutes is checked again', async () => {
  const dir = makeRepo();
  oldLane(dir, 'lane/one');
  const gate = inProcessGate(dir);
  assert.match(await gate.start(), /lane\/one/);
  let runs = 0;
  const countingCheck = () => {
    runs += 1;
    return { base: 'main', findings: [], hints: [] };
  };
  assert.match(await gate.start({ runCheck: countingCheck, now: Date.now() + MINUTE_MS }), /lane\/one/, 'one minute later the cache answers');
  assert.equal(runs, 0);
  assert.equal(await gate.start({ runCheck: countingCheck, now: Date.now() + 11 * MINUTE_MS }), '', 'eleven minutes later the check runs again');
  assert.equal(runs, 1);
});

test('a check that is not done in time says nothing, and one detached refresh fills the cache for the next start', async () => {
  const dir = makeRepo();
  oldLane(dir, 'lane/late');
  const gate = inProcessGate(dir);
  assert.equal(await gate.start({ checkTimeoutMs: 1 }), '');
  const deadline = Date.now() + REFRESH_WAIT_MS;
  let filled = false;
  while (!filled && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    filled = /lane\/late/.test(await gate.start({ runCheck: () => undefined })); // a cache miss runs this fake and names nothing
  }
  assert.ok(filled, 'the refresh stored the verdict');
});

test('the check child never runs a program the repository config names (fsmonitor)', () => {
  const dir = makeRepo();
  git(dir, 'checkout', '-q', '-b', 'lane/y');
  commit(dir, 'y.txt');
  git(dir, 'checkout', '-q', 'main');
  const worktree = addWorktree(dir, 'wt-y', 'lane/y', { create: false });
  const marker = join(makeTempDir('git-tidy-gate-marker-'), 'ran');
  const program = join(makeTempDir('git-tidy-gate-program-'), 'fsmonitor.sh');
  writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\nprintf '\\0'\n`);
  chmodSync(program, 0o755);
  git(dir, 'config', 'core.fsmonitor', program);
  git(dir, 'config', 'core.fsmonitor.hookversion', '2');
  git(worktree, 'status', '--porcelain');
  assert.ok(existsSync(marker), 'sanity: plain git runs the program');
  unlinkSync(marker);
  gateSession().start(dir);
  assert.ok(!existsSync(marker), 'the program did not run during the gate');
});

test('a repository whose own config, or another worktree\'s config view, defines a filter is never checked', () => {
  const own = makeRepo();
  oldLane(own, 'lane/one');
  git(own, 'config', 'filter.sneaky.clean', 'cat');
  assert.equal(gateSession().start(own), null);
  const shared = makeRepo();
  oldLane(shared, 'lane/two');
  const lane = addWorktree(shared, 'wt-lane', 'lane/y');
  const include = join(makeTempDir('git-tidy-gate-include-'), 'filter.cfg');
  writeFileSync(include, '[filter "sneaky"]\n\tclean = cat\n');
  git(shared, 'config', 'includeIf.onbranch:main.path', include); // only the worktree on main sees the filter
  assert.equal(gateSession().start(lane), null);
});

test('the check child never runs the gpg program of a signed commit (log.showSignature in the repository config)', () => {
  const dir = makeRepo();
  const marker = join(makeTempDir('git-tidy-gate-marker-'), 'ran');
  const program = join(makeTempDir('git-tidy-gate-gpg-'), 'gpg.sh');
  writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\ncase "$*" in *--verify*) exit 0;; esac\ncat >/dev/null\nprintf -- '-----BEGIN PGP SIGNATURE-----\\n\\nAAAA\\n-----END PGP SIGNATURE-----\\n'\nprintf '[GNUPG:] SIG_CREATED D 1 8 00 1 ABCD\\n' >&2\n`);
  chmodSync(program, 0o755);
  git(dir, 'config', 'gpg.program', program);
  git(dir, 'checkout', '-q', '-b', 'side');
  writeFileSync(join(dir, 's.txt'), 's');
  git(dir, 'add', 's.txt');
  git(dir, 'commit', '-q', '-S', '-m', 'signed side');
  git(dir, 'checkout', '-q', 'main');
  commit(dir, 'm.txt');
  git(dir, 'merge', '-q', '--no-ff', '-S', '-m', 'signed merge', 'side');
  oldLane(dir, 'lane/after-merge');
  git(dir, 'config', 'log.showSignature', 'true');
  if (existsSync(marker)) unlinkSync(marker); // signing the commits above ran the program too
  git(dir, 'log', '--merges', '--format=%s');
  assert.ok(existsSync(marker), 'sanity: plain git runs the program');
  unlinkSync(marker);
  assert.match(gateSession().start(dir), /lane\/after-merge/, 'the check ran');
  assert.ok(!existsSync(marker), 'the gate did not run the program');
});

test('the store drops the oldest repos before it would pass the size it can read back', () => {
  const env = { HOME: makeTempDir('git-tidy-gate-store-') };
  const verdict = { base: 'main', findings: [{ kind: 'merge-commit', subject: 'a', detail: 'z'.repeat(30_000) }], hints: [] };
  for (const top of ['/r/1', '/r/2', '/r/3']) storeVerdict(env, SESSION, { top, fingerprint: 'f' }, verdict);
  assert.deepEqual(cachedVerdict(env, SESSION, { top: '/r/3', fingerprint: 'f' }), verdict, 'the newest repo is kept');
  assert.equal(cachedVerdict(env, SESSION, { top: '/r/1', fingerprint: 'f' }), undefined, 'the oldest made room');
});

test('outside a git repository, with unusable input or with another event, the hook says nothing and exits 0', () => {
  const gate = gateSession();
  assert.equal(gate.start(makeTempDir('git-tidy-gate-plain-')), null);
  const dir = makeRepo();
  oldLane(dir, 'lane/one');
  assert.equal(gate.start(dir, { session_id: '../escape' }), null);
  for (const event of ['Stop', 'SubagentStop', 'PreCompact', 'PostToolUse']) {
    const result = gate.run({ hook_event_name: event, session_id: SESSION, cwd: dir }, dir);
    assert.deepEqual([result.status, result.stdout], [0, ''], event);
  }
  for (const input of ['not json', '']) {
    const garbage = spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8', env: { ...CLEAN_ENV, HOME: gate.home } });
    assert.deepEqual([garbage.status, garbage.stdout, garbage.stderr], [0, '', ''], JSON.stringify(input));
  }
});
