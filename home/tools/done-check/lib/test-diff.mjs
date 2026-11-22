// The weakened-test scan: the one check that cannot be fooled by making a gate easier instead of the code better (design section 3.2,
// kind `tests-weakened`). It compares the base commit with the worktree and reports what makes the other checks weaker.
// Exports: weakenedTests(scope) -> Failure[] (kind `tests-weakened`), MAX_SCANNED_FILES.
// What counts (each one is a Failure with id `<file>|<reason>`, a one-line text, and the file; the text names what was seen, so the agent
// knows what to undo: `tests/a.test.mjs:5: test.skip added`, `src/x.ts:1: @ts-ignore added (a lint or type suppression)`,
// `tests/a.test.mjs: case deleted (3 test cases before, 2 now)`):
//   - a deleted test file; fewer test cases or fewer assertions in a changed test file;
//   - more skip, only, todo, `xit`, `xdescribe` or `{ skip: ... }` in a test file than at the base;
//   - more lint, type or coverage suppression comments than at the base (eslint-disable, ts-ignore, ts-expect-error, ts-nocheck,
//     istanbul, c8 or v8 ignore) in a code file;
//   - a package.json whose `test`, `typecheck`, `type-check` or `lint` script changed or was removed;
//   - an eslint, vitest or jest config that changed or was deleted (a change of spaces alone is not a change);
//   - a tsconfig strictness flag that is `false` now and was `true` at the base.
// Not counted: a new file, a stronger change, a removed skip, a suppression that was already there (counts are compared, not lines),
//   a change in another script, a dependency or a formatting change. A changed `strict` nested in an `extends` needs a deep parse and is not seen.
// Invariants: no git or no 40-hex base gives []. A file is read from the base with `git cat-file blob` (hardened git) and from the
//   worktree with lib/plain-file.mjs (never through a link or a FIFO); a path that is absolute or has `..` is skipped. A test, config or
//   package file that cannot be read is itself reported (fail closed); an ordinary code file that cannot be read is skipped. At most
//   MAX_SCANNED_FILES files are scanned (tests and configs first), so a huge change cannot outlast the caller's deadline. Failure
//   texts are one line and cut to MAX_TEXT_CHARS (a file name is untrusted text).
import { join } from 'node:path';
import { NOT_PLAIN_FILE, readPlainFile } from '../../../hooks/lib/plain-file.mjs';
import { runGit } from '../../../hooks/lib/gated-folder.mjs';

/** Most changed files one scan reads. */
export const MAX_SCANNED_FILES = 500;

const KIND = 'tests-weakened';
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 200;
const COMMIT_HASH = /^[0-9a-f]{40}$/;
const GUARDED_SCRIPTS = ['test', 'typecheck', 'type-check', 'lint'];
const STRICT_FLAGS = ['strict', 'noImplicitAny', 'strictNullChecks', 'strictFunctionTypes', 'strictBindCallApply', 'strictPropertyInitialization', 'noImplicitThis', 'useUnknownInCatchVariables', 'alwaysStrict'];

const TEST_FILE = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[^/]+$/;
const CODE_FILE = /\.(m?[jt]sx?|cjs|cts|vue|svelte)$/;
const CHECK_CONFIG = /(^|\/)(eslint\.config\.[^/]+|\.eslintrc[^/]*|vitest\.(config|workspace)\.[^/]+|jest\.config\.[^/]+)$/;
const TSCONFIG = /(^|\/)[jt]sconfig[^/]*\.json$/;
const PACKAGE_JSON = /(^|\/)package\.json$/;

// A test case that runs is `test(`, `it(` or one of their modifiers (`test.each(`), not a skipped one (`it.skip(`, `it.todo(`): taking a skip
// away is not fewer cases. An assertion is `expect(` or `assert(` and its methods.
const CASES = /(?<![\w.$])(test|it)(?!\.(skip|skipIf|todo|fixme)\b)(\.\w+)*\s*\(/g;
const ASSERTIONS = /(?<![\w.$])(expect|assert)(\.\w+)*\s*\(/g;
const SKIPS = /(?<![\w.$])(test|it|describe|suite|context)\.(skip|skipIf|only|todo|fixme)\b|(?<![\w.$])x(it|describe|test)\s*\(|\{[^{}]*\b(skip|todo|only)\s*:\s*(true|['"`])/g;
// A suppression is a directive inside a comment: the comment opener in front keeps this file's own patterns from counting as one.
const SUPPRESSIONS = /(?:\/\/|\/\*|\*)\s*(eslint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck|istanbul ignore|c8 ignore|v8 ignore)/g;

const countOf = (text, pattern) => (text.match(pattern) ?? []).length;
const oneLine = (text) => text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').slice(0, MAX_TEXT_CHARS);
const withoutSpaces = (text) => text.replace(/\s+/g, '');
const isSafeRelative = (path) => typeof path === 'string' && path !== '' && !path.startsWith('/') && !/^[a-z]:/i.test(path) && !path.split('/').includes('..');

/** One weakening; `line` (1-based, when known) makes the text start `file:line:` like a compiler message. */
const failure = (file, reason, text, line) => ({ kind: KIND, id: `${file}|${reason}`, file, text: oneLine(`${file}${line ? `:${line}` : ''}: ${text}`) });

/**
 * The lines of `after` that carry a match of `pattern` and have no equal line with a match in `before` (so a directive that moved is not
 * new), as `{ directive, line }`. Empty when the count rose only through a match the line scan cannot see (one that spans lines).
 * @param {string} before text at the base ('' for a new file)
 * @param {string} after text now
 * @param {RegExp} pattern a global pattern
 * @param {number} group which group of a match names the directive (0 = the whole match)
 */
function addedDirectives(before, after, pattern, group) {
  const directiveOf = (line) => { const match = line.matchAll(pattern).next().value; return match ? match[group].replace(/\s*\($/, '').trim() : null; };
  const known = new Map();
  for (const line of before.split('\n')) if (directiveOf(line) !== null) known.set(line.trim(), (known.get(line.trim()) ?? 0) + 1);
  const added = [];
  after.split('\n').forEach((line, index) => {
    const directive = directiveOf(line);
    if (directive === null) return;
    const left = known.get(line.trim()) ?? 0;
    if (left > 0) known.set(line.trim(), left - 1);
    else added.push({ directive, line: index + 1 });
  });
  return added;
}

/** The failure for a directive that was added: names the first one seen with its line, and how many more there are. */
function addedFailure(file, reason, before, after, { pattern, group, fallback, note = '' }) {
  const [first, ...more] = addedDirectives(before, after, pattern, group);
  if (!first) return failure(file, reason, fallback);
  return failure(file, reason, `${first.directive} added${note}${more.length > 0 ? ` (and ${more.length} more)` : ''}`, first.line);
}

/** The file at the base: its text, null when the base has no such file, or `unreadable` when git could not answer. */
function baseText(top, base, file) {
  const result = runGit(top, ['cat-file', 'blob', `${base}:${file}`]);
  if (result.status === 0) return result.stdout;
  return result.error ? 'unreadable' : null; // a missing file exits 128; a killed or overflowing git has an error
}

/** The file in the worktree: its text, null when it is gone, or `unreadable` for a link, a FIFO, a folder or a file over the cap. */
function headText(top, file) {
  try {
    return readPlainFile(join(top, file), MAX_FILE_BYTES);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error?.code === 'ELOOP' || error?.code === NOT_PLAIN_FILE || error?.code === 'EACCES') return 'unreadable';
    throw error;
  }
}

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

function weakenedPackage(file, before, after) {
  const was = parseJson(before)?.scripts;
  if (was === undefined || was === null) return [];
  const now = parseJson(after);
  if (now === null) return [failure(file, 'package-unreadable', 'package.json is no longer valid JSON, so its scripts cannot be compared')];
  return GUARDED_SCRIPTS.filter((name) => typeof was[name] === 'string' && now.scripts?.[name] !== was[name])
    .map((name) => failure(file, `script-${name}`, now.scripts?.[name] === undefined ? `the ${name} script was removed` : `the ${name} script was changed`));
}

function weakenedTsconfig(file, before, after) {
  const valueOf = (text, flag) => new RegExp(`"${flag}"\\s*:\\s*(true|false)`).exec(text)?.[1];
  return STRICT_FLAGS.filter((flag) => valueOf(before, flag) === 'true' && valueOf(after, flag) === 'false')
    .map((flag) => failure(file, `tsconfig-${flag}`, `${flag} was turned off`));
}

function weakenedTestFile(file, before, after) {
  const found = [];
  const cases = [countOf(before, CASES), countOf(after, CASES)];
  const assertions = [countOf(before, ASSERTIONS), countOf(after, ASSERTIONS)];
  if (cases[1] < cases[0]) found.push(failure(file, 'fewer-cases', `case deleted (${cases[0]} test cases before, ${cases[1]} now)`));
  if (assertions[1] < assertions[0]) found.push(failure(file, 'fewer-assertions', `assertion deleted (${assertions[0]} assertions before, ${assertions[1]} now)`));
  if (countOf(after, SKIPS) > countOf(before, SKIPS)) found.push(addedFailure(file, 'added-skip', before, after, { pattern: SKIPS, group: 0, fallback: 'a skip, only or todo was added' }));
  return found;
}

const suppressionAdded = (file, before, after) => addedFailure(file, 'added-suppression', before, after, { pattern: SUPPRESSIONS, group: 1, fallback: 'a lint or type suppression was added', note: ' (a lint or type suppression)' });

/** What one changed file weakens, given its text at the base (null when new) and now (null when deleted). */
function weakenedFile(file, before, after) {
  const mustRead = TEST_FILE.test(file) || CHECK_CONFIG.test(file) || PACKAGE_JSON.test(file) || TSCONFIG.test(file);
  if (before === 'unreadable' || after === 'unreadable') return mustRead ? [failure(file, 'unreadable', 'cannot be read, so it cannot be compared with the base')] : [];
  if (before === null) return after !== null && CODE_FILE.test(file) && countOf(after, SUPPRESSIONS) > 0 ? [suppressionAdded(file, '', after)] : [];
  if (after === null) {
    if (TEST_FILE.test(file)) return [failure(file, 'deleted', 'test file deleted')];
    return CHECK_CONFIG.test(file) ? [failure(file, 'config-deleted', 'a lint or test config was deleted')] : [];
  }
  const found = [];
  if (TEST_FILE.test(file)) found.push(...weakenedTestFile(file, before, after));
  if (CODE_FILE.test(file) && countOf(after, SUPPRESSIONS) > countOf(before, SUPPRESSIONS)) found.push(suppressionAdded(file, before, after));
  if (PACKAGE_JSON.test(file)) found.push(...weakenedPackage(file, before, after));
  if (CHECK_CONFIG.test(file) && withoutSpaces(before) !== withoutSpaces(after)) found.push(failure(file, 'config-changed', 'a lint or test config was changed'));
  if (TSCONFIG.test(file)) found.push(...weakenedTsconfig(file, before, after));
  return found;
}

const priority = (file) => (TEST_FILE.test(file) || CHECK_CONFIG.test(file) || PACKAGE_JSON.test(file) || TSCONFIG.test(file) ? 0 : 1);

/**
 * Finds what a change does to the tests and checks themselves.
 * @param {import('./contract.mjs').Scope} scope the changed files (`files` and `wide`) and the base commit; a deleted file is listed too
 * @returns {import('./contract.mjs').Failure[]} one failure per weakening, kind `tests-weakened`; [] for no git, no base, or no weakening
 */
export function weakenedTests(scope) {
  if (!scope.git || !scope.top || !COMMIT_HASH.test(scope.base ?? '')) return [];
  const files = [...new Set([...scope.files, ...scope.wide])].filter(isSafeRelative)
    .sort((a, b) => priority(a) - priority(b)).slice(0, MAX_SCANNED_FILES);
  return files.flatMap((file) => weakenedFile(file, baseText(scope.top, scope.base, file), headText(scope.top, file)));
}
