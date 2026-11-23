// Purpose: the personal layer of an install. <repo>/personal/ (git-ignored by the core repo, its own git repo with a first
//   commit, so it has a history to sync) is made from personal.example/ when missing; notes the owner kept in the core folder
//   home/project-notes that git does not track move into personal/project-notes and are committed there; ~/.claude/project-notes links there; ~/.claude/CLAUDE.md is written as the marker line plus an
//   @ import of the core home/CLAUDE.md and, while it exists, of personal/CLAUDE.md.
// Exports: PERSONAL_DIR, PERSONAL_ITEMS, CLAUDE_MD_MARKER, importPath, checkImportPath, claudeMdText, isOwnFile, installPersonal,
//   restoreMovedNotes.
// Invariants: nothing in an existing personal/ is overwritten (a missing personal/ is published by one rename, so two installs never
//   mix their copies); writes stay inside ~/.claude and <repo>/personal, never through a link there; a note is moved, never deleted
//   (a name already taken in personal/project-notes sends the core copy to the backup folder); ~/.claude/CLAUDE.md is replaced
//   without a backup only while it is the installer's own (its marker line, or a link into this repo's home/), else it is backed
//   up first; a repo path that an @ import line cannot carry stops the install before anything changes.
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { runGit } from '../../home/hooks/lib/gated-folder.mjs';
import { readRegularFile } from '../../home/tools/env-names/lib/read-regular-file.mjs';
import { InstallError, act, note, samePath, warn } from './context.mjs';
import { backup, isMade, remember } from './record.mjs';
import { linkOne, removeLink } from './links.mjs';

export const PERSONAL_DIR = 'personal';
const TEMPLATE_DIR = 'personal.example';
const NOTES = 'project-notes';
const CLAUDE_MD = 'CLAUDE.md';
/** The ~/.claude items of install.mjs LINKS that this module makes instead of a link into home/. */
export const PERSONAL_ITEMS = [CLAUDE_MD, NOTES];
/** Line 1 of the generated ~/.claude/CLAUDE.md starts with this; it is how a later run and --uninstall know the file is theirs. */
export const CLAUDE_MD_MARKER = '<!-- claude-setup: written by scripts/install.sh';
const GENERATED = 'generated'; // the record kind of a file the installer writes and finds again by its marker
// Characters an `@` import line carries safely: a space ends the path, and @, #, quotes and non-ASCII letters are not proven to.
const IMPORT_PATH_SHAPE = /^(?:[A-Za-z]:)?\/[A-Za-z0-9._~/-]*$/;
const OWN_FILE_MAX_BYTES = 1024 * 1024; // the generated file is a few hundred bytes; a bigger one is never the installer's
// The author of the installer's commits in personal/ when git knows no user name and email (a fresh machine).
const INSTALL_AUTHOR = { name: 'claude-setup install', email: 'install@claude-setup.invalid' };
const FIRST_COMMIT_MESSAGE = 'personal layer: first commit by scripts/install.sh';
const NOTES_COMMIT_MESSAGE = 'project notes moved here from the core home/project-notes by scripts/install.sh';

const lstatOrNull = (path) => {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};
const isPlainDir = (path) => lstatOrNull(path)?.isDirectory() ?? false; // lstat: a link to a folder is not one
const isInside = (folder, path) => {
  const rel = relative(folder, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};
const personalDir = (ctx) => join(ctx.repo, PERSONAL_DIR);

/** `path` as an import line writes it: forward slashes on every OS (a Windows path keeps its drive letter). */
export const importPath = (path) => String(path).replaceAll('\\', '/');

/**
 * Refuses a path that an `@` import line in ~/.claude/CLAUDE.md cannot carry.
 * @param {string} path the repo or the tag worktree the import lines name
 * @throws {InstallError} exit 1, naming the path
 */
export function checkImportPath(path) {
  if (IMPORT_PATH_SHAPE.test(importPath(path))) return;
  throw new InstallError(
    `the path ${JSON.stringify(path)} has a character an @ import line in ~/.claude/CLAUDE.md cannot carry (a space, @, #, a quote or a ` +
      'non-ASCII letter); move the repo to a path of letters, digits and . _ - ~ / only, then run the installer again',
  );
}

/**
 * The text of ~/.claude/CLAUDE.md (scripts/doctor.sh builds the same lines).
 * @param {{root: string, repo: string}} ctx the run context: root holds the core home/, repo the personal/ folder
 * @param {boolean} withPersonal whether personal/CLAUDE.md exists, so the third line imports it
 * @returns {string} the marker line, the core import and the personal import, each ending in a newline
 */
export function claudeMdText(ctx, withPersonal) {
  const core = `${importPath(ctx.root)}/home/${CLAUDE_MD}`;
  const own = `${importPath(ctx.repo)}/${PERSONAL_DIR}/${CLAUDE_MD}`;
  const lines = [`${CLAUDE_MD_MARKER}; edit ${core} (shared) or ${own} (yours) -->`, `@${core}`, ...(withPersonal ? [`@${own}`] : [])];
  return `${lines.join('\n')}\n`;
}

/** The text of a plain file of at most OWN_FILE_MAX_BYTES; null for a link, a FIFO, a folder, a bigger file or no file. */
function plainText(path) {
  try {
    const read = readRegularFile(path, OWN_FILE_MAX_BYTES);
    return read.bytes ? read.bytes.toString('utf8') : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** True when `path` is a plain file whose first line starts with `marker` (the installer's own generated file). */
export const isOwnFile = (path, marker = CLAUDE_MD_MARKER) => plainText(path)?.startsWith(marker) ?? false;

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

/** Copies personal.example/ to a new folder beside it, makes it a git repo and publishes it as personal/ by one rename. */
function makePersonal(ctx, dir) {
  const template = join(ctx.repo, TEMPLATE_DIR);
  if (!isPlainDir(template)) throw new InstallError(`${template} is missing; check out the whole repo and run again`);
  act(ctx, `copy ${template} to ${dir} and make it a git repo`, () => {
    const staging = mkdtempSync(join(ctx.repo, `.${PERSONAL_DIR}-`)); // git-ignored, like personal/
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
 * either path is left alone (nothing is written through it).
 */
function ensurePersonal(ctx) {
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

/** The plain files in home/project-notes that git does not track (the owner's own notes); null when git cannot tell. */
function untrackedNotes(ctx, from) {
  const tracked = runGit(ctx.repo, ['ls-files', '-z', '--', `home/${NOTES}`]);
  if (tracked.status !== 0) return null;
  const known = new Set(tracked.stdout.split('\0').filter(Boolean).map((path) => basename(path)));
  const entries = existsSync(from) ? readdirSync(from, { withFileTypes: true }) : [];
  for (const entry of entries.filter((item) => !item.isFile() && !item.isDirectory())) warn(`${join(from, entry.name)} is not a plain file; left where it is`);
  return entries.filter((entry) => entry.isFile() && !entry.name.startsWith('.') && !known.has(entry.name)).map((entry) => entry.name);
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
 * the moved ones in the personal repo, so they are in its history from the move on.
 */
function moveOwnNotes(ctx, record) {
  const from = join(ctx.repo, 'home', NOTES);
  const to = join(personalDir(ctx), NOTES);
  const names = untrackedNotes(ctx, from);
  if (names === null) return warn(`git cannot list ${from} (no git, or not a git checkout); notes there are not moved`);
  if (names.length === 0) return;
  const intoPlainFolders = isPlainDir(personalDir(ctx)) && isPlainDir(to); // never moved through a link out of the repo
  if (!ctx.dryRun && !intoPlainFolders) return warn(`${to} is not a plain folder; your notes in ${from} stay there`);
  const moved = names.filter((name) => moveNote(ctx, record, join(from, name), join(to, name)));
  if (moved.length > 0 && existsSync(join(personalDir(ctx), '.git'))) {
    commitPersonal(personalDir(ctx), moved.map((name) => `${NOTES}/${name}`), NOTES_COMMIT_MESSAGE);
    note(ctx, `committed the ${moved.length} moved note(s) in ${personalDir(ctx)}`);
  }
}

/** True when the ~/.claude/CLAUDE.md link at `path` is the installer's: recorded as its link, or pointing into home/ of this repo. */
function isOurLink(ctx, record, path) {
  if (isMade(record, path)?.kind === 'link') return true;
  const target = resolve(dirname(path), readlinkSync(path));
  return [ctx.repo, ctx.root].some((root) => isInside(join(root, 'home'), target));
}

/**
 * What is at ~/.claude/CLAUDE.md now: nothing, the wanted text, the installer's own (its marker file, its link, or its Windows copy
 * of home/CLAUDE.md), or anything else (the user's, backed up before it is replaced).
 */
function claudeMdState(ctx, record, path, wanted) {
  const stat = lstatOrNull(path);
  if (!stat) return 'none';
  if (stat.isSymbolicLink()) return isOurLink(ctx, record, path) ? 'our-link' : 'foreign';
  const text = plainText(path);
  if (text === wanted) return 'same';
  if (text?.startsWith(CLAUDE_MD_MARKER)) return 'ours';
  const isOurCopy = isMade(record, path)?.kind === 'copy' && text !== null && text === plainText(join(ctx.root, 'home', CLAUDE_MD));
  return isOurCopy ? 'ours' : 'foreign';
}

/** Writes ~/.claude/CLAUDE.md (claudeMdText); a second run with the same text writes nothing and backs up nothing. */
function writeClaudeMd(ctx, record, withPersonal) {
  const path = join(ctx.claudeDir, CLAUDE_MD);
  const wanted = claudeMdText(ctx, withPersonal);
  const state = claudeMdState(ctx, record, path, wanted);
  // An older install's link or copy entry goes first, so a backup of the user's own file is never marked the installer's own.
  record.made = record.made.filter((made) => made.kind === GENERATED || !samePath(made.path, path));
  const entry = { kind: GENERATED, path, marker: CLAUDE_MD_MARKER };
  if (state === 'same') {
    remember(record, entry);
    note(ctx, `ok ${CLAUDE_MD}`);
    return;
  }
  if (state === 'our-link') act(ctx, `replace the installer's own link ${path}`, () => removeLink(path));
  else if (state === 'foreign') backup(ctx, record, path);
  act(ctx, `write ${path}: ${wanted.trim().split('\n').slice(1).join(' ')}`, () => {
    writeFileSync(path, wanted);
    remember(record, entry);
    note(ctx, `wrote ${CLAUDE_MD} (imports home/${CLAUDE_MD}${withPersonal ? ` and ${PERSONAL_DIR}/${CLAUDE_MD}` : ''})`);
  });
}

/**
 * The personal steps of an install, inside the install lock: personal/, the owner's notes, the project-notes link, CLAUDE.md.
 * @param {object} ctx the run context (repo, root, claudeDir, dryRun)
 * @param {object} record the install record (movedNotes and the CLAUDE.md entry are kept there)
 * @throws {InstallError} when the template is missing or git init fails (install.mjs has checked the import paths already)
 */
export function installPersonal(ctx, record) {
  const willCopyTemplate = !lstatOrNull(personalDir(ctx));
  ensurePersonal(ctx);
  moveOwnNotes(ctx, record);
  const notes = join(personalDir(ctx), NOTES);
  if (ctx.dryRun || isPlainDir(notes)) linkOne(ctx, record, notes, join(ctx.claudeDir, NOTES), NOTES);
  else warn(`${notes} is not a plain folder; ~/.claude/${NOTES} is not linked`);
  const personalClaudeMd = join(personalDir(ctx), CLAUDE_MD);
  const withPersonal = existsSync(personalClaudeMd) || (ctx.dryRun && willCopyTemplate && existsSync(join(ctx.repo, TEMPLATE_DIR, CLAUDE_MD)));
  writeClaudeMd(ctx, record, withPersonal);
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
  note(ctx, `kept ${join(ctx.repo, PERSONAL_DIR)} (your own files and git repo)`);
}
