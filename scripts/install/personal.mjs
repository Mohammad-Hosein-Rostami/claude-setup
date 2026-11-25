// Purpose: the personal layer of an install. Runs the <repo>/personal/ steps (personal-folder.mjs: the folder from personal.example/,
//   the owner's notes into personal/project-notes), links ~/.claude/project-notes there, and writes ~/.claude/CLAUDE.md as the
//   marker line plus an @ import of the core home/CLAUDE.md and, while it exists, of personal/CLAUDE.md. In a linked git worktree
//   (a lane, or a test run there with a temp HOME) it only writes ~/.claude/CLAUDE.md with the core import: personal/ belongs to
//   the main checkout, and one made in a lane would stop `land` from removing that worktree.
// Exports: PERSONAL_ITEMS, CLAUDE_MD_MARKER, importPath, checkImportPath, claudeMdText, hasInstallMarker, installPersonal,
//   removeWrittenFiles.
// Invariants: writes stay inside ~/.claude and <repo>/personal, never through a link there; ~/.claude/CLAUDE.md is replaced
//   without a backup only while its whole text is what the installer last wrote there (the sha256 in the record's `written`
//   list), or it is the installer's link into this repo's home/ or its Windows copy of home/CLAUDE.md; anything else, a file
//   that starts with the marker but holds the user's own lines included, is backed up first. --uninstall removes it only while
//   that sha256 still matches. The file is listed in `written`, never in `made`: an older uninstaller removes every `made`
//   entry of a kind it does not know, and would delete the user's lines. A repo path that an @ import line cannot carry stops
//   the install before anything changes.
import { createHash } from 'node:crypto';
import { existsSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { worktreeOf } from '../../home/hooks/lib/gated-folder.mjs';
import { readRegularFile } from '../../home/tools/env-names/lib/read-regular-file.mjs';
import { InstallError, act, leave, note, samePath, warn } from './context.mjs';
import { backup, isMade } from './record.mjs';
import { linkOne, removeLink } from './links.mjs';
import { NOTES, PERSONAL_DIR, ensurePersonal, isLayerLinked, isPlainDir, lstatOrNull, moveOwnNotes, personalDir, recoverDeletedNotes } from './personal-folder.mjs';

const TEMPLATE_DIR = 'personal.example';
const CLAUDE_MD = 'CLAUDE.md';
/** The ~/.claude items of install.mjs LINKS that this module makes instead of a link into home/. */
export const PERSONAL_ITEMS = [CLAUDE_MD, NOTES];
/** Line 1 of the generated ~/.claude/CLAUDE.md starts with this; it tells isNewMachine the setup was installed here before. */
export const CLAUDE_MD_MARKER = '<!-- claude-setup: written by scripts/install.sh';
// Characters an `@` import line carries safely: a space ends the path, and @, #, quotes and non-ASCII letters are not proven to.
const IMPORT_PATH_SHAPE = /^(?:[A-Za-z]:)?\/[A-Za-z0-9._~/-]*$/;
const OWN_FILE_MAX_BYTES = 1024 * 1024; // the generated file is a few hundred bytes; a bigger one is never the installer's

const isInside = (folder, path) => {
  const rel = relative(folder, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};
const digest = (text) => createHash('sha256').update(text).digest('hex');

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
 * The text of ~/.claude/CLAUDE.md.
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

/** True when `path` is a plain file whose first line starts with `marker`: some install wrote it once (its text may be edited since). */
export const hasInstallMarker = (path, marker = CLAUDE_MD_MARKER) => plainText(path)?.startsWith(marker) ?? false;

/** The record's `written` list ({path, sha256} of each file the installer wrote); [] in a record from before it. */
function writtenList(record) {
  if (record.written === undefined) return [];
  if (!Array.isArray(record.written)) throw new InstallError('the install record\'s "written" is not a list; move the record away and run again');
  return record.written;
}

/** True when the file of `entry` still holds exactly the text the installer wrote there. */
function isUnchangedWrite(entry) {
  const text = plainText(entry.path);
  return text !== null && typeof entry.sha256 === 'string' && digest(text) === entry.sha256;
}

/** True when the ~/.claude/CLAUDE.md link at `path` is the installer's: recorded as its link, or pointing into home/ of this repo. */
function isOurLink(ctx, record, path) {
  if (isMade(record, path)?.kind === 'link') return true;
  const target = resolve(dirname(path), readlinkSync(path));
  return [ctx.repo, ctx.root].some((root) => isInside(join(root, 'home'), target));
}

/**
 * What is at ~/.claude/CLAUDE.md now: nothing, the wanted text, the installer's own (the exact text it last wrote, its link, or
 * its Windows copy of home/CLAUDE.md), or anything else (the user's, backed up before it is replaced).
 */
function claudeMdState(ctx, record, path, wanted) {
  const stat = lstatOrNull(path);
  if (!stat) return 'none';
  if (stat.isSymbolicLink()) return isOurLink(ctx, record, path) ? 'our-link' : 'foreign';
  const text = plainText(path);
  if (text === wanted) return 'same';
  const written = writtenList(record).find((entry) => samePath(entry.path, path));
  if (written && isUnchangedWrite(written)) return 'ours';
  const isOurCopy = isMade(record, path)?.kind === 'copy' && text !== null && text === plainText(join(ctx.root, 'home', CLAUDE_MD));
  return isOurCopy ? 'ours' : 'foreign';
}

/** Lists `path` with the sha256 of `text` in the record's `written` list, replacing an older entry for that path. */
function rememberWrite(record, path, text) {
  record.written = [...writtenList(record).filter((entry) => !samePath(entry.path, path)), { path, sha256: digest(text) }];
}

/** Writes ~/.claude/CLAUDE.md (claudeMdText); a second run with the same text writes nothing and backs up nothing. */
function writeClaudeMd(ctx, record, withPersonal) {
  const path = join(ctx.claudeDir, CLAUDE_MD);
  const wanted = claudeMdText(ctx, withPersonal);
  const state = claudeMdState(ctx, record, path, wanted);
  // An older install's link or copy entry goes first, so a backup of the user's own file is never marked the installer's own.
  record.made = record.made.filter((made) => !samePath(made.path, path));
  if (state === 'same') {
    rememberWrite(record, path, wanted);
    note(ctx, `ok ${CLAUDE_MD}`);
    return;
  }
  if (state === 'our-link') act(ctx, `replace the installer's own link ${path}`, () => removeLink(path));
  else if (state === 'foreign') backup(ctx, record, path);
  act(ctx, `write ${path}: ${wanted.trim().split('\n').slice(1).join(' ')}`, () => {
    writeFileSync(path, wanted);
    rememberWrite(record, path, wanted);
    note(ctx, `wrote ${CLAUDE_MD} (imports home/${CLAUDE_MD}${withPersonal ? ` and ${PERSONAL_DIR}/${CLAUDE_MD}` : ''})`);
  });
}

/** True when `repo` is a linked git worktree (its git folder is not the shared one); false for the main checkout or no git. */
function isLinkedWorktree(repo) {
  const worktree = worktreeOf(repo);
  return worktree !== null && !samePath(worktree.gitDir, worktree.commonDir);
}

/**
 * The personal steps of an install, inside the install lock: personal/, on the layer's first install the owner's notes (restored
 * from git history when a pull removed them, then moved), the project-notes link, CLAUDE.md. In a linked worktree only CLAUDE.md,
 * with the core import (header).
 * @param {object} ctx the run context (repo, root, claudeDir, dryRun)
 * @param {object} record the install record (movedNotes, backups, and the CLAUDE.md entry of `written` are kept there)
 * @throws {InstallError} when the template is missing or a git step fails (install.mjs has checked the import paths already)
 */
export function installPersonal(ctx, record) {
  if (isLinkedWorktree(ctx.repo)) {
    note(ctx, `skipped ${PERSONAL_DIR}/ and ~/.claude/${NOTES}: ${ctx.repo} is a linked git worktree; the personal layer belongs to the main checkout`);
    return writeClaudeMd(ctx, record, false);
  }
  const willCopyTemplate = !lstatOrNull(personalDir(ctx));
  const firstLayerInstall = !isLayerLinked(ctx); // read before the link below is made
  ensurePersonal(ctx);
  if (firstLayerInstall) {
    recoverDeletedNotes(ctx);
    moveOwnNotes(ctx, record);
  }
  const notes = join(personalDir(ctx), NOTES);
  if (ctx.dryRun || isPlainDir(notes)) linkOne(ctx, record, notes, join(ctx.claudeDir, NOTES), NOTES);
  else warn(`${notes} is not a plain folder; ~/.claude/${NOTES} is not linked`);
  const personalClaudeMd = join(personalDir(ctx), CLAUDE_MD);
  const withPersonal = existsSync(personalClaudeMd) || (ctx.dryRun && willCopyTemplate && existsSync(join(ctx.repo, TEMPLATE_DIR, CLAUDE_MD)));
  writeClaudeMd(ctx, record, withPersonal);
}

/**
 * --uninstall: removes each file the installer wrote while it holds exactly the text written; an edited one stays (named).
 * @param {object} ctx the run context
 * @param {object} record the install record
 * @throws {InstallError} when the record's `written` is not a list
 */
export function removeWrittenFiles(ctx, record) {
  for (const entry of [...writtenList(record)].reverse()) {
    if (!lstatOrNull(entry.path)) continue;
    if (!isUnchangedWrite(entry)) {
      leave(ctx, entry.path, `${entry.path} changed since the installer wrote it (your lines are in it); left as it is`);
      continue;
    }
    act(ctx, `remove ${entry.path}`, () => {
      rmSync(entry.path, { force: true });
      note(ctx, `removed ${entry.path}`);
    });
  }
}
