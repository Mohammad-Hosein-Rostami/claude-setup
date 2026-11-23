// Tests of the done-check's stable Go base folder (fixes spec X33, go-base): lib/base-go-folder.mjs and its use by lib/base-run.mjs
// baseTree({ stableFor: 'go' }) and lib/base-compare.mjs. A second base of the same Go sources reuses Go's build cache (goprobe4); the
// folder's lock answers `base folder busy` while a live run holds it and is broken only after LOCK_STALE_MS without a refresh; the
// holder's heartbeat keeps it fresh; the 7-day sweep removes other repos' idle folders and never a held one; a busy base never blocks on
// failures off the change, while new drift on the change still blocks.
// Invariants: every repo and HOME is a temp folder (the fixture's), Go gets its own GOCACHE, GOMODCACHE and GOPATH in a cs-test temp
// folder, GOTOOLCHAIN=local, GOPROXY=off and empty GOFLAGS; Go cases skip (with the reason) only where go is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimStableFolder, LOCK_HEARTBEAT_MS, LOCK_STALE_MS, STABLE_IDLE_MS, stableFolderOf } from '../home/tools/done-check/lib/base-go-folder.mjs';
import { baseTree } from '../home/tools/done-check/lib/base-run.mjs';
import { goBinary } from '../home/tools/done-check/lib/go-plan.mjs';
import { makeDoneCheckRepo } from './done-check-fixture.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const CLI = fileURLToPath(new URL('../home/tools/done-check/done-check.mjs', import.meta.url));
const needsGo = { skip: !goBinary(process.env) && 'go is not installed' };
const goHome = makeTempDir('go-base-cache-');
const GO_ENV = { GOCACHE: join(goHome, 'build'), GOMODCACHE: join(goHome, 'mod'), GOPATH: join(goHome, 'path'), GOTOOLCHAIN: 'local', GOFLAGS: '', GOPROXY: 'off', GOTELEMETRY: 'off', GOWORK: 'off' };
const GO_MOD = 'module example.com/m\n\ngo 1.22\n';
const OLD_DRIFT = 'package a\n\nfunc  A() int { return 1 }\n';
const KIB = 1024;
const SECOND_BASE_GROWTH_MAX_KIB = 200; // goprobe4: the head's own recompile of the edited package is ~80 KiB; a cold base adds ~450 KiB
const HEARTBEAT_WAIT_MS = 3 * LOCK_HEARTBEAT_MS;
const POLL_MS = 100;

const stateOf = (repo) => join(repo.home, '.claude', 'state', 'done-check');
const commonDirOf = (repo) => execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repo.dir, encoding: 'utf8' }).trim();
const folderOf = (repo) => stableFolderOf(stateOf(repo), commonDirOf(repo));
const secondsAgo = (seconds) => new Date(Date.now() - seconds * 1000);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** The size in KiB of every file under `dir` (0 when it does not exist). */
function sizeKib(dir) {
  if (!existsSync(dir)) return 0;
  let bytes = 0;
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) if (entry.isFile()) bytes += statSync(join(entry.parentPath, entry.name)).size;
  return bytes / KIB;
}

/** A git Go module with `base` committed (the base) and `change` committed on top. */
function goRepo(t, base, change) {
  const repo = makeDoneCheckRepo({ files: { 'go.mod': GO_MOD, ...base } });
  t.after(() => repo.cleanup());
  for (const [file, text] of Object.entries(change)) repo.write(file, text);
  repo.commit('change');
  return repo;
}
function runCli(repo, base = repo.baseSha) {
  const ran = repo.run(CLI, ['run', '--worktree', repo.dir, '--base', base, '--json'], { env: GO_ENV });
  return { code: ran.status, verdict: JSON.parse(ran.stdout) };
}
/** A lock file planted at the repo's stable folder, `ageSeconds` old (a run that holds it, or a killed run's when old enough). */
function plantLock(repo, ageSeconds) {
  const folder = folderOf(repo);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeFileSync(join(folder, 'lock'), '');
  utimesSync(join(folder, 'lock'), secondsAgo(ageSeconds), secondsAgo(ageSeconds));
  return join(folder, 'lock');
}

test('goprobe4: a second base sha with the same Go sources reuses the build cache of the one stable folder', needsGo, (t) => {
  const libs = Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`l${n}/l.go`, `package l${n}\n\nimport "strings"\n\nfunc F(s string) string { return strings.ToUpper(s) + "${n}" }\n`]));
  const imports = [1, 2, 3, 4, 5, 6].map((n) => `\t"example.com/m/l${n}"`).join('\n');
  const aGo = `package a\n\nimport (\n${imports}\n)\n\nfunc A() string { return l1.F("x") + l2.F("x") + l3.F("x") + l4.F("x") + l5.F("x") + l6.F("x") }\n`;
  const repo = goRepo(t, { ...libs, 'a/a.go': aGo, 'a/a_test.go': 'package a\n\nimport "testing"\n\nfunc TestOld(t *testing.T) { t.Fatal("old failure") }\n' }, { 'a/a.go': `${aGo}\n// edit 1\n` });
  const first = runCli(repo);
  assert.equal(first.code, 0, first.verdict.line);
  assert.match(first.verdict.line, /tests ok, 1 old fail/);
  assert.ok(existsSync(join(folderOf(repo), 'tree', 'a', 'a.go')), 'the base tree is in the stable folder');
  assert.ok(!existsSync(join(folderOf(repo), 'lock')), 'the lock is released after the run');
  // a new base that changes no Go file (as after a rebase onto main), and one more edit at head
  const firstBase = repo.baseSha;
  repo.write('README', 'n\n');
  const secondBase = repo.commit('second base');
  repo.write('a/a.go', `${aGo}\n// edit 2\n`);
  repo.commit('edit 2');
  assert.notEqual(secondBase, firstBase);
  const before = sizeKib(GO_ENV.GOCACHE);
  const second = runCli(repo, secondBase);
  const growth = sizeKib(GO_ENV.GOCACHE) - before;
  assert.equal(second.code, 0, second.verdict.line);
  assert.match(second.verdict.line, /tests ok, 1 old fail/);
  assert.ok(growth < SECOND_BASE_GROWTH_MAX_KIB, `GOCACHE grew ${growth.toFixed(0)} KiB on the second base`);
});

test('lock: a fresh lock is a live holder (base folder busy); only one unrefreshed for LOCK_STALE_MS is broken', async (t) => {
  const repo = makeDoneCheckRepo({ files: { 'go.mod': GO_MOD } });
  t.after(() => repo.cleanup());
  const lock = plantLock(repo, LOCK_STALE_MS / 1000 - 5);
  assert.deepEqual(await baseTree(repo.dir, repo.baseSha, { stableFor: 'go', env: repo.env }), { unavailable: 'base folder busy' });
  assert.ok(existsSync(lock), 'a live holder keeps its lock');
  utimesSync(lock, secondsAgo(LOCK_STALE_MS / 1000 + 5), secondsAgo(LOCK_STALE_MS / 1000 + 5));
  const tree = await baseTree(repo.dir, repo.baseSha, { stableFor: 'go', env: repo.env });
  assert.equal(tree.dir, join(folderOf(repo), 'tree'));
  assert.deepEqual(await baseTree(repo.dir, repo.baseSha, { stableFor: 'go', env: repo.env }), { unavailable: 'base folder busy' }); // while held
  tree.cleanup();
  tree.cleanup(); // twice is harmless
  assert.ok(!existsSync(lock) && existsSync(join(tree.dir, 'go.mod')), 'cleanup releases the lock and keeps the tree');
});

test('lock: the holder refreshes its lock, so a long base run is never taken as stale', async (t) => {
  const repo = makeDoneCheckRepo({ files: { 'go.mod': GO_MOD } });
  t.after(() => repo.cleanup());
  const claimed = claimStableFolder(stateOf(repo), commonDirOf(repo));
  t.after(() => claimed.release());
  const lock = join(claimed.folder, 'lock');
  const old = secondsAgo(LOCK_STALE_MS / 1000 + 5);
  utimesSync(lock, old, old); // as if the holder had been slow for over a minute
  for (let waited = 0; waited < HEARTBEAT_WAIT_MS && lstatSync(lock).mtimeMs <= old.getTime(); waited += POLL_MS) await sleep(POLL_MS);
  assert.ok(lstatSync(lock).mtimeMs > old.getTime(), 'the heartbeat refreshed the lock');
  assert.deepEqual(claimStableFolder(stateOf(repo), commonDirOf(repo)), { unavailable: 'base folder busy' });
});

test('sweep: another repo\'s folder idle for 7 days is removed, a held or recently used one never', (t) => {
  const repo = makeDoneCheckRepo({ files: { 'go.mod': GO_MOD } });
  t.after(() => repo.cleanup());
  const parent = join(stateOf(repo), 'base-go');
  const idleAgo = secondsAgo(STABLE_IDLE_MS / 1000 + 3600);
  const other = (name, { held }) => {
    const folder = join(parent, name.repeat(64));
    mkdirSync(join(folder, 'tree'), { recursive: true, mode: 0o700 });
    if (held) writeFileSync(join(folder, 'lock'), '');
    utimesSync(join(folder, 'tree'), idleAgo, idleAgo);
    return folder;
  };
  const idle = other('a', { held: false });
  const held = other('b', { held: true });
  const recent = join(parent, 'c'.repeat(64));
  mkdirSync(join(recent, 'tree'), { recursive: true, mode: 0o700 });
  const claimed = claimStableFolder(stateOf(repo), commonDirOf(repo));
  claimed.release();
  assert.ok(!existsSync(idle), 'the idle folder is removed');
  assert.ok(existsSync(join(held, 'tree')) && existsSync(join(held, 'lock')), 'a held folder stays, whatever its age');
  assert.ok(existsSync(join(recent, 'tree')), 'a recently used folder stays');
});

test('busy base: old drift off the changed lines is unknown and does not block; new drift on them still blocks', needsGo, (t) => {
  const repo = goRepo(t, { 'a/a.go': OLD_DRIFT }, { 'a/a.go': `${OLD_DRIFT}\n// touched\n` });
  plantLock(repo, 0);
  const offChange = runCli(repo);
  assert.equal(offChange.code, 0, offChange.verdict.line);
  assert.equal(offChange.verdict.verdict, 'left-open');
  assert.match(offChange.verdict.line, /FAIL left open \(lint 0 new, 1 unknown\)/);
  assert.match(offChange.verdict.line, /base: unavailable/);
  repo.write('a/a.go', `${OLD_DRIFT}\n// touched\n\nfunc   B() int {return 2}\n`);
  repo.commit('new drift');
  const onChange = runCli(repo);
  assert.equal(onChange.code, 1, onChange.verdict.line);
  assert.match(onChange.verdict.reason, /may be older than your change/);
});
