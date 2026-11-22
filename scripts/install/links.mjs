// Purpose: the links of an install: each home/ item into ~/.claude, the removal of links an older install made for the retired
//   session modes (the launcher and the modes folder) and the workflows (the ~/.claude/workflows link).
// Exports: linkHomeItems, removeRetiredLinks, removeLink.
// Invariants: a link that already points at the right place is left as it is (a second run changes nothing); a link or copy
//   the installer made, or an older install's link into this repo, is replaced without a backup; anything else is moved to the
//   backup folder first. On Windows a folder becomes a junction (no Developer Mode needed); a file link that is not allowed
//   falls back to a copy and says so.
import { cpSync, existsSync, lstatSync, readdirSync, readlinkSync, rmdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { act, note, samePath, warn } from './context.mjs';
import { backup, ensureDir, isMade, remember } from './record.mjs';

const lstatOrNull = (path) => {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

/** Removes a symlink or junction itself, never what it points at (Windows refuses unlink on a folder link: rmdir does it). */
export function removeLink(path) {
  try {
    rmSync(path, { force: true });
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EISDIR'].includes(error.code)) throw error;
    rmdirSync(path);
  }
}

/** True when `dst` is the installer's own: recorded as made, or a link into this repo's home/ (an install before the record). */
function isOurs(ctx, record, dst, stat) {
  if (isMade(record, dst)) return true;
  return stat.isSymbolicLink() && resolve(dirname(dst), readlinkSync(dst)).startsWith(join(ctx.repo, 'home'));
}

function makeLink(ctx, record, src, dst, label) {
  act(ctx, `link ${dst} -> ${src}`, () => {
    const type = statSync(src).isDirectory() ? (ctx.os === 'windows' ? 'junction' : 'dir') : 'file';
    try {
      symlinkSync(src, dst, type);
      remember(record, { kind: 'link', path: dst });
      note(ctx, `linked ${label}`);
    } catch (error) {
      if (ctx.os !== 'windows' || error.code !== 'EPERM') throw error;
      cpSync(src, dst, { recursive: true });
      remember(record, { kind: 'copy', path: dst });
      warn(`no right to make a file link for ${label} (turn on Developer Mode); copied it instead: re-run the installer after repo changes`);
      note(ctx, `copied ${label} (not live-linked)`);
    }
  });
}

/**
 * Points `dst` at `src`: left alone when it already does, replaced when it is the installer's own, else backed up first.
 * @param {object} ctx the run context
 * @param {object} record the install record
 * @param {string} src what the link points at
 * @param {string} dst where the link goes
 * @param {string} label the name shown in the log
 */
function linkOne(ctx, record, src, dst, label) {
  const stat = lstatOrNull(dst);
  if (stat?.isSymbolicLink() && samePath(resolve(dirname(dst), readlinkSync(dst)), src)) {
    remember(record, { kind: 'link', path: dst });
    note(ctx, `ok ${label}`);
    return;
  }
  if (stat && isOurs(ctx, record, dst, stat)) act(ctx, `replace the installer's own ${dst}`, () => (stat.isSymbolicLink() ? removeLink(dst) : rmSync(dst, { recursive: true, force: true })));
  else if (stat) backup(ctx, record, dst);
  ensureDir(ctx, record, dirname(dst));
  makeLink(ctx, record, src, dst, label);
}

/** Links each home/<name> of the root into ~/.claude, plus home/commands when it holds anything. */
export function linkHomeItems(ctx, record, names) {
  const home = join(ctx.root, 'home');
  const commands = join(home, 'commands');
  const all = existsSync(commands) && readdirSync(commands).length > 0 ? [...names, 'commands'] : names;
  for (const name of all) linkOne(ctx, record, join(home, name), join(ctx.claudeDir, name), name);
}

/** True when `path` lies inside `folder` (or is it). */
const isInside = (folder, path) => {
  const rel = relative(folder, path);
  return !rel.startsWith('..') && !isAbsolute(rel);
};

/**
 * Removes what an older install made that this one no longer makes, on every platform: a ~/.claude link whose home/ item left
 * `names` (the session modes folder, the workflows folder) and anything it put in the launcher folders ~/.local/bin and ~/.claude/bin (the mode launcher
 * and its Windows twins, retired with the modes: sessions start with `claude --model <m> --effort <e>`). Only links and copies the
 * install record names are looked at, and they leave the record once removed (an entry whose removal fails stays for the next
 * run); nothing else in those folders is. A path is removed only while it is still a link (never followed); a recorded copy (a
 * Windows launcher) goes to the backup folder marked as the installer's own, and a real file or folder at a recorded link path
 * goes there as the owner's, with a WARNING.
 * @param {object} ctx the run context
 * @param {object} record the install record
 * @param {string[]} names the home/ items this install links into ~/.claude
 */
export function removeRetiredLinks(ctx, record, names) {
  const launcherFolders = [join(ctx.home, '.local', 'bin'), join(ctx.claudeDir, 'bin')];
  const kept = new Set([...names, 'commands']);
  const isRetired = (path) =>
    launcherFolders.some((folder) => isInside(folder, path)) || (samePath(dirname(path), ctx.claudeDir) && !kept.has(basename(path)));
  for (const entry of record.made.filter((made) => ['link', 'copy'].includes(made.kind) && isRetired(made.path))) {
    act(ctx, `remove the retired ${entry.path}`, () => {
      const dropEntry = () => (record.made = record.made.filter((made) => made !== entry));
      const stat = lstatOrNull(entry.path);
      if (stat?.isSymbolicLink()) {
        removeLink(entry.path);
        note(ctx, `removed the retired ${entry.path}`);
      } else if (stat && entry.kind === 'copy') {
        // Still recorded, so backup() marks it the installer's own: --uninstall deletes that backup instead of restoring it.
        const saved = backup(ctx, record, entry.path);
        note(ctx, `moved the installer's own retired copy ${entry.path} to ${saved}`);
      } else if (stat) {
        // Out of the record first, so backup() records a real file or folder at a recorded link path as the owner's.
        dropEntry();
        const saved = backup(ctx, record, entry.path);
        warn(`${entry.path} is not a link (the owner's own file); moved it to ${saved} instead of deleting it`);
      }
      // Dropped only after the removal worked: an entry whose removal threw stays, and a later run retires it.
      dropEntry();
    });
  }
}
