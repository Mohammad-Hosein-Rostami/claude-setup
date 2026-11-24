#!/usr/bin/env node
// Purpose: refuse private words in the shared repo (owner rule R22): the owner's name, home paths, account, machine and work-project
//   names listed one per line in `personal/share-deny.txt` (git-ignored, the person's own) must not reach tracked core files, their
//   paths or commit messages.
// Usage: node scripts/share-check.mjs [--deny <file>] [--staged | --history | --commit-msg <file>] [<path>...]
//   (no mode)          the tracked files of the working tree and their paths (only those under <path>... when given)
//   --staged           the index blobs and paths of the files added or changed in the index (what the next commit holds; pre-commit)
//   --history          every commit message of every ref, and every commit whose changes hold a deny word: in the old or the new
//                      content of a changed file, or in its path (scripts/share-check/history.mjs)
//   --commit-msg <f>   the message of the commit being made (the commit-msg hook, .githooks/commit-msg), without git's comment lines
//                      and what follows the scissors line, as git commits it
// Output: one `<file>:<line>: <deny word>` per hit in content, `<file>:name: <deny word>` for a word in a path, `commit message:<line>:
//   <deny word>` (a history hit: `share-check: history <word>: ...`); `share-check: skipped <file> (<why>)` for an entry with no content
//   to read (a submodule, missing in the working tree, not a regular file); one summary line. Exit 1 on a hit, 0 when clean,
//   0 with `share-check: not run (no deny list at <path>)` when there is no list and no personal/ folder (a clone without the
//   person's layer), 2 with `share-check: error: <why>` on any failure, a personal/ folder without its list included (with the fix).
// Exports: DENY_LIST_PATH, readDenyList, main.
// Invariants:
// - Trust boundary: the output never holds a line's text or the list; only file names (quoted and escaped when they hold a control
//   character, so a name cannot print a fake line), line numbers and the deny word that matched.
// - Read only: no file is written and git takes no optional lock, so two commits in two worktrees can run it at once.
// - The default list is `personal/share-deny.txt` of the main checkout (the parent of git's common folder), so a lane worktree, which
//   has no `personal/`, finds the same list; it never comes from the commit or the index.
// - Matching (scripts/share-check/match.mjs): literal, case-insensitive, whole words or identifier parts, after NFKC folding and
//   with zero-width characters removed; an entry's spaces match any white space, a line break included.
// - No content is skipped for its size or its bytes: binary and UTF-16 files are searched too (match.mjs); a file too large to read
//   is an error.
// - Fail closed: an unreadable list, an unreadable tracked file or a git failure exits 2 with why; never a silent 0. So is a default
//   list missing beside an existing personal/ entry (a folder, or a link even one that leads nowhere): that checkout has the
//   person's layer, so "not run" would hide a lost list.
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { readPlainFile } from '../home/hooks/lib/plain-file.mjs';
import { escaped } from '../home/hooks/lib/shown-name.mjs';
import { checkHistory } from './share-check/history.mjs';
import { findHits, findHitsInBytes, nameWords, parseDenyList, wordPattern } from './share-check/match.mjs';

export const DENY_LIST_PATH = ['personal', 'share-deny.txt']; // below the main checkout
const DENY_LIST_TEMPLATE = ['personal.example', 'share-deny.txt']; // the empty list the installer starts personal/ with
const DENY_MAX_BYTES = 1024 * 1024; // a word list larger than this is refused (exit 2)
const MESSAGE_MAX_BYTES = 1024 * 1024; // a commit message larger than this is refused (exit 2)
const GIT_MAX_BUFFER_BYTES = 512 * 1024 * 1024; // the blobs of a long history, the index list of a big repo
const SCISSORS = /^.*-{24} >8 -{24}$/m; // git's cut line (`git commit -v`): what follows it is not committed
const EXIT = Object.freeze({ clean: 0, hit: 1, error: 2 });
// git config that would make a read run a program the repository names (as in home/hooks/lib/gated-folder.mjs). The git
// environment is kept on purpose: under a pre-commit hook GIT_INDEX_FILE names the index the commit is made from.
const HARDENED = ['-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false'];

class CheckError extends Error {}

/** git in `cwd` as raw bytes; throws CheckError with git's first error line on a failure. */
function git(cwd, args, input) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  const result = spawnSync('git', [...HARDENED, ...args], { cwd, env, input, maxBuffer: GIT_MAX_BUFFER_BYTES });
  if (result.error) throw new CheckError(`git ${args[0]} did not run: ${result.error.message}`);
  if (result.status !== 0) throw new CheckError(`git ${args[0]} exited ${result.status}: ${String(result.stderr).split('\n')[0]}`);
  return result.stdout;
}

const gitText = (cwd, args) => git(cwd, args).toString('utf8').trim();
const nulList = (buffer) => buffer.toString('utf8').split('\0').filter((entry) => entry !== '');

/**
 * The deny list in force for a folder: `explicit` (the `--deny` file), else the main checkout's personal/share-deny.txt.
 * Also used by tests that check their own fixtures against the person's list.
 * @param {string} cwd a folder inside the repository
 * @param {string} [explicit] a list file named on the command line
 * @returns {{path: string, words: string[] | null}} words null when the default list does not exist
 * @throws {Error} when git fails, the explicit list is missing, or a list exists but is not a readable regular file of at most 1 MiB
 */
export function readDenyList(cwd, explicit) {
  const path = explicit ?? join(dirname(realpathSync(gitText(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']))), ...DENY_LIST_PATH);
  try {
    return { path, words: parseDenyList(readPlainFile(path, DENY_MAX_BYTES)) };
  } catch (error) {
    if (error.code === 'ENOENT' && explicit === undefined) return { path, words: null };
    throw new CheckError(`deny list ${path} not readable (${error.code ?? error.message})`);
  }
}

/** One tracked file of the working tree: `{ bytes }` or `{ skip }`. A symlink is checked by its target, as git stores it. */
function readTracked(top, name) {
  const path = join(top, name);
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return { skip: 'missing in the working tree' };
    throw new CheckError(`${name} not readable (${error.code})`);
  }
  if (info.isDirectory()) return { skip: 'a submodule' };
  if (!info.isFile() && !info.isSymbolicLink()) return { skip: 'not a regular file' };
  try {
    return { bytes: info.isSymbolicLink() ? readlinkSync(path, { encoding: 'buffer' }) : readFileSync(path) };
  } catch (error) {
    throw new CheckError(`${name} not readable (${error.code})`);
  }
}

const pathspecs = (paths) => ['--', ...(paths.length === 0 ? [':/'] : paths)];

/** The tracked files of the working tree, as `{ name, read }` (names relative to the top). */
function treeFiles(cwd, paths) {
  const top = gitText(cwd, ['rev-parse', '--show-toplevel']);
  return nulList(git(cwd, ['ls-files', '-z', '--full-name', ...pathspecs(paths)])).map((name) => ({ name, read: () => readTracked(top, name) }));
}

/** One staged entry: `{ bytes }` or `{ skip }`, from its index blob (a symlink's blob is its target). */
function readStaged(cwd, { mode, sha }) {
  if (mode === '160000') return { skip: 'a submodule' };
  return { bytes: git(cwd, ['cat-file', 'blob', sha]) };
}

/** The files added or changed in the index, read from their index blobs (names relative to the top). */
function stagedFiles(cwd, paths) {
  const top = gitText(cwd, ['rev-parse', '--show-toplevel']);
  // diff names are relative to the top from any folder; a rename counts as a new file, so its whole content is checked
  const changed = nulList(git(cwd, ['diff', '--cached', '--name-only', '-z', '--no-renames', '--diff-filter=ACMT', ...pathspecs(paths)]));
  if (changed.length === 0) return [];
  return nulList(git(top, ['ls-files', '-s', '-z', '--', ...changed.map((name) => `:(literal)${name}`)])).map((entry) => {
    const [meta, name] = entry.split('\t');
    const [mode, sha] = meta.split(' ');
    return { name, read: () => readStaged(top, { mode, sha }) };
  });
}

/** A file name as printed: as it is, or quoted and escaped when it holds a control or format character (repository text, P5). */
const shownFile = (name) => (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name) ? `"${escaped(name)}"` : name);

/** The hit lines of one file: the words of its path, then those of its content; `skip` when it has no content to read. */
function fileHits({ name, read }, denied) {
  const shown = shownFile(name);
  const lines = nameWords(name, denied).map((word) => `${shown}:name: ${word}`);
  const content = read();
  if (content.skip !== undefined) return { lines, skip: content.skip };
  return { lines: [...lines, ...findHitsInBytes(content.bytes, denied).map((hit) => `${shown}:${hit.line}: ${hit.word}`)] };
}

/** Checks files and prints hits, skips and the summary; returns the exit code. */
function checkFiles(files, denied, what) {
  let hitCount = 0;
  const hitFiles = new Set();
  let skipped = 0;
  for (const file of files) {
    const { lines, skip } = fileHits(file, denied);
    if (skip !== undefined) {
      skipped += 1;
      console.log(`share-check: skipped ${shownFile(file.name)} (${skip})`);
    }
    for (const line of lines) console.log(line);
    hitCount += lines.length;
    if (lines.length > 0) hitFiles.add(file.name);
  }
  const counts = `${files.length - skipped} ${what} checked, ${skipped} skipped, ${denied.length} words`;
  if (files.length === 0) console.log(`share-check: clean (0 ${what}: ${what === 'files' ? 'nothing tracked' : 'nothing added or changed in the index'})`);
  else if (hitCount === 0) console.log(`share-check: clean (${counts})`);
  else console.log(`share-check: ${hitCount} hits in ${hitFiles.size} files (${counts}); move these facts to personal/ or reword them`);
  return hitCount === 0 ? EXIT.clean : EXIT.hit;
}

/** Checks the message of the commit being made, as git will commit it (comments and the part below the scissors left out). */
function checkCommitMessage(cwd, file, denied) {
  let text;
  try {
    text = readPlainFile(file, MESSAGE_MAX_BYTES);
  } catch (error) {
    throw new CheckError(`commit message ${file} not readable (${error.code ?? error.message})`);
  }
  const cut = text.search(SCISSORS);
  // git's own clean-up, so core.commentChar is honoured as git commit honours it
  const message = git(cwd, ['stripspace', '--strip-comments'], cut === -1 ? text : text.slice(0, cut)).toString('utf8');
  const hits = findHits(message, denied);
  for (const hit of hits) console.log(`commit message:${hit.line}: ${hit.word}`);
  const counts = `${denied.length} words`;
  console.log(hits.length === 0 ? `share-check: commit message clean (${counts})` : `share-check: ${hits.length} hits in the commit message (${counts}); reword it`);
  return hits.length === 0 ? EXIT.clean : EXIT.hit;
}

/** Refuses option sets that mix checks. */
function checkOptions(values, positionals) {
  const modes = ['staged', 'history', 'commit-msg'].filter((mode) => values[mode] !== undefined && values[mode] !== false);
  if (modes.length > 1) throw new CheckError(`--${modes.join(' and --')} are separate checks: run one at a time`);
  if (modes.length === 1 && modes[0] !== 'staged' && positionals.length > 0) throw new CheckError(`--${modes[0]} takes no path`);
}

/** Runs one check from the command-line arguments and returns its exit code; never throws. */
export function main(argv, cwd = process.cwd()) {
  try {
    const { values, positionals } = parseArgs({
      args: argv, allowPositionals: true,
      options: { deny: { type: 'string' }, staged: { type: 'boolean' }, history: { type: 'boolean' }, 'commit-msg': { type: 'string' } },
    });
    checkOptions(values, positionals);
    const { path, words } = readDenyList(cwd, values.deny);
    if (words === null) return missingList(path);
    if (words.length === 0) return notRun(`no words in ${path}`);
    const denied = words.map((word) => ({ word, pattern: wordPattern(word) }));
    if (values.history) return checkHistory(cwd, denied, { git, fail: (why) => new CheckError(why) }) === 0 ? EXIT.clean : EXIT.hit;
    if (values['commit-msg'] !== undefined) return checkCommitMessage(cwd, values['commit-msg'], denied);
    return values.staged ? checkFiles(stagedFiles(cwd, positionals), denied, 'staged files') : checkFiles(treeFiles(cwd, positionals), denied, 'files');
  } catch (error) {
    // every failure, a bad option or a bug included, is exit 2: exit 1 means a hit and must never come from a crash
    const kind = error instanceof CheckError || String(error.code).startsWith('ERR_PARSE_ARGS') ? '' : 'unexpected: ';
    console.error(`share-check: error: ${kind}${error.message}`);
    return EXIT.error;
  }
}

/**
 * The answer when the default list does not exist: "not run" in a checkout with nothing at personal/ (a clone of the shared repo),
 * an error naming the fix when anything is there (the person's layer is installed, so the list was lost or never copied). lstat, so
 * a link that cannot be followed counts as there: following it would read a lost folder as a clone and let the commit through.
 * @param {string} path the default list, <main checkout>/personal/share-deny.txt
 * @returns {number} EXIT.clean after printing "not run"
 * @throws {CheckError} when anything exists at personal/
 */
function missingList(path) {
  const personal = dirname(path);
  if (lstatSync(personal, { throwIfNoEntry: false }) === undefined) return notRun(`no deny list at ${path}`);
  const template = join(dirname(personal), ...DENY_LIST_TEMPLATE);
  throw new CheckError(`no deny list at ${path}, but ${personal} exists; start it from the template: cp '${template}' '${path}'`);
}

function notRun(why) {
  console.log(`share-check: not run (${why})`);
  return EXIT.clean;
}

if (process.argv[1] && import.meta.filename === realpathSync(process.argv[1])) process.exitCode = main(process.argv.slice(2));
