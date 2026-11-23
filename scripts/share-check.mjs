#!/usr/bin/env node
// Purpose: refuse private words in the shared repo (owner rule R22): the owner's name, home paths, account, machine and work-project
//   names listed one per line in `personal/share-deny.txt` (git-ignored, the person's own) must not reach tracked core files or
//   commit messages.
// Usage: node scripts/share-check.mjs [--deny <file>] [--staged] [--history] [<path>...]
//   (no mode)   the tracked files of the working tree (only those under <path>... when given)
//   --staged    the index blobs of the files added or changed in the index (what the next commit holds; for a pre-commit hook)
//   --history   every commit message of every ref, and the commits whose changes add or remove a deny word, per word
// Output: one `<file>:<line>: <deny word>` per hit (a history hit: `share-check: history <word>: ...`); `share-check: skipped <file>
//   (<why>)` for a file not read (binary, over 2 MiB, a submodule, missing); one summary line. Exit 1 on a hit, 0 when clean,
//   0 with `share-check: not run (no deny list at <path>)` when there is no list, 2 with `share-check: error: <why>` on any failure.
// Exports: DENY_LIST_PATH, FILE_MAX_BYTES, parseDenyList, wordPattern, findHits, readDenyList, main.
// Invariants:
// - Trust boundary: the output never holds a line's text or the list; only file names (quoted and escaped when they hold a control
//   character, so a name cannot print a fake line), line numbers and the deny word that matched.
// - Read only: no file is written and git takes no optional lock, so two commits in two worktrees can run it at once.
// - The default list is `personal/share-deny.txt` of the main checkout (the parent of git's common folder), so a lane worktree, which
//   has no `personal/`, finds the same list; it never comes from the commit or the index.
// - Words match literally (regex characters included), case-insensitively, and only as whole words: a letter or digit next to
//   the word means no hit (`ice` never hits `service`); `_`, `-`, `/` and spaces are separators.
// - Fail closed: an unreadable list, an unreadable tracked file or a git failure exits 2 with why; never a silent 0.
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { readPlainFile } from '../home/hooks/lib/plain-file.mjs';
import { escaped } from '../home/hooks/lib/shown-name.mjs';

export const DENY_LIST_PATH = ['personal', 'share-deny.txt']; // below the main checkout
export const FILE_MAX_BYTES = 2 * 1024 * 1024; // a larger tracked file is listed as skipped, not read
const DENY_MAX_BYTES = 1024 * 1024; // a word list larger than this is refused (exit 2)
const BINARY_PROBE_BYTES = 8000; // git's own binary test: a NUL byte in the first 8000 bytes
const GIT_MAX_BUFFER_BYTES = 512 * 1024 * 1024; // the commit messages of a long history, the index list of a big repo
const HISTORY_SHAS_SHOWN = 10; // short commit ids printed per word; the rest is counted
const SHORT_SHA = 12;
const EXIT = Object.freeze({ clean: 0, hit: 1, error: 2 });
const WORD_CHAR = /[\p{L}\p{N}]/u;
// git config that would make a read run a program the repository names (as in home/hooks/lib/gated-folder.mjs). The git
// environment is kept on purpose: under a pre-commit hook GIT_INDEX_FILE names the index the commit is made from.
const HARDENED = ['-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false'];

class CheckError extends Error {}

/**
 * The deny words of a list: one per line, `#` lines and blank lines left out, CRLF and a BOM accepted, duplicates (any case) once.
 * @param {string} text the list file
 * @returns {string[]} the words, trimmed, in list order
 */
export function parseDenyList(text) {
  const seen = new Set();
  const words = [];
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const word = raw.trim();
    if (word === '' || word.startsWith('#') || seen.has(word.toLowerCase())) continue;
    seen.add(word.toLowerCase());
    words.push(word);
  }
  return words;
}

/**
 * The pattern of one deny word: literal, case-insensitive, with a word boundary on each side whose edge is a letter or digit.
 * @param {string} word a deny word
 * @returns {RegExp} a global, Unicode pattern
 */
export function wordPattern(word) {
  const literal = word.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const before = WORD_CHAR.test(word.at(0) ?? '') ? '(?<![\\p{L}\\p{N}])' : '';
  const after = WORD_CHAR.test(word.at(-1) ?? '') ? '(?![\\p{L}\\p{N}])' : '';
  return new RegExp(`${before}${literal}${after}`, 'giu');
}

/**
 * The hits of the deny words in a text: one per line and word.
 * @param {string} text the content
 * @param {{word: string, pattern: RegExp}[]} denied the words with their patterns (wordPattern)
 * @returns {{line: number, word: string}[]} 1-based line numbers, in line order
 */
export function findHits(text, denied) {
  const hits = [];
  text.split('\n').forEach((line, index) => {
    for (const { word, pattern } of denied) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) hits.push({ line: index + 1, word });
    }
  });
  return hits;
}

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

/** Why a file's bytes are not read as text, or null. */
const binaryReason = (bytes) => (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0) ? 'binary' : null);

/** One tracked file of the working tree: `{ text }` or `{ skip }`. A symlink is checked by its target, as git stores it. */
function readTracked(top, name) {
  const path = join(top, name);
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return { skip: 'missing in the working tree' };
    throw new CheckError(`${name} not readable (${error.code})`);
  }
  if (info.isSymbolicLink()) return { text: readlinkSync(path) };
  if (info.isDirectory()) return { skip: 'a submodule' };
  if (!info.isFile()) return { skip: 'not a regular file' };
  if (info.size > FILE_MAX_BYTES) return { skip: 'over 2 MiB' };
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new CheckError(`${name} not readable (${error.code})`);
  }
  const skip = binaryReason(bytes);
  return skip === null ? { text: bytes.toString('utf8') } : { skip };
}

const pathspecs = (paths) => ['--', ...(paths.length === 0 ? [':/'] : paths)];

/** The tracked files of the working tree, as `{ name, read }` (names relative to the top). */
function treeFiles(cwd, paths) {
  const top = gitText(cwd, ['rev-parse', '--show-toplevel']);
  return nulList(git(cwd, ['ls-files', '-z', '--full-name', ...pathspecs(paths)])).map((name) => ({ name, read: () => readTracked(top, name) }));
}

/** Blob ids, types and sizes for `shas` (`cat-file --batch-check`). */
function blobSizes(cwd, shas) {
  const lines = git(cwd, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], `${shas.join('\n')}\n`).toString('utf8');
  return new Map(lines.trim().split('\n').map((line) => line.split(' ')).map(([sha, type, size]) => [sha, { type, size: Number(size) }]));
}

/** One staged entry: `{ text }` or `{ skip }`, from its index blob. */
function readStaged(cwd, { mode, sha }, sizes) {
  if (mode === '160000') return { skip: 'a submodule' };
  const blob = sizes.get(sha);
  if (blob?.type !== 'blob') throw new CheckError(`index entry ${sha} is not a readable blob`);
  if (blob.size > FILE_MAX_BYTES) return { skip: 'over 2 MiB' };
  const bytes = git(cwd, ['cat-file', 'blob', sha]);
  const skip = mode === '120000' ? null : binaryReason(bytes);
  return skip === null ? { text: bytes.toString('utf8') } : { skip };
}

/** The files added or changed in the index, read from their index blobs (names relative to the top). */
function stagedFiles(cwd, paths) {
  const top = gitText(cwd, ['rev-parse', '--show-toplevel']);
  // diff names are relative to the top from any folder; a rename counts as a new file, so its whole content is checked
  const changed = nulList(git(cwd, ['diff', '--cached', '--name-only', '-z', '--no-renames', '--diff-filter=ACMT', ...pathspecs(paths)]));
  if (changed.length === 0) return [];
  const entries = nulList(git(top, ['ls-files', '-s', '-z', '--', ...changed.map((name) => `:(literal)${name}`)])).map((entry) => {
    const [meta, name] = entry.split('\t');
    const [mode, sha] = meta.split(' ');
    return { mode, sha, name };
  });
  const sizes = blobSizes(top, [...new Set(entries.map((entry) => entry.sha))]);
  return entries.map((entry) => ({ name: entry.name, read: () => readStaged(top, entry, sizes) }));
}

/** A file name as printed: as it is, or quoted and escaped when it holds a control or format character (repository text, P5). */
const shownFile = (name) => (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name) ? `"${escaped(name)}"` : name);

/** Checks files and prints hits, skips and the summary; returns the exit code. */
function checkFiles(files, denied, what) {
  let hitCount = 0;
  const hitFiles = new Set();
  let skipped = 0;
  for (const { name, read } of files) {
    const content = read();
    if (content.skip !== undefined) {
      skipped += 1;
      console.log(`share-check: skipped ${shownFile(name)} (${content.skip})`);
      continue;
    }
    for (const hit of findHits(content.text, denied)) {
      hitCount += 1;
      hitFiles.add(name);
      console.log(`${shownFile(name)}:${hit.line}: ${hit.word}`);
    }
  }
  const counts = `${files.length - skipped} ${what} checked, ${skipped} skipped, ${denied.length} words`;
  if (files.length === 0) console.log(`share-check: clean (0 ${what}: ${what === 'files' ? 'nothing tracked' : 'nothing added or changed in the index'})`);
  else if (hitCount === 0) console.log(`share-check: clean (${counts})`);
  else console.log(`share-check: ${hitCount} hits in ${hitFiles.size} files (${counts}); move these facts to personal/ or reword them`);
  return hitCount === 0 ? EXIT.clean : EXIT.hit;
}

/** The ERE of a deny word for `git log -G`: literal, with a non-alphanumeric (or line end) boundary where the word has a letter edge. */
function gitWordPattern(word) {
  const literal = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const before = WORD_CHAR.test(word.at(0) ?? '') ? '(^|[^[:alnum:]])' : '';
  const after = WORD_CHAR.test(word.at(-1) ?? '') ? '([^[:alnum:]]|$)' : '';
  return `${before}${literal}${after}`;
}

/** Prints, per deny word, the commits whose message holds it and those whose changes add or remove it; returns the exit code. */
function checkHistory(cwd, denied) {
  const messages = nulList(git(cwd, ['log', '--all', '-z', '--format=%H%n%B'])).map((record) => {
    const cut = record.indexOf('\n');
    return { sha: record.slice(0, cut === -1 ? undefined : cut), text: cut === -1 ? '' : record.slice(cut + 1) };
  });
  let hitWords = 0;
  for (const entry of denied) {
    const inMessages = messages.filter(({ text }) => findHits(text, [entry]).length > 0).map(({ sha }) => sha);
    const inChanges = gitText(cwd, ['log', '--all', '--format=%H', '-i', '-E', `-G${gitWordPattern(entry.word)}`]).split('\n').filter(Boolean);
    const commits = [...new Set([...inMessages, ...inChanges])];
    if (commits.length === 0) continue;
    hitWords += 1;
    const shown = commits.slice(0, HISTORY_SHAS_SHOWN).map((sha) => sha.slice(0, SHORT_SHA)).join(' ');
    const more = commits.length > HISTORY_SHAS_SHOWN ? ` +${commits.length - HISTORY_SHAS_SHOWN} more` : '';
    console.log(`share-check: history ${entry.word}: ${commits.length} commits (messages ${inMessages.length}, changes ${inChanges.length}): ${shown}${more}`);
  }
  const counts = `${messages.length} commits, ${denied.length} words`;
  console.log(hitWords === 0 ? `share-check: history clean (${counts})` : `share-check: history: ${hitWords} words found (${counts})`);
  return hitWords === 0 ? EXIT.clean : EXIT.hit;
}

/** Runs one check from the command-line arguments and returns its exit code; never throws. */
export function main(argv, cwd = process.cwd()) {
  try {
    const { values, positionals } = parseArgs({
      args: argv, allowPositionals: true,
      options: { deny: { type: 'string' }, staged: { type: 'boolean' }, history: { type: 'boolean' } },
    });
    if (values.staged && values.history) throw new CheckError('--staged and --history are separate checks: run one at a time');
    if (values.history && positionals.length > 0) throw new CheckError('--history checks the whole history and takes no path');
    const { path, words } = readDenyList(cwd, values.deny);
    if (words === null) return notRun(`no deny list at ${path}`);
    if (words.length === 0) return notRun(`no words in ${path}`);
    const denied = words.map((word) => ({ word, pattern: wordPattern(word) }));
    if (values.history) return checkHistory(cwd, denied);
    return values.staged ? checkFiles(stagedFiles(cwd, positionals), denied, 'staged files') : checkFiles(treeFiles(cwd, positionals), denied, 'files');
  } catch (error) {
    // every failure, a bad option or a bug included, is exit 2: exit 1 means a hit and must never come from a crash
    const kind = error instanceof CheckError || String(error.code).startsWith('ERR_PARSE_ARGS') ? '' : 'unexpected: ';
    console.error(`share-check: error: ${kind}${error.message}`);
    return EXIT.error;
  }
}

function notRun(why) {
  console.log(`share-check: not run (${why})`);
  return EXIT.clean;
}

if (process.argv[1] && import.meta.filename === realpathSync(process.argv[1])) process.exitCode = main(process.argv.slice(2));
