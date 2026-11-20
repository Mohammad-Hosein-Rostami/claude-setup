// Purpose: read the changed files and lines of a range (or of a delta round) from git for review-tier.
// Exports: MAX_READING, parsePatch(text), baseOf(top, requested) -> sha, checkRange(top, range), readRange(top, range),
//   readDelta(top, base, reviewedRef), newFileReader(top, rev), functionNames(files), redefinedNames(files), requiredReadingFor(top, files).
// Invariants: git runs through git-tidy's runGit (no shell, no repository from the environment). A range or sha that starts
//   with `-` is refused, so it can never be read as an option. Patches are read with fixed flags (PATCH_FLAGS), so the repository's
//   own diff config and attributes cannot change what is read; the CLI switches replace refs off for every git call. Only paths and line numbers leave this module through the
//   report; line texts stay in memory for the class tests. Required reading and the patch-list range are written with names as data
//   (lib/brief-data.mjs): they go into briefs as they are.
import { UsageError, gitFlag, gitText, runGit } from '../../git-tidy/lib/git.mjs';
import { asData, placeText } from './brief-data.mjs';

export const MAX_READING = 20; // callers and callees listed as required reading
const MAX_WHOLE_FILE_CHARS = 1 << 20;
const MIN_NAME_LENGTH = 3;
const BASE_FALLBACKS = ['main', 'master', 'develop'];
const BRANCH_REFS = 'refs/heads/';
const FULL_SHA = /^[0-9a-f]{40}$/;
// What every patch is printed with, whatever the repository's own config and attributes say (security S6 of lane r7-delta: the fix's writer
// controls both, and neither shows in a diff): --text reads a file marked `-diff` or `binary` in .git/info/attributes as the text it is,
// no external diff or textconv runs, and the prefixes are fixed (diff.noprefix and diff.mnemonicPrefix would change the `+++ b/path` lines).
const PATCH_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--text', '-M', '--src-prefix=a/', '--dst-prefix=b/'];
const QUOTE_PATH_OFF = ['-c', 'core.quotePath=false'];
const DIFF_FLAGS = [...QUOTE_PATH_OFF, 'diff', '-U0', ...PATCH_FLAGS];
// A patch key is made with three context lines, pinned twice: `diff.context` 0 in the repo config would make a moved line the same patch again.
const KEY_CONTEXT_LINES = 3;
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
 * The sha of a base the caller or the fallback list names, or null. A name is read only as the local branch `refs/heads/<name>`, the ref
 * git-tidy lands on: a tag, `refs/<name>` or a file `$GIT_DIR/<name>` of the same name, which git's short-name lookup would take first,
 * is never the base (security B3 of lane r7-delta: one such ref moved the lane start and made a fix round lighter). A full sha is itself.
 */
function shaOfBase(top, name) {
  const args = FULL_SHA.test(name) ? ['rev-parse', '--verify', '--quiet', `${name}^{commit}`] : ['show-ref', '--verify', '--hash', `${BRANCH_REFS}${name}`];
  const { status, stdout } = runGit(top, args);
  return status === 0 ? stdout.trim() : null;
}

/**
 * Where the lane starts: `--base` when given, else the one of main, master, develop that exists as a local branch. It is resolved
 * once, and every range of the run is built from the sha, so no ref made later or elsewhere can move it.
 * @param {string} top the repository's top folder
 * @param {string | null} requested what `--base` got: a local branch name or a full 40-character sha
 * @returns {string} the base's full sha
 * @throws {UsageError} for a base that is no local branch and no full sha, for no fallback branch, and for more than one
 */
export function baseOf(top, requested) {
  if (requested) {
    const sha = shaOfBase(top, requested);
    if (sha === null) throw new UsageError(`unknown base ${asData(requested)}: --base takes a local branch (read as refs/heads/<name>, never a tag or another ref of that name) or a full 40-character sha`);
    return sha;
  }
  const found = BASE_FALLBACKS.filter((name) => shaOfBase(top, name) !== null);
  if (found.length === 0) throw new UsageError('no base branch (main, master, develop); pass --base <branch>');
  if (found.length > 1) throw new UsageError(`more than one base branch exists here (${found.join(', ')}): name the base with --base <branch>, the one this lane lands on`);
  return shaOfBase(top, found[0]);
}

/** Splits `a..b` or `a...b` into its sides (an empty right side is HEAD); anything else is a UsageError. */
function sidesOf(range) {
  const match = /^([^\s.][^\s]*?)\.{2,3}([^\s.]*[^\s]*)?$/.exec(range);
  if (match === null || /\.{4}/.test(range)) throw new UsageError(`bad range "${range}": use <a>..<b> or <a>...<b>`);
  return [match[1], match[2] || 'HEAD'];
}

/** Checks both sides of a range name a commit; returns the right side (the tree the new files are read from). */
export function checkRange(top, range) {
  const sides = sidesOf(range);
  for (const side of sides) {
    if (side.startsWith('-') || !gitFlag(top, ['rev-parse', '--verify', '--quiet', `${side}^{commit}`])) throw new UsageError(`unknown revision "${side}" in range "${range}"`);
  }
  return sides[1];
}

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

/** The changed files of `range` (`a..b` or `a...b`). */
export function readRange(top, range) {
  const args = [range, '--'];
  // --no-renames: a pure rename lists both its paths, so a gate file renamed away is still read as changed.
  const names = namesOf(gitText(top, [...QUOTE_PATH_OFF, 'diff', '--name-only', '-z', '--no-renames', ...args]));
  return withHunklessFiles(names, parsePatch(gitText(top, [...DIFF_FLAGS, ...args])));
}

/** The whole text of `path` at `rev` (cut at 1 MiB), or null when it does not exist there. */
export function newFileReader(top, rev) {
  return (path) => {
    const { status, stdout } = runGit(top, ['show', `${rev}:${path}`]);
    return status === 0 ? stdout.slice(0, MAX_WHOLE_FILE_CHARS) : null;
  };
}

const showPatch = (top, commit) => gitText(top, [...QUOTE_PATH_OFF, 'show', '-U0', '--format=', ...PATCH_FLAGS, commit]);

/**
 * A fingerprint of one commit's patch: `git patch-id --verbatim` of its diff with context lines (as git-tidy's copy proof), so the same
 * added line at another place in the file is another patch. Line numbers, parents and the message do not count; a rebase that changes
 * the lines around a hunk makes the patch fresh, which only adds to what a delta round reads.
 */
function patchKey(top, commit) {
  const patch = gitText(top, [...QUOTE_PATH_OFF, '-c', `diff.context=${KEY_CONTEXT_LINES}`, 'show', `-U${KEY_CONTEXT_LINES}`, '--inter-hunk-context=0', '--format=', ...PATCH_FLAGS, commit]);
  const { status, stdout, stderr } = runGit(top, ['patch-id', '--verbatim'], `${patch}\n`);
  if (status !== 0) throw new Error(`git patch-id failed for ${commit}: ${stderr.split('\n')[0]}`);
  return stdout.split(' ')[0].trim();
}

const commitsOf = (top, range) => gitText(top, ['rev-list', '--reverse', '--no-merges', range]).split('\n').filter((sha) => sha !== '');

/** The lane commits whose patch the reviewed set does not hold (a rebased lane, where `reviewedSha` is no ancestor of HEAD). */
function freshPatches(top, base, reviewedSha) {
  const reviewed = new Set(commitsOf(top, `${base}..${reviewedSha}`).map((commit) => patchKey(top, commit)));
  const fresh = commitsOf(top, `${base}..HEAD`).filter((commit) => !reviewed.has(patchKey(top, commit)));
  const text = fresh.map((commit) => showPatch(top, commit)).join('\n');
  const names = fresh.flatMap((commit) => namesOf(gitText(top, [...QUOTE_PATH_OFF, 'show', '--name-only', '-z', '--no-renames', '--format=', commit])));
  return { range: `patches ${fresh.map((commit) => commit.slice(0, 8)).join(',') || 'none'} of ${base}..HEAD`, files: withHunklessFiles(names, parsePatch(text)) };
}

/**
 * The delta since the reviewed commit: its range when that commit is an ancestor of HEAD; otherwise (a rebased lane) only the lane
 * commits whose patch the reviewed set does not hold. The range names the resolved full sha, never the text the caller gave.
 * @param {string} base the full sha of the lane's base (baseOf)
 * @param {string} reviewedRef what `--delta` got: any name of the commit the last review read
 * @returns {{range: string, files: object[], reviewedSha: string}}
 * @throws {UsageError} for an unknown commit, a reviewed sha with no lane commit before it (the lane's classes could not be read), and an
 *   empty delta (with nothing to read a round would pass unreviewed)
 */
export function readDelta(top, base, reviewedRef) {
  if (reviewedRef.startsWith('-') || !gitFlag(top, ['rev-parse', '--verify', '--quiet', `${reviewedRef}^{commit}`])) throw new UsageError(`unknown sha "${reviewedRef}" for --delta`);
  const reviewedSha = gitText(top, ['rev-parse', '--verify', `${reviewedRef}^{commit}`]);
  // With no lane commit between the base and the reviewed sha the tool cannot see the lane the fix belongs to: its classes would be lost.
  if (commitsOf(top, `${base}..${reviewedSha}`).length === 0) throw new UsageError(`no lane commit lies between the base ${base} and the reviewed sha ${reviewedSha}: a first review reads the whole range, never a delta; for work on the base branch itself pass --base <the full sha where the work started>`);
  const range = `${reviewedSha}..HEAD`;
  const delta = gitFlag(top, ['merge-base', '--is-ancestor', reviewedSha, 'HEAD']) ? { range, files: readRange(top, range) } : freshPatches(top, base, reviewedSha);
  if (delta.files.length === 0) throw new UsageError(`nothing to review: ${delta.range} holds no changed file; check the range (--delta takes the sha the last review read, from the lead's own record)`);
  return { ...delta, reviewedSha };
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
