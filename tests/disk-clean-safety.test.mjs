// Safety tests for disk-clean: a session resumed or running during the run keeps its folder, unsafe roots and folders are refused, a folder
// swapped for a symlink while it is removed does not redirect the removal, an error on one item does not stop the others, the age limits
// hold at their boundaries, and the scan limits make the totals partial. Fake roots only (tests/disk-clean-helpers.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClean } from '../home/tools/disk-free/disk-clean.mjs';
import { rulesFor } from '../home/tools/disk-free/lib/clean-rules.mjs';
import { touchedSince, treeBytes, walkTree } from '../home/tools/disk-free/lib/clean-scan.mjs';
import { OLD_TEST_PREFIXES } from '../home/tools/disk-free/lib/test-temp-prefixes.mjs';
import { age, CURRENT, folder, NEWEST, OLD, OTHER, sessionFile, transcript, world } from './disk-clean-helpers.mjs';

const TOOL = fileURLToPath(new URL('../home/tools/disk-free/disk-clean.mjs', import.meta.url));
const posix = { skip: process.platform === 'win32' && 'needs symlinks and file modes' };
const sessionFolder = (w, id, days) => folder(join(w.claudeTmp, '-proj', id), { days });

test('a session resumed during the run (its transcript written after the scan) keeps its folder', async () => {
  const w = world();
  const file = transcript(w, '-proj', OLD, 10);
  transcript(w, '-proj', NEWEST, 0);
  const path = sessionFolder(w, OLD, 10);
  const summary = await runClean({ ...w.options, beforeRemove: () => age(file, 0) }); // the resume: the transcript is written after the scan found the folder idle
  assert.equal(existsSync(path), true);
  assert.equal(summary.removed, 0);
  assert.equal(summary.changed, 1);
});

test('a folder written to during the run is kept although its transcript stays old (folder idle is required too)', async () => {
  const w = world();
  transcript(w, '-proj', OLD, 10);
  transcript(w, '-proj', NEWEST, 0);
  const path = sessionFolder(w, OLD, 10);
  const summary = await runClean({ ...w.options, beforeRemove: () => writeFileSync(join(path, 'fresh.txt'), 'x') });
  assert.equal(existsSync(path), true);
  assert.equal(summary.changed, 1);
});

test('a session whose process is alive keeps its folder; one whose process is gone loses it', async () => {
  const w = world();
  const deadPid = spawnSync(process.execPath, ['-e', '0']).pid; // exited: the pid is free
  for (const id of [OLD, OTHER]) transcript(w, '-proj', id, 10);
  transcript(w, '-proj', NEWEST, 0);
  const alive = sessionFolder(w, OLD, 10);
  const gone = sessionFolder(w, OTHER, 10);
  sessionFile(w, process.pid, OLD);
  sessionFile(w, deadPid, OTHER);
  await runClean(w.options);
  assert.deepEqual([existsSync(alive), existsSync(gone)], [true, false]);
});

test('a running session keeps its throwaway-project folder, also when it has no folder of that id there', async () => {
  const w = world();
  folder(join(w.projects, '-tmp-live'), { days: 10, files: { [`${OLD}.jsonl`]: '{}' } });
  folder(join(w.projects, '-tmp-gone'), { days: 10, files: { [`${OTHER}.jsonl`]: '{}' } });
  sessionFile(w, process.pid, OLD);
  await runClean(w.options);
  assert.deepEqual([existsSync(join(w.projects, '-tmp-live')), existsSync(join(w.projects, '-tmp-gone'))], [true, false]);
});

test('a session folder with a recent file deep inside is kept; the same folder idle goes (touchedSince looks at every entry and every level)', async () => {
  const w = world();
  transcript(w, '-proj', NEWEST, 0);
  const deep = sessionFolder(w, OLD, 10);
  const idle = sessionFolder(w, OTHER, 10);
  mkdirSync(join(deep, 'a', 'b'), { recursive: true });
  writeFileSync(join(deep, 'a', 'b', 'new.txt'), 'x'); // new, while every folder keeps its old time
  for (const dir of [join(deep, 'a', 'b'), join(deep, 'a'), deep]) age(dir, 10);
  await runClean(w.options);
  assert.deepEqual([existsSync(deep), existsSync(idle)], [true, false]);
});

test('touchedSince: a recent entry in the folder, a gone folder and a walk cut short all count as busy; an idle tree does not', async () => {
  const w = world();
  const idle = folder(join(w.root, 'idle'), { days: 9, files: { a: '1', b: '2', c: '3' } });
  const cutoff = Date.now() - 3 * 86_400_000;
  assert.equal(await touchedSince(idle, cutoff), false);
  writeFileSync(join(idle, 'd'), 'new');
  age(idle, 9);
  assert.equal(await touchedSince(idle, cutoff), true, 'a new entry in a folder with an old time');
  assert.equal(await touchedSince(join(w.root, 'gone'), cutoff), true);
  assert.equal(await touchedSince(folder(join(w.root, 'wide'), { days: 9, files: { a: '1', b: '2', c: '3', d: '4' } }), cutoff, { maxEntries: 2 }), true, 'more entries than the cap');
});

test('walkTree stops at its depth cap and says so; treeBytes does not follow links', posix, async () => {
  const w = world();
  folder(join(w.root, 'deep', 'a', 'b', 'c'), { days: 1 });
  const outcome = {};
  for await (const info of walkTree(join(w.root, 'deep'), { maxDepth: 2 }, outcome)) assert.ok(info);
  assert.equal(outcome.cutShort, true);
  const big = folder(join(w.root, 'big'), { files: { 'big.bin': 'x'.repeat(200_000) } });
  const withLink = folder(join(w.root, 'with-link'));
  symlinkSync(big, join(withLink, 'link'));
  const { bytes, complete } = await treeBytes(withLink, Date.now() + 5000);
  assert.ok(complete && bytes < 100_000, `bytes ${bytes}`);
});

test('age boundaries: 2.5 days is kept and 3.5 days goes for sessions, throwaway projects and hook counters; 0.5 and 1.5 days for test temp', async () => {
  const w = world();
  transcript(w, '-proj', NEWEST, 0);
  transcript(w, '-proj', OLD, 3.5);
  transcript(w, '-proj', OTHER, 2.5);
  const sessions = [sessionFolder(w, OLD, 3.5), sessionFolder(w, OTHER, 2.5)];
  const projects = [folder(join(w.projects, '-tmp-old'), { days: 3.5 }), folder(join(w.projects, '-tmp-young'), { days: 2.5 })];
  const file = (name, days) => { mkdirSync(join(w.tmp, 'claude-post-edit', 'budget'), { recursive: true }); writeFileSync(join(w.tmp, 'claude-post-edit', 'budget', name), '.'); age(join(w.tmp, 'claude-post-edit', 'budget', name), days); return join(w.tmp, 'claude-post-edit', 'budget', name); };
  const hooks = [file('old', 3.5), file('young', 2.5)];
  const tests = [folder(join(w.tmp, 'cs-run-OldOld'), { days: 1.5 }), folder(join(w.tmp, 'cs-run-Young1'), { days: 0.5 })];
  await runClean(w.options);
  for (const [oldOne, youngOne] of [sessions, projects, hooks, tests]) assert.deepEqual([existsSync(oldOne), existsSync(youngOne)], [false, true], oldOne);
});

test('slug anchor: only a slug that STARTS with a temp path is a throwaway project', async () => {
  const w = world();
  const inside = ['-Users-me-private-tmp-x', '-Users-me-tmp-thing', '-home-me-private-var-folders-a'].map((slug) => folder(join(w.projects, slug), { days: 10 }));
  await runClean(w.options);
  assert.deepEqual(inside.map(existsSync), [true, true, true]);
});

test('test temp names: prefix plus exactly 6 characters; a longer or shorter name, a generic old prefix and a bare cs- name stay', async () => {
  const w = world();
  const keep = ['cs-run-AbCdEfG', 'cs-run-AbCdE', 'cs-test-abc', 'cs-other-AbCdEf', 'git-tidy-QQQQQQQ', 'status-report', 'lock-abcdef'].map((name) => folder(join(w.tmp, name), { days: 3 }));
  const go = ['cs-test-AbCdEf', 'cs-test-label-AbCdEf', 'cs-run-AbCdEf'].map((name) => folder(join(w.tmp, name), { days: 3 }));
  await runClean(w.options);
  assert.deepEqual([keep.map(existsSync), go.map(existsSync)], [keep.map(() => true), go.map(() => false)]);
});

test('the old prefix list has no generic names: two or more words, at least 8 characters, no repeats', () => {
  for (const prefix of OLD_TEST_PREFIXES) assert.match(prefix, /^[a-z0-9]+(?:-[a-z0-9]+)+-$/, prefix);
  for (const prefix of OLD_TEST_PREFIXES) assert.ok(prefix.length >= 8, `${prefix} is too short`);
  for (const generic of ['refs-', 'lock-', 'log-', 'hint-', 'perm-', 'steps-', 'resp-', 'status-', 'recall-']) assert.ok(!OLD_TEST_PREFIXES.includes(generic), generic);
  assert.equal(new Set(OLD_TEST_PREFIXES).size, OLD_TEST_PREFIXES.length);
});

test('hook state: a symlinked state folder, a symlinked kind folder and a folder inside a kind folder are never entered or removed', posix, async () => {
  const w = world();
  const elsewhere = folder(join(w.root, 'elsewhere', 'budget'), { days: 10 });
  symlinkSync(join(w.root, 'elsewhere'), join(w.tmp, 'claude-post-edit'));
  mkdirSync(join(w.tmp, 'claude-skill-router'), { recursive: true });
  symlinkSync(join(w.root, 'elsewhere', 'budget'), join(w.tmp, 'claude-skill-router', 'linked-kind'));
  folder(join(w.tmp, 'claude-skill-router', 'real-kind', 'old-folder'), { days: 10 });
  age(join(w.tmp, 'claude-skill-router', 'real-kind'), 10);
  const summary = await runClean(w.options);
  assert.equal(existsSync(join(elsewhere, 'f.txt')), true);
  assert.equal(existsSync(join(w.tmp, 'claude-skill-router', 'real-kind', 'old-folder')), true);
  assert.deepEqual([summary.rules.find((rule) => rule.name === 'hook-state').items, summary.failed.length], [0, 0], 'nothing was even found, so nothing was tried');
});

test('refused roots: empty, relative, the home folder, outside the temp folders, a symlink and a folder others can write to', posix, async () => {
  const w = world();
  const victim = folder(join(w.root, 'victim', 'Devices', OLD), { days: 10 });
  symlinkSync(join(w.root, 'victim'), join(w.root, 'linked-claude'));
  const open = folder(join(w.root, 'open'), { days: 0 });
  chmodSync(open, 0o777);
  const ownedButElsewhere = fileURLToPath(new URL('.', import.meta.url)); // this repo's tests folder: ours, but not under a temp folder
  const outside = tmpdir().startsWith(ownedButElsewhere) || ownedButElsewhere.startsWith(tmpdir()) ? [] : [ownedButElsewhere];
  for (const claudeTmp of ['', 'relative/dir', w.home, '/usr', ...outside, join(w.root, 'linked-claude'), open]) {
    const summary = await runClean({ ...w.options, claudeTmp });
    assert.equal(summary.refused.length, 1, `root ${JSON.stringify(claudeTmp)} should be refused`);
    assert.equal(summary.removed, 0);
  }
  assert.equal(existsSync(join(victim, 'f.txt')), true);
});

test('a root reached through a symlinked parent folder is cleaned by its real path', posix, async () => {
  const w = world();
  folder(join(w.tmp, 'cs-run-Linked'), { days: 3 });
  symlinkSync(w.root, join(w.root, 'via-link'));
  const summary = await runClean({ ...w.options, tmp: join(w.root, 'via-link', 'tmp') });
  assert.deepEqual([summary.removed, existsSync(join(w.tmp, 'cs-run-Linked'))], [1, false]);
});

test('a shared sticky root (like /tmp) is cleaned for cs-run- and cs-test- names only', posix, async () => {
  const w = world();
  chmodSync(w.tmp, 0o1777);
  const go = folder(join(w.tmp, 'cs-run-AbCdEf'), { days: 3 });
  const keep = folder(join(w.tmp, 'git-tidy-QQQQQQ'), { days: 3 });
  const summary = await runClean(w.options);
  assert.deepEqual([existsSync(go), existsSync(keep), summary.refused.length], [false, true, 0]);
});

test('an item is kept and listed when a folder on the way down is writable by others; the other items still go', posix, async () => {
  const w = world();
  transcript(w, '-proj', NEWEST, 0);
  const unsafeInside = sessionFolder(w, OLD, 10);
  mkdirSync(join(unsafeInside, 'open'));
  writeFileSync(join(unsafeInside, 'open', 'f'), 'x');
  chmodSync(join(unsafeInside, 'open'), 0o777);
  for (const path of [join(unsafeInside, 'open', 'f'), join(unsafeInside, 'open'), unsafeInside]) age(path, 10);
  const fine = sessionFolder(w, OTHER, 10);
  const summary = await runClean(w.options);
  assert.deepEqual([existsSync(unsafeInside), existsSync(fine), summary.failed.length], [true, false, 1], 'an error on one item does not stop the run');
  chmodSync(join(unsafeInside, 'open'), 0o755);
});

test('a folder swapped for a symlink while it is being removed is not followed: the victim keeps its files', posix, async () => {
  const w = world();
  const victim = folder(join(w.root, 'owner-home'), { days: 0, files: { 'thesis.txt': 'precious' } });
  const item = join(realpathSync(w.tmp), 'cs-run-Swap01'); // the tool works with real paths
  const inner = join(item, 'd');
  folder(inner, { days: 3, files: { 'thesis.txt': 'bait' } });
  age(item, 3);
  const realOpendir = fs.opendirSync;
  let swapped = false;
  fs.opendirSync = (path, ...rest) => {
    const handle = realOpendir(path, ...rest);
    if (!swapped && path === inner) { // after the listing is read, before the unlink: the swap
      swapped = true;
      renameSync(inner, join(w.root, 'spare'));
      symlinkSync(victim, inner);
    }
    return handle;
  };
  syncBuiltinESMExports();
  try {
    const summary = await runClean(w.options);
    assert.ok(swapped);
    assert.equal(summary.failed.length, 1);
  } finally {
    fs.opendirSync = realOpendir;
    syncBuiltinESMExports();
  }
  assert.equal(readFileSync(join(victim, 'thesis.txt'), 'utf8'), 'precious');
});

test('a dry run is partial when the size measuring ran out of time, and when the scan time is over before anything was looked at', async () => {
  const w = world();
  for (const name of ['cs-run-AaAaAa', 'cs-run-BbBbBb']) folder(join(w.tmp, name), { days: 3 });
  const measured = await runClean({ ...w.options, apply: false, budgetMs: -1 });
  assert.deepEqual([measured.items, measured.partial], [2, true]);
  const stopped = await runClean({ ...w.options, apply: false, scanMs: -1 });
  assert.deepEqual([stopped.items, stopped.partial], [0, true], 'the deadline is checked inside the rule loops');
  const whole = await runClean({ ...w.options, apply: false });
  assert.deepEqual([whole.items, whole.partial], [2, false]);
});

test('CLI: the running session id from CLAUDE_CODE_SESSION_ID (or the older CLAUDE_SESSION_ID) is never removed', async () => {
  for (const variable of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID']) {
    const w = world();
    transcript(w, '-proj', CURRENT, 20);
    transcript(w, '-proj', NEWEST, 0);
    const mine = sessionFolder(w, CURRENT, 20);
    const roots = ['--claude-tmp', w.claudeTmp, '--projects', w.projects, '--tmp', w.tmp, '--sessions', w.sessions];
    const env = { ...process.env, CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '', [variable]: CURRENT };
    assert.equal(spawnSync(process.execPath, [TOOL, '--apply', ...roots], { env, encoding: 'utf8' }).status, 0);
    assert.equal(existsSync(mine), true, variable);
  }
});

test('a rule stops reading at the scan deadline (a limit that says time is up after 3 looks)', async () => {
  const w = world();
  for (let i = 0; i < 30; i += 1) folder(join(w.tmp, `cs-run-Fr${String(i).padStart(4, '0')}`), { days: 3 });
  let looks = 0;
  const context = { ...w.options, refused: [], timeUp: () => (looks += 1) > 3 };
  const testTempRule = rulesFor().find((rule) => rule.name === 'test-temp');
  const yielded = [];
  for await (const item of testTempRule.find(context)) yielded.push(item);
  assert.equal(yielded.length, 3, 'the rule stops at the first entry after the deadline');
});

test('an error on one item is listed and the run goes on with the next items', async () => {
  const w = world();
  const paths = ['cs-run-AaAaAa', 'cs-run-BbBbBb', 'cs-run-CcCcCc'].map((name) => folder(join(w.tmp, name), { days: 3 }));
  let calls = 0;
  const summary = await runClean({ ...w.options, beforeRemove: () => { if ((calls += 1) === 1) throw new Error('boom'); } });
  assert.deepEqual([summary.failed.length, summary.removed, paths.filter(existsSync).length], [1, 2, 1]);
});

test('removeInside refuses a path under a folder that others can write to, and a path in a sibling that only shares the name prefix', posix, async () => {
  const { removeInside } = await import('../home/tools/disk-free/lib/safe-remove.mjs');
  const w = world();
  const root = realpathSync(w.tmp);
  const target = folder(join(root, 'open', 'item'), { days: 9 });
  chmodSync(join(root, 'open'), 0o777);
  assert.throws(() => removeInside(root, target), /writable by others/);
  const sibling = folder(`${root}-evil/item`, { days: 9 });
  assert.throws(() => removeInside(root, sibling), /not inside/);
  assert.equal(existsSync(target), true);
  chmodSync(join(root, 'open'), 0o755);
});

test('every rule yields the real path of its root, also when the configured root is reached through a symlinked parent', posix, async () => {
  const w = world();
  symlinkSync(w.root, join(w.root, 'via-link'));
  const via = (name) => join(w.root, 'via-link', name);
  transcript(w, '-proj', NEWEST, 0);
  sessionFolder(w, OLD, 10);
  folder(join(w.tmp, 'cs-run-Viaaaa'), { days: 3 });
  folder(join(w.projects, '-tmp-via'), { days: 10 });
  mkdirSync(join(w.tmp, 'claude-post-edit', 'k'), { recursive: true });
  writeFileSync(join(w.tmp, 'claude-post-edit', 'k', 'f'), '.');
  age(join(w.tmp, 'claude-post-edit', 'k', 'f'), 10);
  const context = { ...w.options, claudeTmp: via('claude-501'), projects: via('projects'), tmp: via('tmp'), refused: [], timeUp: () => false };
  const roots = {};
  for (const rule of rulesFor()) for await (const item of rule.find(context)) roots[rule.name] = item.root;
  assert.deepEqual(Object.keys(roots).sort(), ['hook-state', 'session-folders', 'temp-projects', 'test-temp']);
  for (const root of Object.values(roots)) assert.equal(root, realpathSync(root));
});
