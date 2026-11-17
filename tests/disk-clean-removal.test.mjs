// Tests for the removal side of disk-clean (lib/safe-remove.mjs and how disk-clean.mjs uses it): roots are refused unless safe, owners, modes
// and file systems are checked (another owner and another file system are faked through lstat, see withFakeStat), a folder swapped during the
// removal is never followed, and a folder is renamed aside before the removal so a session that resumes keeps its work. Fake roots only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClean } from '../home/tools/disk-free/disk-clean.mjs';
import { rulesFor } from '../home/tools/disk-free/lib/clean-rules.mjs';
import { inspectRoot, moveAside, ownedFolder, removeInside } from '../home/tools/disk-free/lib/safe-remove.mjs';
import { age, folder, NEWEST, OLD, OTHER, posix, sessionFolder, transcript, withFakeStat, world } from './disk-clean-helpers.mjs';

const OTHER_UID = (process.getuid?.() ?? 0) + 1;
const ROOT_FIELDS = { uid: 0 };
const asideOf = (path) => join(join(path, '..'), `.removing-${process.pid}-${path.split('/').at(-1)}`);
const isUnder = (path, base) => { const inside = relative(realpathSync(base), realpathSync(path)); return !inside.startsWith('..') && !isAbsolute(inside); };

/** safe-remove.mjs loaded as if this process ran as `uid` (it reads process.getuid once, when it is loaded). */
async function safeRemoveAs(uid) {
  const real = process.getuid;
  process.getuid = () => uid;
  try {
    return await import(`../home/tools/disk-free/lib/safe-remove.mjs?uid=${uid}`);
  } finally {
    process.getuid = real;
  }
}

test('refused roots: empty, relative, the home folder, outside the temp folders, a symlink and a folder others can write to', posix, async () => {
  const w = world();
  const victim = folder(join(w.root, 'victim', 'Devices', OLD), { days: 10 });
  symlinkSync(join(w.root, 'victim'), join(w.root, 'linked-claude'));
  const open = folder(join(w.root, 'open'), { days: 0 });
  chmodSync(open, 0o777);
  const testsFolder = fileURLToPath(new URL('.', import.meta.url)); // this repo's tests folder: ours, but not under a temp folder unless the checkout is
  const outside = [tmpdir(), '/tmp', '/private/tmp'].some((base) => isUnder(testsFolder, base)) ? [] : [testsFolder];
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

test('a shared sticky root (like /tmp) counts only when root owns it: then cs-run- and cs-test- names go, others stay; owned by anyone else it is refused', posix, async () => {
  const w = world();
  chmodSync(w.tmp, 0o1777);
  const go = folder(join(w.tmp, 'cs-run-AbCdEf'), { days: 3 });
  const keep = folder(join(w.tmp, 'git-tidy-QQQQQQ'), { days: 3 });
  const foreign = await runClean(w.options); // sticky and world-writable, but this user owns it: the owner of a sticky folder can rename everything in it
  assert.deepEqual([existsSync(go), foreign.refused.length, foreign.removed], [true, 2, 0]);
  const summary = await withFakeStat(w.tmp, ROOT_FIELDS, () => runClean(w.options));
  assert.deepEqual([existsSync(go), existsSync(keep), summary.refused.length], [false, true, 0]);
});

test('the session folders and throwaway projects rules refuse a shared sticky root: their roots must be the user\'s own', posix, async () => {
  const w = world();
  transcript(w, '-proj', NEWEST, 0);
  const path = sessionFolder(w, OLD, 10);
  chmodSync(w.claudeTmp, 0o1777);
  const summary = await withFakeStat(w.claudeTmp, ROOT_FIELDS, () => runClean(w.options));
  assert.deepEqual([existsSync(path), summary.removed, summary.refused.length], [true, 0, 1]);
});

test('uid: a folder of another user is not an owned folder or a root; the same folder is fine as this user', posix, async () => {
  const w = world();
  const item = folder(join(w.tmp, 'cs-run-AbCdEf'), { days: 3 });
  const asOther = await safeRemoveAs(OTHER_UID);
  assert.equal(asOther.ownedFolder(item), null);
  assert.throws(() => asOther.inspectRoot(w.tmp, w.home), /owned by someone else/);
  assert.notEqual(ownedFolder(item), null);
  assert.deepEqual(inspectRoot(w.tmp, w.home), { real: realpathSync(w.tmp), shared: false });
});

test('removeInside keeps an item, a folder on the way and a folder inside that another user owns, is writable by others or is on another file system', posix, async () => {
  const w = world();
  const root = realpathSync(w.tmp);
  const make = (name) => folder(join(root, 'mid', name, 'inner'), { days: 3 });
  const cases = [
    ['item owner', make('a'), join(root, 'mid', 'a'), { uid: OTHER_UID }, /not owned by you/],
    ['item mount point', make('b'), join(root, 'mid', 'b'), { dev: 987654321 }, /another file system/],
    ['folder on the way', make('c'), join(root, 'mid', 'c'), { uid: OTHER_UID }, /not owned by you|symlink, is not owned/],
    ['folder on the way, other file system', make('d'), join(root, 'mid', 'd'), { dev: 987654321 }, /another file system/],
    ['folder inside', make('e'), join(root, 'mid', 'e', 'inner'), { uid: OTHER_UID }, /not owned by you/],
    ['folder inside, other file system', make('f'), join(root, 'mid', 'f', 'inner'), { dev: 987654321 }, /another file system/],
  ];
  for (const [label, item, faked, fields, message] of cases) {
    const target = label.startsWith('folder on the way') ? join(item) : join(root, 'mid', item.split('/').at(-2));
    await withFakeStat(faked, fields, () => assert.throws(() => removeInside(root, label.startsWith('folder on the way') ? join(item, 'f.txt') : target), message, label));
    assert.equal(existsSync(join(item, 'f.txt')), true, `${label}: nothing was removed`);
  }
});

test('removeInside keeps a folder item that others can write to, refuses the root itself and a sibling that shares the name prefix', posix, () => {
  const w = world();
  const root = realpathSync(w.tmp);
  const open = folder(join(root, 'open', 'item'), { days: 9 });
  chmodSync(join(root, 'open'), 0o777);
  assert.throws(() => removeInside(root, open), /writable by others/);
  chmodSync(join(root, 'open'), 0o755);
  chmodSync(open, 0o777);
  assert.throws(() => removeInside(root, open), /writable by others/);
  assert.throws(() => removeInside(root, root), /not inside/);
  const sibling = folder(`${root}-evil/item`, { days: 9 });
  assert.throws(() => removeInside(root, sibling), /not inside/);
  assert.deepEqual([existsSync(open), existsSync(sibling)], [true, true]);
});

test('an item is kept (listed, left under its aside name) when a folder inside is writable by others; the other items still go', posix, async () => {
  const w = world();
  transcript(w, '-proj', NEWEST, 0);
  const unsafeInside = sessionFolder(w, OLD, 10);
  mkdirSync(join(unsafeInside, 'open'));
  writeFileSync(join(unsafeInside, 'open', 'f'), 'x');
  chmodSync(join(unsafeInside, 'open'), 0o777);
  for (const path of [join(unsafeInside, 'open', 'f'), join(unsafeInside, 'open'), unsafeInside]) age(path, 10);
  const fine = sessionFolder(w, OTHER, 10);
  const summary = await runClean(w.options);
  assert.deepEqual([existsSync(join(asideOf(unsafeInside), 'open', 'f')), existsSync(fine), summary.failed.length], [true, false, 1], 'an error on one item does not stop the run');
  chmodSync(join(asideOf(unsafeInside), 'open'), 0o755);
});

/** Runs the removal of a folder `item` made by `folder()` while `hook(path)` is called when its listing is opened inside it (cwd is the folder). */
async function removeWithHookAtListing(w, hook) {
  const item = join(realpathSync(w.tmp), 'cs-run-Swap01');
  folder(join(item, 'd'), { days: 3, files: { 'thesis.txt': 'bait' } });
  age(item, 3);
  const inner = join(asideOf(item), 'd'); // the item is renamed aside before it is emptied
  const realOpendir = fs.opendirSync;
  let fired = false;
  fs.opendirSync = (path, ...rest) => {
    const handle = realOpendir(path, ...rest);
    if (!fired && path === '.' && process.cwd() === inner) {
      fired = true;
      hook(inner);
    }
    return handle;
  };
  syncBuiltinESMExports();
  try {
    const summary = await runClean(w.options);
    assert.ok(fired, 'the hook ran');
    return summary;
  } finally {
    fs.opendirSync = realOpendir;
    syncBuiltinESMExports();
  }
}

test('a folder swapped for a symlink while it is being removed is not followed: the victim keeps its files', posix, async () => {
  const w = world();
  const victim = folder(join(w.root, 'owner-home'), { days: 0, files: { 'thesis.txt': 'precious' } });
  const summary = await removeWithHookAtListing(w, (inner) => {
    renameSync(inner, join(w.root, 'spare'));
    symlinkSync(victim, inner);
  });
  assert.equal(summary.failed.length, 1);
  assert.equal(readFileSync(join(victim, 'thesis.txt'), 'utf8'), 'precious');
});

test('a folder moved away while it is being removed: its new parent is not touched (identity of the parent is checked before the rmdir)', posix, async () => {
  const w = world();
  mkdirSync(join(w.root, 'elsewhere'));
  const summary = await removeWithHookAtListing(w, (inner) => renameSync(inner, join(w.root, 'elsewhere', 'd')));
  assert.equal(summary.failed.length, 1);
  assert.equal(existsSync(join(w.root, 'elsewhere', 'd')), true, 'the emptied folder was not removed behind the parent check');
});

test('the parent of the item is swapped for another real folder after it was checked: nothing is removed from the new one (identity by device AND inode)', posix, () => {
  const w = world();
  const root = realpathSync(w.tmp);
  const parent = join(root, 'mid');
  folder(join(parent, 'item'), { days: 3 });
  const realChdir = process.chdir;
  let swapped = false;
  process.chdir = (target) => {
    if (!swapped && target === parent) {
      swapped = true;
      renameSync(parent, join(root, 'spare'));
      folder(join(parent, 'item'), { days: 3, files: { 'new.txt': 'not for removal' } });
    }
    return realChdir(target);
  };
  try {
    assert.throws(() => removeInside(root, join(parent, 'item')), /changed while/);
  } finally {
    process.chdir = realChdir;
  }
  assert.equal(existsSync(join(parent, 'item', 'new.txt')), true);
});

test('the working directory is put back after a removal, also after one that fails', posix, () => {
  const w = world();
  const root = realpathSync(w.tmp);
  const before = process.cwd();
  removeInside(root, folder(join(root, 'ok', 'item'), { days: 3 }));
  assert.equal(process.cwd(), before);
  const open = folder(join(root, 'bad', 'item', 'inner'), { days: 3 });
  chmodSync(open, 0o777);
  assert.throws(() => removeInside(root, join(root, 'bad', 'item')), /writable by others/);
  assert.equal(process.cwd(), before);
  chmodSync(open, 0o755);
});

test('an entry that cannot be looked at stops the removal at once (no spinning on it); a vanished one is skipped', posix, () => {
  const w = world();
  const root = realpathSync(w.tmp);
  const item = folder(join(root, 'item'), { days: 3, files: { locked: 'x', other: 'y' } });
  const realLstat = fs.lstatSync;
  const realOpendir = fs.opendirSync;
  let listings = 0;
  fs.lstatSync = (path, ...rest) => {
    if (path === 'locked') throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    return realLstat(path, ...rest);
  };
  fs.opendirSync = (...args) => { listings += 1; return realOpendir(...args); };
  syncBuiltinESMExports();
  try {
    assert.throws(() => removeInside(root, item), /EACCES/);
  } finally {
    fs.lstatSync = realLstat;
    fs.opendirSync = realOpendir;
    syncBuiltinESMExports();
  }
  assert.ok(listings <= 2, `${listings} listings`);
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

test('moveAside renames to .removing-<pid>-<name> in the same parent, refuses a file, a link and a folder of another owner', posix, async () => {
  const w = world();
  const root = realpathSync(w.tmp);
  const item = folder(join(root, 'cs-run-AbCdEf'), { days: 3 });
  const aside = moveAside(root, item);
  assert.equal(aside, asideOf(item));
  assert.deepEqual([existsSync(item), existsSync(join(aside, 'f.txt'))], [false, true]);
  writeFileSync(join(root, 'file'), 'x');
  assert.throws(() => moveAside(root, join(root, 'file')), /not a folder/);
  symlinkSync(aside, join(root, 'link'));
  assert.throws(() => moveAside(root, join(root, 'link')), /symlink/);
  await withFakeStat(aside, { uid: OTHER_UID }, () => assert.throws(() => moveAside(root, aside), /not owned by you/));
  assert.deepEqual(readdirSync(root).sort(), ['.removing-' + process.pid + '-cs-run-AbCdEf', 'file', 'link']);
});
