// Tests for the removal side of disk-clean (lib/safe-remove.mjs and how disk-clean.mjs uses it): roots are refused unless safe, owners, modes
// and file systems are checked (another owner and another file system are faked through lstat, see withFakeStat), a folder swapped during the
// removal is never followed, and a folder is renamed aside before the removal so a session that resumes keeps its work. Fake roots only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
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
  chmodSync(w.tmp, 0o777); // world-writable and root-owned but not sticky: anyone could rename or remove anything in it
  const notSticky = await withFakeStat(w.tmp, ROOT_FIELDS, () => runClean(w.options));
  assert.deepEqual([existsSync(go), notSticky.refused.length], [true, 2]);
  chmodSync(w.tmp, 0o1777);
  const summary = await withFakeStat(w.tmp, ROOT_FIELDS, () => runClean(w.options));
  assert.deepEqual([existsSync(go), existsSync(keep), summary.refused.length], [false, true, 0]);
});

test('the session folders and throwaway projects rules refuse a shared sticky root: their roots must be the user\'s own', posix, async () => {
  const w = world();
  transcript(w, '-proj', NEWEST, 0);
  transcript(w, '-proj', OLD, 10);
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

test('removeInside keeps an item, a folder on the way and a folder inside that another user owns or that is on another file system', posix, async () => {
  const w = world();
  const root = realpathSync(w.tmp);
  const MOUNT = { dev: 987654321 };
  const OTHER_OWNER = { uid: OTHER_UID };
  // [label, what to remove, which folder is faked, how, expected message]; every item is root/mid/<name> with root/mid/<name>/inner/f.txt in it
  const cases = [
    ['item owner', 'a', 'a', OTHER_OWNER, /not owned by you/],
    ['item on another file system', 'b', 'b', MOUNT, /another file system/],
    ['folder on the way, owner', 'c', '', OTHER_OWNER, /symlink, is not owned/],
    ['folder on the way, file system', 'd', '', MOUNT, /another file system/],
    ['folder inside, owner', 'e', 'e/inner', OTHER_OWNER, /not owned by you/],
    ['folder inside, file system', 'f', 'f/inner', MOUNT, /another file system/],
  ];
  for (const [label, name, faked, fields, message] of cases) {
    const item = folder(join(root, 'mid', name, 'inner'), { days: 3 });
    const target = join(root, 'mid', name);
    const fakedPath = label.startsWith('folder on the way') ? join(root, 'mid') : join(root, 'mid', faked);
    await withFakeStat(fakedPath, fields, () => assert.throws(() => removeInside(root, target), message, label));
    assert.equal(existsSync(join(item, 'f.txt')), true, `${label}: nothing was removed`);
  }
  const plain = folder(join(root, 'mid', 'g'), { days: 3 }); // no folder inside: only the item's own check can refuse it
  await withFakeStat(plain, MOUNT, () => assert.throws(() => removeInside(root, plain), /another file system/));
  assert.equal(existsSync(join(plain, 'f.txt')), true);
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
  for (const id of [OLD, OTHER]) transcript(w, '-proj', id, 10);
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

test('every rule yields the real path of its root, also when the configured root is reached through a symlinked parent', posix, async () => {
  const w = world();
  symlinkSync(w.root, join(w.root, 'via-link'));
  const via = (name) => join(w.root, 'via-link', name);
  transcript(w, '-proj', NEWEST, 0);
  transcript(w, '-proj', OLD, 10);
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

test('removeInside refuses a link as the item, a root that another user owns, and a folder nested deeper than 64 levels', posix, async () => {
  const w = world();
  const root = realpathSync(w.tmp);
  const real = folder(join(root, 'real'), { days: 3 });
  symlinkSync(real, join(root, 'link'));
  assert.throws(() => removeInside(root, join(root, 'link')), /symlink and is never removed/);
  await withFakeStat(root, { uid: OTHER_UID }, () => assert.throws(() => removeInside(root, real), /root .* is not a folder owned by you/));
  const deep = Array.from({ length: 70 }, () => 'd').join('/');
  folder(join(root, 'deep', deep), { days: 3 });
  assert.throws(() => removeInside(root, join(root, 'deep')), /nested deeper than 64/);
  assert.equal(existsSync(join(real, 'f.txt')), true);
});

test('a rule does not even find a folder that another user owns: not the project folder, the session folder, the throwaway project or the test temp folder', posix, async () => {
  const w = world();
  transcript(w, '-proj', NEWEST, 0);
  transcript(w, '-proj', OLD, 10);
  const found = { session: sessionFolder(w, OLD, 10), project: folder(join(w.projects, '-tmp-x'), { days: 10 }), testTemp: folder(join(w.tmp, 'cs-run-AbCdEf'), { days: 3 }) };
  const itemsWith = async (path) => (await withFakeStat(path, { uid: OTHER_UID }, () => runClean({ ...w.options, apply: false }))).items;
  const normal = (await runClean({ ...w.options, apply: false })).items;
  assert.equal(normal, 3);
  assert.deepEqual([await itemsWith(join(w.claudeTmp, '-proj')), await itemsWith(found.session), await itemsWith(found.project), await itemsWith(found.testTemp)], [2, 2, 2, 2]);
});
