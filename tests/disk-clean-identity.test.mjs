// Tests for how disk-clean removes inside a folder: it works from inside the folder (working directory plus identity check), so a swap of the
// folder, of its parent or of a folder in it during the removal is never followed; the working directory is put back; an entry that cannot be
// looked at stops the item at once; big folders go in batches. Fake roots only (tests/disk-clean-helpers.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { runClean } from '../home/tools/disk-free/disk-clean.mjs';
import { removeInside } from '../home/tools/disk-free/lib/safe-remove.mjs';
import { age, folder, posix, world } from './disk-clean-helpers.mjs';

const asideOf = (path) => join(join(path, '..'), `.removing-${process.pid}-${path.split('/').at(-1)}`);

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


test('a folder inside is swapped for a symlink between the look and the change of directory: the link is not followed, the victim keeps its files', posix, () => {
  const w = world();
  const root = realpathSync(w.tmp);
  const victim = folder(join(w.root, 'victim'), { days: 0, files: { 'thesis.txt': 'precious' } });
  const item = folder(join(root, 'item', 'd'), { days: 3, files: { 'thesis.txt': 'bait' } }) && join(root, 'item');
  const realChdir = process.chdir;
  process.chdir = (target) => {
    if (target === 'd') {
      renameSync(join(item, 'd'), join(w.root, 'spare'));
      symlinkSync(victim, join(item, 'd'));
    }
    return realChdir(target);
  };
  try {
    assert.throws(() => removeInside(root, item), /changed while/);
  } finally {
    process.chdir = realChdir;
  }
  assert.equal(readFileSync(join(victim, 'thesis.txt'), 'utf8'), 'precious');
});

test('a folder with several thousand entries goes in batches, completely', posix, () => {
  const w = world();
  const root = realpathSync(w.tmp);
  const files = Object.fromEntries(Array.from({ length: 5200 }, (_, i) => [`f${i}`, '']));
  const item = folder(join(root, 'many'), { days: 3, files });
  removeInside(root, item);
  assert.equal(existsSync(item), false);
});
