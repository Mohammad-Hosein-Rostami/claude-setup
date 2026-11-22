// Purpose: the links of an install: each home/ item into ~/.claude, the removal of links an older install made for the retired
//   session modes (the launcher and the modes folder), and (optional) the workflow scripts into one project.
// Exports: linkHomeItems, removeRetiredLinks, projectWorkflows, removeLink.
// Invariants: a link that already points at the right place is left as it is (a second run changes nothing); a link or copy
//   the installer made, or an older install's link into this repo, is replaced without a backup; anything else is moved to the
//   backup folder first. On Windows a folder becomes a junction (no Developer Mode needed); a file link that is not allowed
//   falls back to a copy and says so.
import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmdirSync, rmSync, statSync, symlinkSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { InstallError, act, note, samePath, warn } from './context.mjs';
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
 * `names` (the session modes folder) and anything it put in the launcher folders ~/.local/bin and ~/.claude/bin (the mode launcher
 * and its Windows twins, retired with the modes: sessions start with `claude --model <m> --effort <e>`). Only links and copies the
 * install record names go, and they leave the record; nothing else in those folders is looked at.
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
      const stat = lstatOrNull(entry.path);
      if (stat?.isSymbolicLink()) removeLink(entry.path);
      else if (stat) rmSync(entry.path, { recursive: true, force: true });
      record.made = record.made.filter((made) => made !== entry);
      note(ctx, `removed the retired ${entry.path}`);
    });
  }
}

/**
 * Optional, default off: the workflow scripts usable by name (`/<name>`) in one project. A link stays personal (hidden by
 * .git/info/exclude); --copy copies the scripts so the team can commit them (a link into ~/.claude would break for them).
 * Copies are project files from then on: --uninstall leaves them.
 * @throws {InstallError} exit 2 when the folder is not a git repository
 */
export function projectWorkflows(ctx, record) {
  const repo = resolve(ctx.project);
  if (!existsSync(join(repo, '.git'))) throw new InstallError(`${repo} is not a git repository`, 2);
  const target = join(repo, '.claude', 'workflows');
  const src = join(ctx.root, 'home', 'workflows');
  if (!ctx.copy) {
    linkOne(ctx, record, src, target, 'project workflows link');
    hideFromGit(ctx, record, repo);
    return;
  }
  const stat = lstatOrNull(target);
  if (stat?.isSymbolicLink()) backup(ctx, record, target); // a link made earlier; a real folder keeps its other files
  ensureDir(ctx, record, target);
  act(ctx, `copy the workflow scripts into ${target}`, () => {
    for (const file of readdirSync(src).filter((name) => name.endsWith('.js'))) cpSync(join(src, file), join(target, file));
    note(ctx, `copied workflows into ${target}`);
  });
}

function hideFromGit(ctx, record, repo) {
  const line = '.claude/workflows';
  const asked = spawnSync('git', ['-C', repo, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8' });
  if (asked.status !== 0) throw new InstallError(`git rev-parse in ${repo} failed: ${asked.stderr.trim()}`);
  const raw = asked.stdout.trim();
  const exclude = isAbsolute(raw) ? raw : join(repo, raw);
  const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : null;
  if (text?.split(/\r?\n/).includes(line)) return;
  ensureDir(ctx, record, dirname(exclude));
  act(ctx, `hide ${line} in ${exclude}`, () => {
    appendFileSync(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`);
    remember(record, { kind: 'line', path: exclude, line, createdFile: text === null });
    note(ctx, `hid ${line} in ${exclude}`);
  });
}
