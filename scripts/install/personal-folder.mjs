// Purpose: the <repo>/personal/ folder of an install (split from personal.mjs, which writes ~/.claude/CLAUDE.md and runs these
//   steps). personal/ (git-ignored by the core repo, its own git repo with a first commit, so it has a history to sync) is made
//   from personal.example/ when missing. On the first install of the layer on a machine (~/.claude/project-notes not yet linked
//   into personal/), the owner's notes reach personal/project-notes: notes git deleted from home/project-notes while this checkout
//   moved forward (a pull of the commit that took them out of core) are restored from the commits HEAD was at here, then every
//   note there that git does not track is moved and committed. Later installs move nothing, so a shared note not yet committed
//   in home/project-notes stays in core.
// Exports: PERSONAL_DIR, NOTES, lstatOrNull, isPlainDir, personalDir, ensurePersonal, isLayerLinked, recoverDeletedNotes,
//   moveOwnNotes, restoreMovedNotes.
// Invariants: nothing in an existing personal/ is overwritten (a missing personal/ is published by one rename, so two installs never
//   mix their copies); writes stay inside <repo>/personal and <repo>/home/project-notes, never through a link; a note is moved,
//   never deleted (a name already taken in personal/project-notes sends the core copy to the backup folder); only commits of this
//   checkout's own HEAD history are read for notes (a fresh clone recovers nothing); a staging folder a stopped install left is
//   removed only once it is older than any live install.
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { runGit } from '../../home/hooks/lib/gated-folder.mjs';
import { InstallError, act, note, samePath, warn } from './context.mjs';
import { INSTALL_LOCK_STALE_MS, backup } from './record.mjs';

export const PERSONAL_DIR = 'personal';
export const NOTES = 'project-notes';
const TEMPLATE_DIR = 'personal.example';
const CORE_NOTES = `home/${NOTES}`; // as git names it, from the repo root
const STAGING_PREFIX = `.${PERSONAL_DIR}-`; // git-ignored (.gitignore /.personal-*), like personal/
const STAGING_NAME = /^\.personal-[A-Za-z0-9]{6}$/; // STAGING_PREFIX plus the six characters mkdtempSync adds
// A note name git history may hold that is restored: a plain file name, no folder part, not hidden.
const NOTE_NAME = /^[^./\\][^/\\]*$/;
// The author of the installer's commits in personal/ when git knows no user name and email (a fresh machine).
const INSTALL_AUTHOR = { name: 'claude-setup install', email: 'install@claude-setup.invalid' };
const FIRST_COMMIT_MESSAGE = 'personal layer: first commit by scripts/install.sh';
const NOTES_COMMIT_MESSAGE = 'project notes moved here from the core home/project-notes by scripts/install.sh';

/** lstat of `path`, or null when nothing is there. */
export const lstatOrNull = (path) => {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};
/** True for a folder that is no link (lstat: a link to a folder is not one). */
export const isPlainDir = (path) => lstatOrNull(path)?.isDirectory() ?? false;
/** <repo>/personal of the run context. */
export const personalDir = (ctx) => join(ctx.repo, PERSONAL_DIR);

/** git in `dir`, failing with an InstallError naming `what`; the hardened runner ignores GIT_DIR and the like and runs no hook. */
function gitIn(dir, args, what) {
  const run = runGit(dir, args);
  if (run.status === 0) return run;
  throw new InstallError(`${what} in ${dir} failed (${run.error?.message ?? run.stderr.trim()})`);
}

/** -c options for a commit by the installer: the user's own name and email when git has them, else a neutral stand-in. */
function commitIdentity(dir) {
  const known = runGit(dir, ['config', 'user.email']).status === 0 && runGit(dir, ['config', 'user.name']).status === 0;
  const identity = known ? [] : ['-c', `user.name=${INSTALL_AUTHOR.name}`, '-c', `user.email=${INSTALL_AUTHOR.email}`];
  return [...identity, '-c', 'commit.gpgsign=false']; // a signing program must not run in an install
}

/** Commits `paths` (relative to `dir`, all of what is there when empty) in the personal repo `dir`; nothing to commit is no error. */
function commitPersonal(dir, paths, message) {
  gitIn(dir, ['add', '-A', '--', ...(paths.length ? paths : ['.'])], 'git add');
  if (runGit(dir, ['diff', '--cached', '--quiet', '--', ...paths]).status === 0) return;
  gitIn(dir, [...commitIdentity(dir), 'commit', '-q', '-m', message, '--', ...paths], 'git commit');
}

/** Makes `dir` its own git repo with a first commit of what it holds, so it has a history from the start (and git clean skips it). */
function makeOwnRepo(dir) {
  gitIn(dir, ['init', '-q'], `git init (${PERSONAL_DIR}/ must be its own git repo so git clean -fdx in the clone skips it)`);
  commitPersonal(dir, [], FIRST_COMMIT_MESSAGE);
}

/** Removes the staging folders of installs that were stopped before their rename; a live install's folder is seconds old. */
function removeStaleStaging(ctx) {
  for (const name of readdirSync(ctx.repo).filter((entry) => STAGING_NAME.test(entry))) {
    const path = join(ctx.repo, name);
    const stat = lstatOrNull(path);
    if (!stat?.isDirectory() || Date.now() - stat.mtimeMs < INSTALL_LOCK_STALE_MS) continue;
    act(ctx, `remove ${path} (left by an install that was stopped)`, () => {
      rmSync(path, { recursive: true, force: true });
      note(ctx, `removed ${path}, the copy of ${TEMPLATE_DIR}/ a stopped install left`);
    });
  }
}

/** Copies personal.example/ to a new folder beside it, makes it a git repo and publishes it as personal/ by one rename. */
function makePersonal(ctx, dir) {
  const template = join(ctx.repo, TEMPLATE_DIR);
  if (!isPlainDir(template)) throw new InstallError(`${template} is missing; check out the whole repo and run again`);
  act(ctx, `copy ${template} to ${dir} and make it a git repo`, () => {
    const staging = mkdtempSync(join(ctx.repo, STAGING_PREFIX));
    try {
      cpSync(template, staging, { recursive: true, force: false, errorOnExist: true });
      makeOwnRepo(staging);
      renameSync(staging, dir); // refused when another install published personal/ meanwhile: that one stays
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code) || !existsSync(dir)) throw error;
      note(ctx, `ok ${dir} (another install made it just now)`);
      return;
    }
    note(ctx, `made ${dir} from ${TEMPLATE_DIR}/: your own git repo with a first commit; commit your changes there`);
  });
}

/**
 * personal/ made from the template when missing; an existing one only gets what keeps it safe and usable: a git repo of its own
 * (with a first commit of what it holds, only when this run made the repo) and its project-notes folder. A link or a file at
 * either path is left alone (nothing is written through it). A stopped install's staging copy goes first.
 * @param {object} ctx the run context (repo, dryRun)
 * @throws {InstallError} when the template is missing or git init fails
 */
export function ensurePersonal(ctx) {
  removeStaleStaging(ctx);
  const dir = personalDir(ctx);
  const stat = lstatOrNull(dir);
  if (!stat) return makePersonal(ctx, dir);
  if (!stat.isDirectory()) return warn(`${dir} is not a plain folder (a link or a file); nothing is written into it`);
  if (!existsSync(join(dir, '.git'))) {
    act(ctx, `git init ${dir} and commit what it holds`, () => {
      makeOwnRepo(dir);
      note(ctx, `made ${dir} its own git repo with a first commit (git clean -fdx in the clone now skips it)`);
    });
  }
  const notes = join(dir, NOTES);
  const notesStat = lstatOrNull(notes);
  if (!notesStat) act(ctx, `make folder ${notes}`, () => mkdirSync(notes));
  else if (!notesStat.isDirectory()) warn(`${notes} is not a plain folder (a link or a file); no note is moved into it`);
  note(ctx, `ok ${dir} (kept as it is)`);
}

/** True when ~/.claude/project-notes already links to personal/project-notes: the layer was installed here before. */
export function isLayerLinked(ctx) {
  const link = join(ctx.claudeDir, NOTES);
  if (!lstatOrNull(link)?.isSymbolicLink()) return false;
  return samePath(resolve(dirname(link), readlinkSync(link)), join(personalDir(ctx), NOTES));
}

/** Names in home/project-notes that git tracks now; null when git cannot tell. */
function trackedNotes(ctx) {
  const tracked = runGit(ctx.repo, ['ls-files', '-z', '--', CORE_NOTES]);
  return tracked.status === 0 ? new Set(tracked.stdout.split('\0').filter(Boolean).map((path) => basename(path))) : null;
}

/** The commits HEAD was at in this checkout (its reflog, newest first, and ORIG_HEAD); [] before the first commit; null on an error. */
function visitedCommits(repo) {
  const head = runGit(repo, ['rev-parse', '-q', '--verify', 'HEAD^{commit}']);
  if (head.status === 1 && head.stdout === '') return []; // no commit yet: no history to read
  const walk = runGit(repo, ['rev-list', '--walk-reflogs', 'HEAD']);
  if (head.status !== 0 || walk.status !== 0) return null;
  const before = runGit(repo, ['rev-parse', '-q', '--verify', 'ORIG_HEAD^{commit}']); // set by a pull or merge; absent is fine
  return [...new Set([...walk.stdout.split('\n'), ...(before.status === 0 ? [before.stdout] : [])].map((sha) => sha.trim()).filter(Boolean))];
}

/** Each note name home/project-notes held in `commits`, with the newest commit that held it; null when git cannot read one. */
function notesInHistory(repo, commits) {
  const newest = new Map();
  for (const commit of commits) {
    const tree = runGit(repo, ['ls-tree', '-z', '--full-tree', commit, '--', `${CORE_NOTES}/`]);
    if (tree.status !== 0) return null;
    for (const line of tree.stdout.split('\0').filter(Boolean)) {
      const [mode, type] = line.split(' ');
      const name = line.slice(line.indexOf('\t') + 1).slice(CORE_NOTES.length + 1);
      if (type === 'blob' && mode.startsWith('100') && NOTE_NAME.test(name) && !newest.has(name)) newest.set(name, commit);
    }
  }
  return newest;
}

/**
 * Puts back into home/project-notes each note git deleted there while this checkout moved forward (tracked in a commit HEAD was
 * at, tracked no more, absent from both folders), from the newest such commit; moveOwnNotes then moves it into personal/.
 * @param {object} ctx the run context (repo, dryRun)
 */
export function recoverDeletedNotes(ctx) {
  if (!ctx.dryRun && !isPlainDir(join(personalDir(ctx), NOTES))) return; // moveOwnNotes names the folder
  const commits = visitedCommits(ctx.repo);
  const history = commits && notesInHistory(ctx.repo, commits);
  const tracked = trackedNotes(ctx);
  if (!history || !tracked) return warn(`git cannot read the history of ${ctx.repo}; notes git deleted from ${CORE_NOTES} are not recovered`);
  const gone = (name) => !tracked.has(name) && !lstatOrNull(join(ctx.repo, CORE_NOTES, name)) && !lstatOrNull(join(personalDir(ctx), NOTES, name));
  for (const [name, commit] of [...history].filter(([candidate]) => gone(candidate))) {
    act(ctx, `restore ${CORE_NOTES}/${name} from commit ${commit}`, () => {
      // literal: a note name with * or : is a file name, not a pattern; --worktree: the index (git's tracked list) stays as it is
      gitIn(ctx.repo, ['--literal-pathspecs', 'restore', `--source=${commit}`, '--worktree', '--', `${CORE_NOTES}/${name}`], 'git restore');
      note(ctx, `restored your note ${name}, which git removed from ${CORE_NOTES}, from commit ${commit}`);
    });
  }
}

function moveNote(ctx, record, from, to) {
  if (lstatOrNull(to)) {
    const saved = backup(ctx, record, from);
    warn(`${to} already exists, so ${from} went to ${saved} instead (compare the two and keep what you need)`);
    return;
  }
  return act(ctx, `move ${from} to ${to}`, () => {
    renameSync(from, to);
    record.movedNotes = [...(record.movedNotes ?? []), { from, to }];
    note(ctx, `moved your note ${basename(from)} to ${dirname(to)}`);
    return true;
  });
}

/**
 * Moves the owner's untracked notes out of the core folder into personal/project-notes (shared, tracked notes stay) and commits
 * the moved ones in the personal repo, so they are in its history from the move on. installPersonal runs it on the first install
 * of the layer only.
 * @param {object} ctx the run context
 * @param {object} record the install record (movedNotes, backups)
 */
export function moveOwnNotes(ctx, record) {
  const from = join(ctx.repo, CORE_NOTES);
  const to = join(personalDir(ctx), NOTES);
  const tracked = trackedNotes(ctx);
  if (tracked === null) return warn(`git cannot list ${from} (no git, or not a git checkout); notes there are not moved`);
  const entries = existsSync(from) ? readdirSync(from, { withFileTypes: true }) : [];
  for (const entry of entries.filter((item) => !item.isFile() && !item.isDirectory())) warn(`${join(from, entry.name)} is not a plain file; left where it is`);
  const names = entries.filter((entry) => entry.isFile() && !entry.name.startsWith('.') && !tracked.has(entry.name)).map((entry) => entry.name);
  if (names.length === 0) return;
  const intoPlainFolders = isPlainDir(personalDir(ctx)) && isPlainDir(to); // never moved through a link out of the repo
  if (!ctx.dryRun && !intoPlainFolders) return warn(`${to} is not a plain folder; your notes in ${from} stay there`);
  const moved = names.filter((name) => moveNote(ctx, record, join(from, name), join(to, name)));
  if (moved.length > 0 && existsSync(join(personalDir(ctx), '.git'))) {
    commitPersonal(personalDir(ctx), moved.map((name) => `${NOTES}/${name}`), NOTES_COMMIT_MESSAGE);
    note(ctx, `committed the ${moved.length} moved note(s) in ${personalDir(ctx)}`);
  }
}

/**
 * --uninstall: moves each note an install moved into personal/project-notes back to home/project-notes, newest first. A note
 * gone from personal/, or whose old place is taken again, stays where it is and is named. personal/ itself always stays.
 * @param {object} ctx the run context
 * @param {object} record the install record
 */
export function restoreMovedNotes(ctx, record) {
  for (const { from, to } of [...(record.movedNotes ?? [])].reverse()) {
    if (!lstatOrNull(to)) warn(`${to} is gone; not moved back to ${from}`);
    else if (lstatOrNull(from)) warn(`${from} exists again; your note stays at ${to}`);
    else {
      act(ctx, `move ${to} back to ${from}`, () => {
        mkdirSync(dirname(from), { recursive: true });
        renameSync(to, from);
        note(ctx, `moved your note ${basename(from)} back to ${dirname(from)}`);
      });
    }
  }
  note(ctx, `kept ${personalDir(ctx)} (your own files and git repo)`);
}
