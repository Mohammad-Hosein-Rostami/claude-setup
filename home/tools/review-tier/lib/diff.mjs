// Purpose: read the changed files and lines of a range (or of a delta round) from git for review-tier.
// Exports: MAX_READING, parsePatch(text), readRange(top, range),
//   readDelta(top, base, reviewedSha), newFileReader(top, rev), functionNames(files), redefinedNames(files), requiredReadingFor(top, files).
// The base and the sides of a range are resolved in lib/revisions.mjs; this module reads ranges of shas.
// Invariants: git runs through git-tidy's runGit (no shell, no repository from the environment). Every commit arrives here as a full
//   sha or HEAD. Only tree diffs between those commits are read: no patch of one commit is compared with another's. Patches are read with
//   fixed flags (PATCH_FLAGS), so the repository's own diff config and attributes cannot change what is read; the CLI refuses grafts,
//   replace refs and a shallow history before anything is read. Only paths and line numbers leave this module through the
//   report; line texts stay in memory for the class tests. Required reading is written with names as data
//   (lib/brief-data.mjs): they go into briefs as they are.
import { UsageError, gitFlag, gitText, runGit } from '../../git-tidy/lib/git.mjs';
import { placeText } from './brief-data.mjs';

export const MAX_READING = 20; // callers and callees listed as required reading
const MAX_WHOLE_FILE_CHARS = 1 << 20;
const MIN_NAME_LENGTH = 3;
// What every patch is printed with, whatever the repository's own config and attributes say (security S6 of lane r7-delta: the fix's writer
// controls both, and neither shows in a diff): --text reads a file marked `-diff` or `binary` in .git/info/attributes as the text it is,
// no external diff or textconv runs, and the prefixes are fixed (diff.noprefix and diff.mnemonicPrefix would change the `+++ b/path` lines).
const PATCH_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--text', '-M', '--src-prefix=a/', '--dst-prefix=b/'];
const QUOTE_PATH_OFF = ['-c', 'core.quotePath=false'];
// --literal-pathspecs: a lane file named like a pathspec (`*.mjs`, `:(top)x`) is that one file, never a pattern.
const DIFF_FLAGS = ['--literal-pathspecs', ...QUOTE_PATH_OFF, 'diff', '-U0', ...PATCH_FLAGS];
const NAME_FLAGS = ['--literal-pathspecs', ...QUOTE_PATH_OFF, 'diff', '--name-only', '-z', '--no-renames'];
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

/** The paths of a `--name-only -z` listing: NUL-separated, so no path is quoted or cut at a line break. */
const namesOf = (listing) => listing.split('\0').filter((name) => name !== '');

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
const diffNames = (top, args) => namesOf(gitText(top, [...NAME_FLAGS, ...args]));

/** The changed files of one tree diff. `args`: a range (`a..b`, `a...b`) or two commits, then `--` and, when given, the only paths to read. */
const readDiff = (top, args) => withHunklessFiles(diffNames(top, args), parsePatch(gitText(top, [...DIFF_FLAGS, ...args])));

/** The changed files of `range` (`a..b` or `a...b`). */
export const readRange = (top, range) => readDiff(top, [range, '--']);

/** The whole text of `path` at `rev` (cut at 1 MiB), or null when it does not exist there. */
export function newFileReader(top, rev) {
  return (path) => {
    const { status, stdout } = runGit(top, ['show', `${rev}:${path}`]);
    return status === 0 ? stdout.slice(0, MAX_WHOLE_FILE_CHARS) : null;
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
 */
function rewrittenLane(top, base, reviewedSha) {
  const laneRange = `${base}..HEAD`;
  const lanePaths = [...new Set([...diffNames(top, [laneRange, '--']), ...diffNames(top, [`${base}...${reviewedSha}`, '--'])])];
  const since = lanePaths.length === 0 ? [] : readDiff(top, [reviewedSha, 'HEAD', '--', ...lanePaths]);
  return {
    range: `${laneRange} (rewritten lane: the reviewed commit ${reviewedSha} is no ancestor of HEAD, so the whole lane is read)`,
    files: mergedFiles(readRange(top, laneRange), since),
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
 * @param {string} base the full sha the lane starts from (an ancestor of HEAD; the CLI checks both)
 * @param {string} reviewedSha the full sha the last review read
 * @returns {{range: string, files: object[], reading: string[]}} `reading`: what to read first on a rewritten lane (ready sentences with
 *   the commands, then places), else empty
 * @throws {UsageError} for a reviewed sha with no lane commit before it (the lane's classes could not be read), and for an empty delta
 *   (with nothing to read a round would pass unreviewed)
 */
export function readDelta(top, base, reviewedSha) {
  // With no lane commit between the base and the reviewed sha the tool cannot see the lane the fix belongs to: its classes would be lost.
  if (gitText(top, ['rev-list', '--count', `${base}..${reviewedSha}`]) === '0') throw new UsageError(`no lane commit lies between the base ${base} and the reviewed sha ${reviewedSha}: a first review reads the whole range, never a delta; for work on the base branch itself pass --base <the full sha where the work started>`);
  const range = `${reviewedSha}..HEAD`;
  const delta = gitFlag(top, ['merge-base', '--is-ancestor', reviewedSha, 'HEAD']) ? { range, files: readRange(top, range), reading: [] } : rewrittenLane(top, base, reviewedSha);
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

/** `file:line` of the rows `git grep` finds for `name` (all uses, or only its definitions). */
function placesOf(top, name, onlyDefinitions) {
  const { stdout } = runGit(top, ['grep', '-n', '-w', '-F', '-I', '-e', name, '--']);
  return stdout.split('\n').map((row) => /^(.+?):(\d+):(.*)$/.exec(row))
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
 */
export function requiredReadingFor(top, files) {
  const names = [...new Set([...functionNames(files), ...redefinedNames(files)])];
  const callees = calleeNames(files, names).flatMap((name) => placesOf(top, name, true));
  const changed = new Set(files.flatMap((file) => file.added.map((added) => placeText(file.path, added.line))));
  const calleePlaces = [...new Set(callees)].filter((place) => !changed.has(place)).slice(0, MAX_READING / 2);
  const perName = Math.max(1, Math.floor((MAX_READING - calleePlaces.length) / Math.max(1, names.length)));
  const callers = names.flatMap((name) => placesOf(top, name, false).filter((place) => !changed.has(place)).slice(0, perName));
  const reading = [...new Set([...callers, ...calleePlaces])].slice(0, MAX_READING);
  return reading.length > 0 ? reading : changedPlaces(files);
}
