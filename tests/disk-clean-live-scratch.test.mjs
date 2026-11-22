// Tests for disk-clean's session-scratch rule (lib/clean-rules.mjs): in a session that runs for days, the scratchpad's cs-test-* and git
// clone folders in which nothing was modified for 2 days go (owner FR5); a newer one, any other name, a link, a linked worktree and a folder
// a lane still writes stay; a finished session's folder is counted once; a killed run's `.removing-*` folder is finished; two --apply runs
// at once remove each folder once. Fake roots only (disk-clean-helpers.mjs world()): the real HOME and scratchpad root are never read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { devNull } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClean } from '../home/tools/disk-free/disk-clean.mjs';
import { FIRST_SEEN_STORE, recordKey } from '../home/tools/disk-free/lib/first-seen.mjs';
import { age, cliEnv, DAY_MS, folder, NEWEST, OLD, posix, sessionFile, transcript, world } from './disk-clean-helpers.mjs';

const TOOL = fileURLToPath(new URL('../home/tools/disk-free/disk-clean.mjs', import.meta.url));
const LIVE = '12345678-0000-4000-8000-00000000000a';
const OLD_DAYS = 3; // past the rule's 2 days
const NEW_DAYS = 1; // inside them

/** The scratchpad of a running session (this test process's pid is alive, so the session-folders rule keeps the whole folder). */
function liveScratchpad(w) {
  sessionFile(w, process.pid, LIVE);
  const scratchpad = join(w.claudeTmp, '-proj', LIVE, 'scratchpad');
  mkdirSync(scratchpad, { recursive: true });
  return scratchpad;
}

/** The first-seen record's file in the world's home (lib/first-seen.mjs). */
const seenFile = (w) => join(FIRST_SEEN_STORE.folder(w.home), `${FIRST_SEEN_STORE.id}.json`);

/**
 * Writes the first-seen record as if disk-clean had first seen each folder `days` ago (a test cannot age a ctime, so the record is set
 * directly). A `.removing-<pid>-<name>` folder is keyed by its original name, as the rule keys it.
 */
function seenDaysAgo(w, days, ...paths) {
  const seen = {};
  for (const path of paths) {
    const keyPath = join(realpathSync(dirname(path)), basename(path).replace(/^\.removing-\d+-/, ''));
    seen[recordKey(keyPath, lstatSync(path))] = Date.now() - days * DAY_MS;
  }
  mkdirSync(FIRST_SEEN_STORE.folder(w.home), { recursive: true, mode: 0o700 });
  writeFileSync(seenFile(w), JSON.stringify({ v: 1, seen }), { mode: 0o600 });
}

/** git with a fixed identity and branch name, no config of the machine's owner. */
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args],
  { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' } });

/** Sets the times of a folder and of everything in it `days` back (a negative number is ahead of the clock). */
function ageTree(path, days) {
  for (const entry of readdirSync(path, { recursive: true })) age(join(path, entry), days);
  age(path, days);
  return path;
}

/** A repository with one commit, outside the scratchpad: the remote the clones come from. */
function originRepo(w) {
  const origin = join(w.root, 'origin');
  if (existsSync(origin)) return origin;
  mkdirSync(origin);
  git(origin, 'init', '-q');
  writeFileSync(join(origin, 'README.md'), 'x');
  git(origin, 'add', 'README.md');
  git(origin, 'commit', '-qm', 'first');
  return origin;
}

/** A clean clone (every commit on its remote), `days` old; `change(path)` may leave work in it before it is aged. */
function cloneFolder(w, path, days, change = () => {}) {
  // --no-hardlinks: a local clone shares object files with its origin by hard links, so aging one clone would age the others' objects
  git(w.root, 'clone', '-q', '--no-hardlinks', originRepo(w), path);
  change(path);
  return ageTree(path, days);
}

/** The live session's fixture: what must go and what must stay. */
function fixture(w) {
  const scratchpad = liveScratchpad(w);
  const outside = folder(join(w.root, 'outside-target'), { days: OLD_DAYS });
  const paths = {
    oldTest: folder(join(scratchpad, 'cs-test-x'), { days: OLD_DAYS }),
    oldClone: cloneFolder(w, join(scratchpad, 'clone'), OLD_DAYS),
    newTest: folder(join(scratchpad, 'cs-test-y'), { days: NEW_DAYS }),
    newClone: cloneFolder(w, join(scratchpad, 'fresh-clone'), NEW_DAYS),
    otherName: folder(join(scratchpad, 'probe-old'), { days: OLD_DAYS }),
    worktree: folder(join(scratchpad, 'wt'), { days: OLD_DAYS, files: { '.git': 'gitdir: /elsewhere/.git/worktrees/wt\n' } }),
    testFile: join(scratchpad, 'cs-test-notes.txt'),
    link: join(scratchpad, 'cs-test-link'),
    outside,
  };
  writeFileSync(paths.testFile, 'a file, not a folder');
  age(paths.testFile, OLD_DAYS);
  symlinkSync(outside, paths.link);
  seenDaysAgo(w, OLD_DAYS, paths.oldTest, paths.oldClone, paths.newTest, paths.newClone); // only the mtime tells these apart
  return paths;
}

const scratchRule = (summary) => summary.rules.find((rule) => rule.name === 'session-scratch');
const listed = (summary) => scratchRule(summary).sample.map((item) => item.path).sort();
const real = (...paths) => paths.map((path) => realpathSync(path)).sort(); // the rules report real paths (/var is /private/var on macOS)

test('live session: the dry run lists only the cs-test-* and clone folders idle 2 days; --apply removes only those', posix, async () => {
  const w = world();
  const paths = fixture(w);
  const dry = await runClean({ ...w.options, apply: false });
  assert.deepEqual(listed(dry), real(paths.oldClone, paths.oldTest));
  assert.equal(dry.rules.find((rule) => rule.name === 'session-folders').items, 0, 'the running session keeps its folder');
  const applied = await runClean(w.options);
  assert.deepEqual([applied.removed, applied.failed], [2, []]);
  assert.deepEqual([existsSync(paths.oldTest), existsSync(paths.oldClone)], [false, false]);
  for (const kept of ['newTest', 'newClone', 'otherName', 'worktree', 'testFile', 'link']) assert.equal(existsSync(paths[kept]), true, kept);
  assert.equal(existsSync(join(paths.outside, 'f.txt')), true, 'the link is never followed');
});

test('a folder a lane still writes stays: one new file anywhere inside keeps it, also when it appears right before the removal', posix, async () => {
  const w = world();
  const scratchpad = liveScratchpad(w);
  const deep = folder(join(scratchpad, 'cs-test-busy', 'repo', 'src'), { days: NEW_DAYS });
  for (const part of [join(scratchpad, 'cs-test-busy', 'repo'), join(scratchpad, 'cs-test-busy')]) age(part, OLD_DAYS);
  const late = folder(join(scratchpad, 'cs-test-late'), { days: OLD_DAYS });
  seenDaysAgo(w, OLD_DAYS, join(scratchpad, 'cs-test-busy'), late);
  const dry = await runClean({ ...w.options, apply: false });
  assert.deepEqual(listed(dry), real(late), `only the idle one: ${deep} was written a day ago`);
  const summary = await runClean({ ...w.options, beforeRemove: (path) => writeFileSync(join(path, 'written-now'), '.') });
  assert.deepEqual([summary.removed, summary.changed, existsSync(late)], [0, 1, true]);
});

test('a finished session folder is counted once (by session-folders), and the current session\'s old cs-test folder is listed', posix, async () => {
  const w = world();
  transcript(w, '-proj', NEWEST, 0); // the newest transcript's session is never removed: OLD must not be it
  transcript(w, '-proj', OLD, 10);
  folder(join(w.claudeTmp, '-proj', OLD, 'scratchpad', 'cs-test-z'), { days: 10 });
  age(join(w.claudeTmp, '-proj', OLD, 'scratchpad'), 10);
  age(join(w.claudeTmp, '-proj', OLD), 10);
  const current = '22222222-0000-4000-8000-00000000000b';
  const currentTest = folder(join(w.claudeTmp, '-proj', current, 'scratchpad', 'cs-test-c'), { days: OLD_DAYS });
  seenDaysAgo(w, OLD_DAYS, currentTest, join(w.claudeTmp, '-proj', OLD, 'scratchpad', 'cs-test-z'));
  const dry = await runClean({ ...w.options, apply: false, session: current });
  assert.equal(dry.rules.find((rule) => rule.name === 'session-folders').items, 1);
  assert.deepEqual(listed(dry), real(currentTest));
  assert.equal(dry.items, 2);
});

test('crash case: a cs-test folder a killed run left renamed aside is finished; this run\'s own aside name is skipped', posix, async () => {
  const w = world();
  const scratchpad = liveScratchpad(w);
  const leftover = folder(join(scratchpad, '.removing-999999-cs-test-k'), { days: OLD_DAYS });
  const own = folder(join(scratchpad, `.removing-${process.pid}-cs-test-o`), { days: OLD_DAYS });
  seenDaysAgo(w, OLD_DAYS, leftover, own);
  const leftoverOther = folder(join(scratchpad, '.removing-999999-notes'), { days: OLD_DAYS });
  const summary = await runClean(w.options);
  assert.deepEqual([summary.removed, existsSync(leftover), existsSync(own), existsSync(leftoverOther)], [1, false, true, true]);
});

test('CLI: two --apply runs at once remove each old folder once, keep the rest and both exit 0', posix, async () => {
  const w = world();
  const paths = fixture(w);
  const args = [TOOL, '--apply', '--json', '--claude-tmp', w.claudeTmp, '--projects', w.projects, '--tmp', w.tmp, '--sessions', w.sessions];
  const runOnce = () => new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env: cliEnv(w) });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('close', (status) => resolve({ status, out }));
  });
  const runs = await Promise.all([runOnce(), runOnce()]);
  assert.deepEqual(runs.map((run) => run.status), [0, 0], runs.map((run) => run.out).join('\n'));
  const removed = runs.map((run) => (run.out.startsWith('{') ? JSON.parse(run.out).removed : 0)).reduce((sum, n) => sum + n, 0);
  assert.equal(removed, 2, runs.map((run) => run.out).join('\n'));
  assert.deepEqual([existsSync(paths.oldTest), existsSync(paths.oldClone), existsSync(paths.newTest), existsSync(paths.otherName)], [false, false, true, true]);
});

test('git work is never removed: a linked worktree named cs-test-*, a cs-test folder holding a worktree deep inside, and clones with local-only commits, untracked files, changes or a stash stay; a clean clone goes', posix, async () => {
  const w = world();
  const scratchpad = liveScratchpad(w);
  const origin = originRepo(w);
  const worktree = join(scratchpad, 'cs-test-wt');
  git(origin, 'worktree', 'add', '-q', worktree);
  const holder = folder(join(scratchpad, 'cs-test-holder'), { days: OLD_DAYS });
  git(origin, 'worktree', 'add', '-q', join(holder, 'deep', 'copy'));
  const kept = [
    ageTree(worktree, OLD_DAYS),
    ageTree(holder, OLD_DAYS),
    cloneFolder(w, join(scratchpad, 'unpushed'), OLD_DAYS, (path) => {
      writeFileSync(join(path, 'local.txt'), 'local');
      git(path, 'add', 'local.txt');
      git(path, 'commit', '-qm', 'local only');
    }),
    cloneFolder(w, join(scratchpad, 'untracked'), OLD_DAYS, (path) => writeFileSync(join(path, 'new.txt'), 'never added')),
    cloneFolder(w, join(scratchpad, 'changed'), OLD_DAYS, (path) => writeFileSync(join(path, 'README.md'), 'edited')),
    cloneFolder(w, join(scratchpad, 'cs-test-stash'), OLD_DAYS, (path) => {
      writeFileSync(join(path, 'README.md'), 'stashed');
      git(path, 'stash', '-q');
    }),
  ];
  const clean = cloneFolder(w, join(scratchpad, 'clean'), OLD_DAYS);
  seenDaysAgo(w, OLD_DAYS, ...kept, clean); // seen long ago: only the git work keeps them
  const dry = await runClean({ ...w.options, apply: false });
  assert.deepEqual(listed(dry), real(clean));
  await runClean(w.options);
  for (const path of kept) assert.equal(existsSync(path), true, path);
  assert.equal(existsSync(clean), false);
});

test('first seen: a folder with old times that disk-clean meets for the first time (a cp -a copy) is recorded and kept, by the dry run and by --apply alike; seen 2 days ago it goes and its entry is dropped', posix, async () => {
  const w = world();
  const scratchpad = liveScratchpad(w);
  const copy = folder(join(scratchpad, 'cs-test-copy'), { days: 5 }); // times as old as `cp -a` keeps them
  const dry = await runClean({ ...w.options, apply: false });
  assert.deepEqual([listed(dry), dry.firstSeenKept], [[], 1]);
  const recorded = JSON.parse(readFileSync(seenFile(w), 'utf8'));
  const [seenMs] = Object.values(recorded.seen);
  assert.ok(Math.abs(seenMs - Date.now()) < 60_000, 'recorded at the clock');
  const applied = await runClean(w.options);
  assert.deepEqual([applied.removed, applied.firstSeenKept, existsSync(copy)], [0, 0, true], 'the dry run recorded it: no longer new, still too recent');
  seenDaysAgo(w, OLD_DAYS, copy);
  const later = await runClean({ ...w.options, apply: false });
  assert.deepEqual(listed(later), real(copy));
  assert.equal((await runClean(w.options)).removed, 1);
  assert.deepEqual(JSON.parse(readFileSync(seenFile(w), 'utf8')).seen, {}, 'the entry of a folder that is gone is dropped');
});

test('a record that is not this shape (torn, older, planted) reads as empty: every folder counts as first seen and stays, and the record is written again whole', posix, async () => {
  const w = world();
  const scratchpad = liveScratchpad(w);
  const oldTest = folder(join(scratchpad, 'cs-test-old'), { days: OLD_DAYS });
  seenDaysAgo(w, OLD_DAYS, oldTest);
  writeFileSync(seenFile(w), readFileSync(seenFile(w), 'utf8').slice(0, 20)); // cut mid-way
  const summary = await runClean(w.options);
  assert.deepEqual([summary.removed, summary.firstSeenKept, existsSync(oldTest)], [0, 1, true]);
  assert.equal(Object.keys(JSON.parse(readFileSync(seenFile(w), 'utf8')).seen).length, 1);
});
