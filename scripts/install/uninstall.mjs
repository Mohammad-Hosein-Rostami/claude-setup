// Purpose: `install --uninstall`: undo exactly what the install record names, newest first, and put the backed-up files back.
// Exports: uninstall.
// Invariants: only recorded things are removed (a link only while it is still a link, a line only where it is still the same
//   line, a written file only while it holds exactly the text written, a folder only when empty); a note the
//   install moved into personal/project-notes goes back to home/project-notes only to a free path; a backup goes back only to a
//   free path (else it stays and is named); the installer's own earlier outputs in the backup folder are deleted, not restored;
//   with every step done the file list is as before the first install; whatever it leaves in place is listed at the end. Plugins, tool dependencies and personal/ stay (they
//   belong to Claude Code, to the repo and to the user).
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { act, leave, note, warn } from './context.mjs';
import { recordPath, loadRecord } from './record.mjs';
import { removeLine } from './startup.mjs';
import { removeLink } from './links.mjs';
import { removeWrittenFiles } from './personal.mjs';
import { restoreMovedNotes } from './personal-folder.mjs';

const exists = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

function removeMade(ctx, entry) {
  if (!exists(entry.path)) return;
  if (entry.kind === 'link' && !lstatSync(entry.path).isSymbolicLink()) {
    leave(ctx, entry.path, `${entry.path} is no longer the link the installer made; left as it is`);
    return;
  }
  act(ctx, `remove ${entry.kind} ${entry.path}`, () => {
    if (entry.kind === 'link') removeLink(entry.path);
    else if (entry.kind === 'line') removeLine(entry);
    else if (entry.kind === 'worktree') removeWorktree(entry);
    else rmSync(entry.path, { recursive: entry.kind === 'copy', force: true });
    note(ctx, `removed ${entry.kind === 'line' ? `the installer's line from ${entry.path}` : entry.path}`);
  });
}

function removeWorktree(entry) {
  const run = spawnSync('git', ['-C', entry.repo, 'worktree', 'remove', entry.path], { encoding: 'utf8' });
  if (run.status !== 0) warn(`git worktree remove ${entry.path} failed (${run.stderr.trim()}); remove it by hand`);
}

function restoreBackup(ctx, entry) {
  if (!exists(entry.backup)) {
    warn(`backup ${entry.backup} is gone; ${entry.path} not restored`);
    return;
  }
  if (entry.ours) {
    act(ctx, `delete the installer's own old ${entry.backup}`, () => rmSync(entry.backup, { recursive: true, force: true }));
    return;
  }
  if (exists(entry.path)) {
    leave(ctx, entry.backup, `${entry.path} exists again; its backup stays at ${entry.backup}`);
    return;
  }
  act(ctx, `restore ${entry.path}`, () => {
    mkdirSync(dirname(entry.path), { recursive: true });
    renameSync(entry.backup, entry.path);
    note(ctx, `restored ${entry.path}`);
  });
}

/** Removes `dir` and its parents up to `stop` while they are empty. */
function removeEmpty(dir, stop) {
  for (let current = dir; current.startsWith(stop) && existsSync(current) && readdirSync(current).length === 0; current = dirname(current)) {
    rmdirSync(current);
    if (current === stop) break;
  }
}

/** Removes an empty folder; one an install filled or removed since the check (the lock was let go before) is left as it is. */
function removeFolderIfStillEmpty(ctx, path) {
  try {
    rmdirSync(path);
  } catch (error) {
    if (error.code === 'ENOTEMPTY') leave(ctx, path, `${path} is not empty (an install started meanwhile); left as it is`);
    else if (error.code !== 'ENOENT') throw error;
  }
}

/**
 * Undoes the install this context's record describes.
 * @param {object} ctx the run context
 * @param {() => void} [release] lets go of the install lock; called before the made folders are removed, because the lock
 *   file sits in ~/.claude and would keep it from being empty
 */
export function uninstall(ctx, release = () => {}) {
  const record = loadRecord(ctx);
  if (record.fresh) {
    warn(`no install record at ${recordPath(ctx)}: nothing to undo (an install before the record is undone by hand)`);
    return;
  }
  const made = [...record.made].reverse();
  for (const entry of made.filter((item) => item.kind !== 'dir')) removeMade(ctx, entry);
  removeWrittenFiles(ctx, record);
  restoreMovedNotes(ctx, record);
  for (const entry of [...record.backups].reverse()) restoreBackup(ctx, entry);
  act(ctx, 'remove the empty backup folders and the install record', () => {
    for (const entry of record.backups) if (existsSync(dirname(entry.backup))) removeEmpty(dirname(entry.backup), entry.backupRoot);
    rmSync(recordPath(ctx), { force: true });
  });
  release();
  for (const entry of made.filter((item) => item.kind === 'dir')) {
    act(ctx, `remove folder ${entry.path} when empty`, () => {
      if (existsSync(entry.path) && readdirSync(entry.path).length === 0) removeFolderIfStillEmpty(ctx, entry.path);
      else if (existsSync(entry.path)) leave(ctx, entry.path, `${entry.path} is not empty (files made after the install); left as it is`);
    });
  }
  printLeftovers(ctx);
}

/** The list of what this --uninstall left in place (each also had its WARNING), or one line saying nothing was left. */
function printLeftovers(ctx) {
  if (ctx.left.length === 0) {
    console.log('Left in place: nothing the install record names');
    return;
  }
  console.log(`Left in place (${ctx.left.length}; remove or restore by hand):`);
  for (const { why } of ctx.left) console.log(`  - ${why}`);
}
