// Purpose: read the changed files and lines of a range (or of a delta round) from git for review-tier.
// Exports: MAX_READING, parsePatch(text), baseOf(top, requested), checkRange(top, range), readRange(top, range),
//   readDelta(top, base, reviewedSha), newFileReader(top, rev), functionNames(files), requiredReadingFor(top, files).
// Invariants: git runs through git-tidy's runGit (no shell, no repository from the environment). A range or sha that starts
//   with `-` is refused, so it can never be read as an option. Only paths and line numbers leave this module through the
//   report; line texts stay in memory for the class tests.
import { createHash } from 'node:crypto';
import { UsageError, gitFlag, gitText, runGit } from '../../git-tidy/lib/git.mjs';

export const MAX_READING = 20; // callers and callees listed as required reading
const MAX_WHOLE_FILE_CHARS = 1 << 20;
const MIN_NAME_LENGTH = 3;
const BASE_FALLBACKS = ['main', 'master', 'develop'];
// Fixed prefixes: diff.noprefix and diff.mnemonicPrefix would change the `+++ b/path` lines parsePatch cuts.
const PATH_PREFIXES = ['--src-prefix=a/', '--dst-prefix=b/'];
const DIFF_FLAGS = ['-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '-M', ...PATH_PREFIXES];
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/;
const CALL = /(?<![.\w$])([A-Za-z_$][\w$]*)\(/g;
const NOT_A_FUNCTION = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'await', 'new', 'import', 'require', 'super']);
const FUNCTION_DEFINITION = /\bfunction\s*\*?\s+([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|\b(?:def|func|fn)\s+([A-Za-z_$][\w$]*)/;

/** The first of main, master, develop that exists (or the requested base); a UsageError when none does. */
export function baseOf(top, requested) {
  const candidates = requested ? [requested] : BASE_FALLBACKS;
  const found = candidates.find((name) => !name.startsWith('-') && gitFlag(top, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`]));
  if (found === undefined) throw new UsageError(requested ? `unknown base ${requested}` : 'no base branch (main, master, develop); pass --base <branch>');
  return found;
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
    if (!inHunk && line.startsWith('+++ ')) { if (line !== '+++ /dev/null') current = entry(line.slice(6)); continue; }
    if (!inHunk && line.startsWith('--- ')) { if (line !== '--- /dev/null') current = entry(line.slice(6)); continue; }
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

/** Every changed path of a diff, also one with no hunk (a pure rename, a binary file, a mode change). */
function withHunklessFiles(top, args, files) {
  const names = gitText(top, [...DIFF_FLAGS.slice(0, 2), 'diff', '--name-only', '-M', ...args]).split('\n').filter((name) => name !== '');
  const known = new Set(files.map((file) => file.path));
  return [...files, ...names.filter((name) => !known.has(name)).map((path) => ({ path, added: [], removed: [], hunkHeads: [] }))];
}

/** The changed files of `range` (`a..b` or `a...b`). */
export function readRange(top, range) {
  const args = [range, '--'];
  return withHunklessFiles(top, args, parsePatch(gitText(top, [...DIFF_FLAGS, ...args])));
}

/** The whole text of `path` at `rev` (cut at 1 MiB), or null when it does not exist there. */
export function newFileReader(top, rev) {
  return (path) => {
    const { status, stdout } = runGit(top, ['show', `${rev}:${path}`]);
    return status === 0 ? stdout.slice(0, MAX_WHOLE_FILE_CHARS) : null;
  };
}

const showPatch = (top, commit) => gitText(top, [...DIFF_FLAGS.slice(0, 2), 'show', '-U0', '--format=', '--no-color', '-M', ...PATH_PREFIXES, commit]);

/** A fingerprint of one commit's patch (its paths and changed lines, not its line numbers, parents or message). */
function patchKey(top, commit) {
  const text = showPatch(top, commit);
  const body = text.split('\n').filter((line) => /^(\+|-|diff --git)/.test(line)).join('\n');
  return createHash('sha1').update(body).digest('hex');
}

const commitsOf = (top, range) => gitText(top, ['rev-list', '--reverse', '--no-merges', range]).split('\n').filter((sha) => sha !== '');

/**
 * The delta since `reviewedSha`: its range when the sha is an ancestor of HEAD; otherwise (a rebased lane) only the lane
 * commits whose patch the reviewed set does not hold.
 * @returns {{range: string, files: object[]}}
 */
export function readDelta(top, base, reviewedSha) {
  if (reviewedSha.startsWith('-') || !gitFlag(top, ['rev-parse', '--verify', '--quiet', `${reviewedSha}^{commit}`])) throw new UsageError(`unknown sha "${reviewedSha}" for --delta`);
  if (gitFlag(top, ['merge-base', '--is-ancestor', reviewedSha, 'HEAD'])) {
    const range = `${reviewedSha}..HEAD`;
    return { range, files: readRange(top, range) };
  }
  const reviewed = new Set(commitsOf(top, `${base}..${reviewedSha}`).map((commit) => patchKey(top, commit)));
  const fresh = commitsOf(top, `${base}..HEAD`).filter((commit) => !reviewed.has(patchKey(top, commit)));
  const text = fresh.map((commit) => showPatch(top, commit)).join('\n');
  return { range: `patches ${fresh.map((commit) => commit.slice(0, 8)).join(',') || 'none'} of ${base}..HEAD`, files: parsePatch(text) };
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
    .map((m) => `${m[1]}:${m[2]}`);
}

/**
 * `file:line` of other uses of the changed functions (callers) and of the definitions of the functions the changed lines
 * call (callees); at most MAX_READING, callers spread over the names, callees keeping up to half the room.
 */
export function requiredReadingFor(top, files) {
  const names = functionNames(files);
  const callees = calleeNames(files, names).flatMap((name) => placesOf(top, name, true));
  const changed = new Set(files.flatMap((file) => file.added.map((added) => `${file.path}:${added.line}`)));
  const calleePlaces = [...new Set(callees)].filter((place) => !changed.has(place)).slice(0, MAX_READING / 2);
  const perName = Math.max(1, Math.floor((MAX_READING - calleePlaces.length) / Math.max(1, names.length)));
  const callers = names.flatMap((name) => placesOf(top, name, false).filter((place) => !changed.has(place)).slice(0, perName));
  return [...new Set([...callers, ...calleePlaces])].slice(0, MAX_READING);
}
