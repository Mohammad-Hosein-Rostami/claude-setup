// Purpose: read the changed files and lines of a range (or of a delta round) from git for review-tier.
// Exports: MAX_READING, parsePatch(text), readRange(git, range),
//   readDelta(git, shas), newFileReader(git, sha), functionNames(files), redefinedNames(files), requiredReadingFor(git, files, head).
// The base, HEAD and the sides of a range are resolved in lib/revisions.mjs; this module reads ranges of shas.
// Invariants: every git call goes through the trusted reader (`git`, lib/trusted-git.mjs): an empty repository of the tool's own that
//   borrows the lane's objects, so the lane's config, attributes, refs, index and working tree are never read, and neither are the user's
//   git files. Every commit arrives here as a full sha (the word HEAD is only printed). The only input left is the content of the object
//   store, re-hashed before it is read (lib/verify-objects.mjs); what stays outside the tool is an object swapped after that check by a
//   process still running. Only tree diffs between commits are read: no patch of one commit is compared with another's. No path goes
//   back to git as a pathspec: a diff is read whole and the lane's paths are picked here, by their bytes. Patches are read with fixed
//   flags (PATCH_FLAGS). Only paths and line numbers leave this module through the report; line texts stay in memory for the class
//   tests. Required reading is written with names as data (lib/brief-data.mjs): they go into briefs as they are.
import { UsageError } from '../../git-tidy/lib/git.mjs';
import { placeText } from './brief-data.mjs';

export const MAX_READING = 20; // callers and callees listed as required reading
const MAX_WHOLE_FILE_CHARS = 1 << 20;
const MIN_NAME_LENGTH = 3;
// What every patch is printed with, whatever config or attributes could say (security S6 of lane r7-delta; the trusted reader has neither,
// these stay as the second layer): --text reads a file marked `-diff` or `binary` as the text it is, no external diff or textconv runs,
// and the prefixes are fixed (diff.noprefix and diff.mnemonicPrefix would change the `+++ b/path` lines).
const PATCH_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--text', '-M', '--src-prefix=a/', '--dst-prefix=b/'];
// A changed submodule pointer is always listed: `diff.ignoreSubmodules` and `ignore = all` in .gitmodules would hide it (security B9).
const SUBMODULES_SHOWN = '--ignore-submodules=none';
const DIFF_FLAGS = ['diff', '-U0', ...PATCH_FLAGS, SUBMODULES_SHOWN];
const NAME_FLAGS = ['diff', '--name-only', '-z', '--no-renames', SUBMODULES_SHOWN];
const NUL = 0;
const GREP_NO_MATCH = 1; // git grep exits 1 when nothing matches; anything above is a failure
const MAX_REWRITE_PLACES = 8; // places a rewrite changed, named first in a rewritten lane's Read first
const HEADER_MARK_LENGTH = '+++ '.length;
const SIDE_PREFIX_LENGTH = 'b/'.length;
// The escapes git writes in a quoted path (quote.c): a letter, or three octal digits for any other control character.
const C_ESCAPES = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', '"': '"', '\\': '\\' };
const C_ESCAPE = /\\([0-7]{3}|["\\abtnvfr])/g;
const OCTAL = 8;
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/;
const CALL = /(?<![.\w$])([A-Za-z_$][\w$]*)\(/g;
const NOT_A_FUNCTION = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'await', 'new', 'import', 'require', 'super']);
// Any name a line defines (a function, a constant, a class, a type): what a fix can remove, rename or redefine under its users.
const NAME_DEFINITION = /\b(?:const|let|var|class|function\s*\*?|def|func|fn|type|interface|enum)\s+([A-Za-z_$][\w$]*)/;
const FUNCTION_DEFINITION = /\bfunction\s*\*?\s+([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|\b(?:def|func|fn)\s+([A-Za-z_$][\w$]*)/;

/**
 * The path of a `+++ b/<path>` or `--- a/<path>` line. Git ends the line with a TAB when the path holds a space: that TAB is no part of the
 * name. A path with a quote, a backslash or a control character is printed C-quoted (`+++ "b/a\"b.md"`, also with core.quotePath=false):
 * read as it stands it would be another file than the one `--name-only -z` lists, and a gate file would lose its class (security N12).
 */
function pathOf(headerLine) {
  const side = headerLine.slice(HEADER_MARK_LENGTH);
  if (!side.startsWith('"')) return side.slice(SIDE_PREFIX_LENGTH).replace(/\t$/, '');
  const unquoted = side.slice(1, side.lastIndexOf('"')).replace(C_ESCAPE, (_, code) => C_ESCAPES[code] ?? String.fromCharCode(parseInt(code, OCTAL)));
  return unquoted.slice(SIDE_PREFIX_LENGTH);
}

/**
 * The paths of a `--name-only -z` listing, from its bytes: NUL-separated, so no path is quoted or cut at a line break.
 * @param {Buffer} listing git's stdout as bytes
 * @returns {string[]} each path as text that holds exactly its bytes, so comparing two of them compares bytes
 * @throws {UsageError} for a path that is not UTF-8: decoded, it would be the same text as another path with other bytes
 */
function namesOf(listing) {
  const names = [];
  for (let at = 0; at < listing.length;) {
    const end = listing.indexOf(NUL, at);
    const raw = listing.subarray(at, end < 0 ? listing.length : end);
    const name = raw.toString('utf8');
    if (!Buffer.from(name, 'utf8').equals(raw)) throw new UsageError(`a changed path is not UTF-8 (${JSON.stringify(name)}, bytes ${raw.toString('hex')}): its name cannot be told from another one's here. Rename the file, or review by hand`);
    if (name !== '') names.push(name);
    at += raw.length + 1;
  }
  return names;
}

/**
 * Parses `git diff -U0` text into one entry per path (a path in several patches is merged).
 * `hunkHeads` holds the text after each `@@` (the enclosing function line git picked).
 * @returns {{path: string, added: {line: number, text: string}[], removed: {line: number, text: string}[], hunkHeads: string[]}[]}
 */
export function parsePatch(text) {
  const byPath = new Map();
  let current = null;
  let newLine = 0;
  let inHunk = false;
  const entry = (path) => {
    if (!byPath.has(path)) byPath.set(path, { path, added: [], removed: [], hunkHeads: [] });
    return byPath.get(path);
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) { current = null; inHunk = false; continue; }
    if (!inHunk && line.startsWith('+++ ')) { if (line !== '+++ /dev/null') current = entry(pathOf(line)); continue; }
    if (!inHunk && line.startsWith('--- ')) { if (line !== '--- /dev/null') current = entry(pathOf(line)); continue; }
    const hunk = HUNK.exec(line);
    if (hunk !== null) {
      inHunk = true;
      newLine = Number(hunk[1]);
      if (current !== null && hunk[2] !== '') current.hunkHeads.push(hunk[2]);
      continue;
    }
    if (!inHunk || current === null) continue;
    if (line.startsWith('+')) current.added.push({ line: newLine++, text: line.slice(1) });
    else if (line.startsWith('-')) current.removed.push({ line: newLine, text: line.slice(1) });
  }
  return [...byPath.values()];
}

/** Adds to `files` every path in `names` that has no entry yet: one with no hunk (both paths of a pure rename, a binary file, a mode change). */
function withHunklessFiles(names, files) {
  const known = new Set(files.map((file) => file.path));
  return [...files, ...names.filter((name) => !known.has(name)).map((path) => ({ path, added: [], removed: [], hunkHeads: [] }))];
}

// --no-renames: a pure rename lists both its paths, so a gate file renamed away is still read as changed.
const diffNames = (git, args) => namesOf(git.bytes([...NAME_FLAGS, ...args, '--']));

/** The changed files of one tree diff, read whole. `args`: a range of shas (`a..b`, `a...b`) or two shas, after any extra diff flag. */
const readDiff = (git, args) => withHunklessFiles(diffNames(git, args), parsePatch(git.bytes([...DIFF_FLAGS, ...args, '--']).toString('utf8')));

/** The changed files of `range` (`a..b` or `a...b`, both sides full shas). */
export const readRange = (git, range) => readDiff(git, [range]);

/** The whole text of `path` at the commit `sha` (cut at 1 MiB), or null when it does not exist there. */
export function newFileReader(git, sha) {
  return (path) => {
    const { status, stdout } = git.run(['show', `${sha}:${path}`]);
    return status === 0 ? stdout.toString('utf8').slice(0, MAX_WHOLE_FILE_CHARS) : null;
  };
}

/** Two readings of the same files as one: a path in both keeps every line of each once (a fix line is in the lane diff and in the diff since the review). */
function mergedFiles(first, second) {
  const byPath = new Map(first.map((file) => [file.path, { ...file }]));
  const keyOf = ({ line, text }) => `${line}\0${text}`;
  const joined = (a, b) => [...a, ...b.filter((entry) => !a.some((known) => keyOf(known) === keyOf(entry)))];
  for (const file of second) {
    const known = byPath.get(file.path);
    byPath.set(file.path, known === undefined ? file : { path: file.path, added: joined(known.added, file.added), removed: joined(known.removed, file.removed), hunkHeads: [...new Set([...known.hunkHeads, ...file.hunkHeads])] });
  }
  return [...byPath.values()];
}

/**
 * A rewritten lane (the reviewed sha is no ancestor of HEAD: a rebase, an amend, a rebuilt branch) is read whole, always: the tree diff
 * `<base>..HEAD`, plus what changed since the reviewed commit in the lane's files (the files of the lane now and of the lane as it was
 * reviewed), so a line the rewrite took out is read as a removed line. No patch is compared with another: a comparison of histories is
 * something the writer of the rewrite can shape (security B4 and B5 of lane r7-delta). It never refuses: the land loop's conflict path ends here.
 * The diff since the reviewed commit is read whole and the lane's files are picked here, by name: a path handed back to git as a pathspec
 * is a pattern git may fold (an NFD name on macOS matched nothing: security B10) or read as magic (`:(exclude)x`). It is read without
 * rename detection, so each lane file is read under its own name, as it was when only the lane's paths were asked for.
 */
function rewrittenLane(git, { base, reviewed: reviewedSha, head }) {
  const laneRange = `${base}..HEAD`;
  const lanePaths = new Set([...diffNames(git, [`${base}..${head}`]), ...diffNames(git, [`${base}...${reviewedSha}`])]);
  const since = readDiff(git, ['--no-renames', reviewedSha, head]).filter((file) => lanePaths.has(file.path));
  return {
    range: `${laneRange} (rewritten lane: the reviewed commit ${reviewedSha} is no ancestor of HEAD, so the whole lane is read)`,
    files: mergedFiles(readRange(git, `${base}..${head}`), since),
    reading: [
      `the output of \`git range-diff ${base}..${reviewedSha} ${base}..HEAD\` (what the rewrite changed, commit by commit)`,
      `the output of \`git diff ${reviewedSha} HEAD\` for the lane's files (what the rewrite changed in them, line by line; the places named next are where each of those files first differs)`,
      ...changedPlaces(since).slice(0, MAX_REWRITE_PLACES),
    ],
  };
}

/**
 * What a fix round reads, from two recorded commits: the tree diff `<reviewed>..HEAD` when the reviewed commit is an ancestor of HEAD
 * (it holds merge resolutions and reverts by construction), else the whole lane (rewrittenLane).
 * @param {object} git the trusted reader
 * @param {{base: string, reviewed: string, head: string}} shas full shas: where the lane starts (an ancestor of HEAD; the CLI checks
 *   both), the commit the last review read, and the commit HEAD is at
 * @returns {{range: string, files: object[], reading: string[]}} `reading`: what to read first on a rewritten lane (ready sentences with
 *   the commands, then places), else empty
 * @throws {UsageError} for a reviewed sha with no lane commit before it (the lane's classes could not be read), and for an empty delta
 *   (with nothing to read a round would pass unreviewed)
 */
export function readDelta(git, { base, reviewed: reviewedSha, head }) {
  // With no lane commit between the base and the reviewed sha the tool cannot see the lane the fix belongs to: its classes would be lost.
  if (git.text(['rev-list', '--count', `${base}..${reviewedSha}`]) === '0') throw new UsageError(`no lane commit lies between the base ${base} and the reviewed sha ${reviewedSha}: a first review reads the whole range, never a delta; for work on the base branch itself pass --base <the full sha where the work started>`);
  const range = `${reviewedSha}..HEAD`;
  const linear = git.flag(['merge-base', '--is-ancestor', reviewedSha, head]);
  const delta = linear ? { range, files: readRange(git, `${reviewedSha}..${head}`), reading: [] } : rewrittenLane(git, { base, reviewed: reviewedSha, head });
  if (delta.files.length === 0) throw new UsageError(`nothing to review: ${delta.range} holds no changed file; check the shas (--delta takes the commit the last review read, from the lead's own record)`);
  return delta;
}

const nameDefinedIn = (text) => {
  const match = FUNCTION_DEFINITION.exec(text);
  return match?.[1] ?? match?.[2] ?? match?.[3];
};

/** Names of the changed functions: defined on an added line, or the function a hunk sits in (its `@@` header), no duplicates. */
export function functionNames(files) {
  const names = new Set();
  for (const file of files) {
    for (const text of [...file.added.map((added) => added.text), ...file.hunkHeads]) {
      const name = nameDefinedIn(text);
      if (name !== undefined && name.length >= MIN_NAME_LENGTH) names.add(name);
    }
  }
  return [...names];
}

/**
 * Names a removed line defines: what the delta removes, renames or gives a new value (a function, a constant, a default). Their
 * users elsewhere are what such a fix can break without touching them.
 */
export function redefinedNames(files) {
  const names = files.flatMap((file) => file.removed.map(({ text }) => NAME_DEFINITION.exec(text)?.[1]));
  return [...new Set(names)].filter((name) => name !== undefined && name.length >= MIN_NAME_LENGTH);
}

/** Names called (not as a method) on the added lines that are not themselves changed here: the callees to read. */
function calleeNames(files, changedNames) {
  const names = new Set();
  for (const file of files) {
    for (const { text } of file.added) {
      for (const [, name] of text.matchAll(CALL)) {
        if (name.length >= MIN_NAME_LENGTH && !NOT_A_FUNCTION.has(name) && !changedNames.includes(name)) names.add(name);
      }
    }
  }
  return [...names].slice(0, MAX_READING);
}

/**
 * `file:line` of the rows `git grep` finds for `name` (all uses, or only its definitions) in the tree of the commit `head`. The lane's
 * working tree is never searched: an uncommitted edit there could add or hide a caller. Each row starts `<head>:`, which is cut off.
 */
function placesOf(git, head, name, onlyDefinitions) {
  const { status, stdout, stderr } = git.run(['grep', '-n', '-w', '-F', '-I', '-e', name, head, '--']);
  if (status > GREP_NO_MATCH) throw new Error(`git grep failed: ${stderr.split('\n')[0]}`);
  const prefix = `${head}:`;
  return stdout.toString('utf8').split('\n').filter((row) => row.startsWith(prefix)).map((row) => /^(.+?):(\d+):(.*)$/.exec(row.slice(prefix.length)))
    .filter((m) => m !== null && (!onlyDefinitions || nameDefinedIn(m[3]) === name))
    .map((m) => placeText(m[1], Number(m[2])));
}

/** `path:line` of the first changed line of each file (a file with no hunk: its path), at most MAX_READING. */
const changedPlaces = (files) => files.slice(0, MAX_READING).map((file) => {
  const line = (file.added[0] ?? file.removed[0])?.line;
  return placeText(file.path, line ?? 0);
});

/**
 * `file:line` of other uses of the changed functions and of the names the delta removes, renames or redefines (callers and users), and of the
 * definitions of the functions the changed lines call (callees); at most MAX_READING, callers spread over the names, callees keeping
 * up to half the room. Never empty for a delta that changes a file: with no caller or callee to name it lists the changed files.
 * `head`: the full sha of the commit whose tree is searched.
 */
export function requiredReadingFor(git, files, head) {
  const names = [...new Set([...functionNames(files), ...redefinedNames(files)])];
  const callees = calleeNames(files, names).flatMap((name) => placesOf(git, head, name, true));
  const changed = new Set(files.flatMap((file) => file.added.map((added) => placeText(file.path, added.line))));
  const calleePlaces = [...new Set(callees)].filter((place) => !changed.has(place)).slice(0, MAX_READING / 2);
  const perName = Math.max(1, Math.floor((MAX_READING - calleePlaces.length) / Math.max(1, names.length)));
  const callers = names.flatMap((name) => placesOf(git, head, name, false).filter((place) => !changed.has(place)).slice(0, perName));
  const reading = [...new Set([...callers, ...calleePlaces])].slice(0, MAX_READING);
  return reading.length > 0 ? reading : changedPlaces(files);
}
