// Purpose: the links of an install: each home/ item into ~/.claude, the ccm launcher onto PATH, and (optional) the workflow
//   scripts into one project.
// Exports: linkHomeItems, linkLaunchers, projectWorkflows, removeLink.
// Invariants: a link that already points at the right place is left as it is (a second run changes nothing); a link or copy
//   the installer made, or an older install's link into this repo, is replaced without a backup; anything else is moved to the
//   backup folder first. On Windows a folder becomes a junction (no Developer Mode needed); a file link that is not allowed
//   falls back to a copy and says so.
import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmdirSync, rmSync, statSync, symlinkSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
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

/**
 * The ccm launcher: home/bin/ccm into ~/.local/bin (macOS, Linux and Git Bash); on Windows also ccm.cmd into ~/.claude/bin
 * and the ccm.ps1 it calls into ~/.claude/bin/ps (PowerShell would resolve a ccm.ps1 beside the shim first).
 * @returns {string[]} the folders that must be on PATH
 */
export function linkLaunchers(ctx, record) {
  const bin = join(ctx.root, 'home', 'bin');
  const localBin = join(ctx.home, '.local', 'bin');
  linkOne(ctx, record, join(bin, 'ccm'), join(localBin, 'ccm'), 'ccm');
  if (ctx.os !== 'windows') return [localBin];
  const claudeBin = join(ctx.claudeDir, 'bin');
  linkOne(ctx, record, join(bin, 'ccm.ps1'), join(claudeBin, 'ps', 'ccm.ps1'), 'ccm.ps1');
  linkOne(ctx, record, join(bin, 'ccm.cmd'), join(claudeBin, 'ccm.cmd'), 'ccm.cmd');
  return [localBin, claudeBin];
}

/** Warns for each folder that is not on this process's PATH (Windows: install.ps1 adds them to the user PATH). */
export function checkPath(ctx, folders) {
  const entries = (ctx.env.PATH || ctx.env.Path || '').split(delimiter);
  for (const folder of folders) {
    if (!entries.some((entry) => entry && samePath(entry, folder))) warn(`${folder} is not on PATH; add it to run ccm`);
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
