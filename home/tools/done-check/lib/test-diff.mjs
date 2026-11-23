// The weakened-test scan: the one check that cannot be fooled by making a gate easier instead of the code better (design section 3.2,
// kind `tests-weakened`). It compares the base commit with the worktree and reports what makes the other checks weaker.
// Exports: weakenedTests(scope) -> Failure[] (kind `tests-weakened`), MAX_SCANNED_FILES.
// What counts (each one is a Failure with id `<file>|<reason>`, a one-line text, and the file; the text names what was seen, so the agent
// knows what to undo: `tests/a.test.mjs:5: test.skip added`, `src/x.ts:1: @ts-ignore added (a lint or type suppression)`,
// `tests/a.test.mjs: case deleted (3 test cases before, 2 now)`):
//   - a deleted test file; fewer test cases or fewer assertions in a changed test file; a softened assertion (the always-true matchers
//     toBeDefined, toBeTruthy and toBeFalsy went up while the value-checking matchers toBe, toEqual, assert.equal and the like went down);
//   - more skip, only, todo, `xit`, `xdescribe` or `{ skip: ... }` in a test file than at the base;
//   - more lint, type or coverage suppression comments than at the base (eslint-disable, ts-ignore, ts-expect-error, ts-nocheck,
//     istanbul, c8 or v8 ignore) in a code file;
//   - a package.json whose `test`, `typecheck`, `type-check` or `lint` script changed or was removed;
//   - an eslint, vitest or jest config that changed or was deleted (a change of spaces alone is not a change);
//   - a tsconfig strictness flag that is `false` now and was `true` at the base.
//   - Go (`_test.go`): fewer Test/Benchmark/Fuzz/Example functions or `t.Run` subtests, fewer t.Error/t.Fatal/t.Fail or testify calls,
//     more t.Skip, `testing.Short()` guards or build constraint lines than at the base; a `_test.go` deleted alone.
// A test file that moved (a rename git's `-M` sees, or a new file with its exact text) is not deleted: it is scanned like an edit,
//   between its base text and its new path.
// Not counted: a test file deleted with its code (every non-test module it imported at the base is deleted too, not renamed or
//   moved: "removed with its code"; a test deleted alone, with only a fixture, or with one of its modules kept still counts; a
//   `_test.go` goes with its code when its `<name>.go` is deleted too or its package folder keeps no non-test `.go`), a new file, a stronger change, a removed skip, a
//   suppression that was already there (counts are compared, not lines),
//   a change in another script, a dependency or a formatting change. A changed `strict` nested in an `extends` needs a deep parse and is not seen.
// Invariants: no git or no 40-hex base gives []. A file is read from the base with `git cat-file blob` (hardened git) and from the
//   worktree with lib/plain-file.mjs (never through a link or a FIFO); a path that is absolute or has `..` is skipped. A test, config or
//   package file that cannot be read is itself reported (fail closed); an ordinary code file that cannot be read is skipped. At most
//   MAX_SCANNED_FILES files are scanned (tests and configs first), so a huge change cannot outlast the caller's deadline. Failure
//   texts are one line and cut to MAX_TEXT_CHARS (a file name is untrusted text).
import { readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { NOT_PLAIN_FILE, readPlainFile } from '../../../hooks/lib/plain-file.mjs';
import { runGit } from '../../../hooks/lib/gated-folder.mjs';

/** Most changed files one scan reads. */
export const MAX_SCANNED_FILES = 500;

const KIND = 'tests-weakened';
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 200;
const COMMIT_HASH = /^[0-9a-f]{40}$/;
const GIT_TIMEOUT_MS = 10_000; // the rename-detecting diff; a git that takes longer counts nothing as gone (a deleted test keeps blocking)
const GUARDED_SCRIPTS = ['test', 'typecheck', 'type-check', 'lint'];
const STRICT_FLAGS = ['strict', 'noImplicitAny', 'strictNullChecks', 'strictFunctionTypes', 'strictBindCallApply', 'strictPropertyInitialization', 'noImplicitThis', 'useUnknownInCatchVariables', 'alwaysStrict'];

const TEST_FILE = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[^/]+$|_test\.go$/;
const GO_FILE = /\.go$/;
const GO_TEST_FILE = /_test\.go$/;
const CODE_FILE = /\.(m?[jt]sx?|cjs|cts|vue|svelte)$/;
const CHECK_CONFIG = /(^|\/)(eslint\.config\.[^/]+|\.eslintrc[^/]*|vitest\.(config|workspace)\.[^/]+|jest\.config\.[^/]+)$/;
const TSCONFIG = /(^|\/)[jt]sconfig[^/]*\.json$/;
const PACKAGE_JSON = /(^|\/)package\.json$/;
// A relative module a test file loads: `from './x'`, `import('./x')`, `import './x'` or `require('../x')` (group 2 is the specifier).
// One `\s*` before the optional `(` and one inside it, so a long run of spaces is never split two ways (linear on hostile text).
const RELATIVE_IMPORTS = /(?:\bfrom|\bimport|\brequire)\s*(?:\(\s*)?(['"])(\.{1,2}\/[^'"\n]{1,300})\1/g;
const JS_EXTENSION = /\.(m?[jt]sx?|c[jt]s)$/;
const IMPORT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'];

// A test case that runs is `test(`, `it(` or one of their modifiers (`test.each(`), not a skipped one (`it.skip(`, `it.todo(`): taking a skip
// away is not fewer cases. An assertion is `expect(` or `assert(` and its methods.
const CASES = /(?<![\w.$])(test|it)(?!\.(skip|skipIf|todo|fixme)\b)(\.\w+)*\s*\(/g;
const ASSERTIONS = /(?<![\w.$])(expect|assert)(\.\w+)*\s*\(/g;
// A weak matcher passes for almost any value; a strong one checks the value. Only a swap (weak up, strong down) is a softening, so a new
// test that uses toBeDefined, or a rewrite that keeps its strong matchers, is not flagged.
const WEAK_MATCHERS = /\.(toBeDefined|toBeTruthy|toBeFalsy)\s*\(/g;
const STRONG_MATCHERS = /\.(toBe|toEqual|toStrictEqual|toMatch|toMatchObject|toContain|toHaveLength|toBeGreaterThan|toBeLessThan|toThrow|toHaveBeenCalledWith)\s*\(|(?<![\w.$])assert(?:\.strict)?\.(equal|strictEqual|deepEqual|deepStrictEqual|match|throws)\s*\(/g;
const SKIPS = /(?<![\w.$])(test|it|describe|suite|context)\.(skip|skipIf|only|todo|fixme)\b|(?<![\w.$])x(it|describe|test)\s*\(|\{[^{}]*\b(skip|todo|only)\s*:\s*(true|['"`])/g;
// A suppression is a directive inside a comment: the comment opener in front keeps this file's own patterns from counting as one.
const SUPPRESSIONS = /(?:\/\/|\/\*|\*)\s*(eslint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck|istanbul ignore|c8 ignore|v8 ignore)/g;
// Go (`_test.go`): a case is a top-level Test, Benchmark, Fuzz or Example function or a `t.Run(` subtest; an assertion is a t.Error,
// t.Fatal or t.Fail call or a testify `assert.`/`require.` call; a skip is t.Skip, a `testing.Short()` guard or a build constraint
// line (which takes the file out of `go test`). The receivers are the usual test names, so `err.Error()` is never an assertion.
const GO_CASES = /^func\s+(?:Test|Benchmark|Fuzz|Example)\w*\s*\(|(?<![\w.])(?:t|b|tb|tt)\.Run\s*\(/gm;
const GO_ASSERTIONS = /(?<![\w.])(?:t|b|f|tb|tt)\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(|(?<![\w.])(?:assert|require)\.[A-Z]\w*\s*\(/g;
const GO_SKIPS = /(?<![\w.])(?:t|b|f|tb|tt)\.(?:Skip|Skipf|SkipNow)\s*\(|(?<![\w.])testing\.Short\s*\(\s*\)|^\/\/go:build\b|^\/\/ \+build\b/gm;
const JS_TEST_PATTERNS = { cases: CASES, assertions: ASSERTIONS, skips: SKIPS, weak: WEAK_MATCHERS, strong: STRONG_MATCHERS };
const GO_TEST_PATTERNS = { cases: GO_CASES, assertions: GO_ASSERTIONS, skips: GO_SKIPS, weak: null, strong: null };

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

/** A test file's cases, assertions and skips at the base and now (Go patterns for a `.go` file); `file` is where it lives now. */
function weakenedTestFile(file, before, after) {
  const found = [];
  const patterns = GO_FILE.test(file) ? GO_TEST_PATTERNS : JS_TEST_PATTERNS;
  const cases = [countOf(before, patterns.cases), countOf(after, patterns.cases)];
  const assertions = [countOf(before, patterns.assertions), countOf(after, patterns.assertions)];
  if (cases[1] < cases[0]) found.push(failure(file, 'fewer-cases', `case deleted (${cases[0]} test cases before, ${cases[1]} now)`));
  if (assertions[1] < assertions[0]) found.push(failure(file, 'fewer-assertions', `assertion deleted (${assertions[0]} assertions before, ${assertions[1]} now)`));
  if (patterns.weak !== null) {
    const weak = [countOf(before, patterns.weak), countOf(after, patterns.weak)];
    const strong = [countOf(before, patterns.strong), countOf(after, patterns.strong)];
    if (weak[1] > weak[0] && strong[1] < strong[0]) found.push(failure(file, 'softened-assertion', `assertion softened (${strong[0]} value checks before, ${strong[1]} now; ${weak[1] - weak[0]} always-true matcher added)`));
  }
  if (countOf(after, patterns.skips) > countOf(before, patterns.skips)) found.push(addedFailure(file, 'added-skip', before, after, { pattern: patterns.skips, group: 0, fallback: 'a skip, only or todo was added' }));
  return found;
}

const suppressionAdded = (file, before, after) => addedFailure(file, 'added-suppression', before, after, { pattern: SUPPRESSIONS, group: 1, fallback: 'a lint or type suppression was added', note: ' (a lint or type suppression)' });

/** The repo-relative files a relative import specifier of `file` may name: as written, without a JS extension, with each code extension. */
function importTargets(file, specifier) {
  const target = posix.normalize(posix.join(posix.dirname(file), specifier));
  if (!isSafeRelative(target)) return [];
  const stem = target.replace(JS_EXTENSION, '');
  return [target, ...IMPORT_EXTENSIONS.flatMap((extension) => [`${stem}${extension}`, `${stem}/index${extension}`])];
}

/**
 * True when every module the deleted test file imported from the repo's code (a relative import at the base whose target is not
 * itself a test file or a fixture in a test folder) is gone with it: the test went with the code it tested. A test deleted alone,
 * with only a fixture, or while one of its modules still exists (kept, renamed or moved) is still a weakening.
 * @param {string} file the deleted test file
 * @param {string} before its text at the base
 * @param {Set<string>} gone the files this change deletes outright (see goneFiles)
 */
function removedWithItsCode(file, before, gone) {
  const modules = [...before.matchAll(RELATIVE_IMPORTS)].map((match) => importTargets(file, match[2]))
    .filter((targets) => targets.length > 0 && !TEST_FILE.test(targets[0]));
  return modules.length > 0 && modules.every((targets) => targets.some((target) => gone.has(target)));
}

/**
 * True when a deleted Go test file went with the code it tests: its own `<name>.go` is deleted outright too, or its package folder lost
 * a Go file in this change and holds no non-test `.go` file any more (the package is gone). A folder that cannot be listed keeps it a
 * weakening (fail closed).
 */
function goRemovedWithItsCode(top, file, gone) {
  if (gone.has(file.replace(GO_TEST_FILE, '.go'))) return true;
  const folder = posix.dirname(file);
  const isPackageCode = (name) => GO_FILE.test(name) && !GO_TEST_FILE.test(name);
  if (![...gone].some((path) => posix.dirname(path) === folder && isPackageCode(path))) return false;
  try {
    return !readdirSync(join(top, folder)).some(isPackageCode);
  } catch (error) {
    return error?.code === 'ENOENT'; // the folder itself is gone with its package
  }
}

/**
 * What git and the worktree say about the deletions of this change: `gone`, the files deleted outright (gone from the worktree,
 * reported deleted, not renamed, by git's rename detection `-M`, and whose base text is not the text of a new file of the change), and
 * `movedTo`, deleted file -> its new path (a rename git saw, or a new file with the same text: a move to an untracked path). When git
 * cannot answer, nothing counts as gone or moved, so a deleted test keeps blocking.
 * @param {{ top: string, base: string }} scope
 * @param {{ file: string, before: string|null, after: string|null }[]} texts every scanned file at the base and now
 * @returns {{ gone: Set<string>, movedTo: Map<string, string> }}
 */
function changeMoves(scope, texts) {
  const result = runGit(scope.top, ['diff', '--name-status', '-z', '-M', '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', scope.base, '--'], GIT_TIMEOUT_MS);
  if (result.status !== 0 || result.error) return { gone: new Set(), movedTo: new Map() };
  const fields = result.stdout.split('\0'); // `<status>\0<path>\0`, a rename or copy `R100\0<old>\0<new>\0`
  const deletedByGit = new Set();
  const movedTo = new Map();
  for (let index = 0; index < fields.length - 1; index += /^[RC]/.test(fields[index]) ? 3 : 2) {
    if (fields[index] === 'D') deletedByGit.add(fields[index + 1]);
    if (/^R/.test(fields[index]) && isSafeRelative(fields[index + 2])) movedTo.set(fields[index + 1], fields[index + 2]);
  }
  const newFileOf = new Map(texts.filter(({ before, after }) => before === null && typeof after === 'string' && after !== 'unreadable').map(({ file, after }) => [after, file]));
  const deleted = texts.filter(({ file, before, after }) => after === null && typeof before === 'string' && before !== 'unreadable' && deletedByGit.has(file));
  for (const { file, before } of deleted) if (newFileOf.has(before)) movedTo.set(file, newFileOf.get(before));
  return { gone: new Set(deleted.filter(({ file }) => !movedTo.has(file)).map(({ file }) => file)), movedTo };
}

/** A deleted test file that moved: the same scan as an edit, between its base text and the text at its new path (cases kept = no find). */
function weakenedMovedTest(top, file, before, target) {
  const after = headText(top, target);
  if (after === null || after === 'unreadable') return [failure(file, 'deleted', `test file deleted (moved to ${target}, which cannot be read)`)];
  return weakenedTestFile(target, before, after);
}

/** What a deleted file weakens: a test file that moved is compared at its new path; one deleted outright counts unless its code went too. */
function weakenedDeletion(top, file, before, moves) {
  if (!TEST_FILE.test(file)) return CHECK_CONFIG.test(file) ? [failure(file, 'config-deleted', 'a lint or test config was deleted')] : [];
  if (moves.movedTo.has(file)) return weakenedMovedTest(top, file, before, moves.movedTo.get(file));
  const withItsCode = GO_TEST_FILE.test(file) ? goRemovedWithItsCode(top, file, moves.gone) : removedWithItsCode(file, before, moves.gone);
  return withItsCode ? [] : [failure(file, 'deleted', 'test file deleted')];
}

/** What one changed file weakens, given its text at the base (null when new) and now (null when deleted), and the change's moves. */
function weakenedFile(top, { file, before, after }, moves) {
  const mustRead = TEST_FILE.test(file) || CHECK_CONFIG.test(file) || PACKAGE_JSON.test(file) || TSCONFIG.test(file);
  if (before === 'unreadable' || after === 'unreadable') return mustRead ? [failure(file, 'unreadable', 'cannot be read, so it cannot be compared with the base')] : [];
  if (before === null) return after !== null && CODE_FILE.test(file) && countOf(after, SUPPRESSIONS) > 0 ? [suppressionAdded(file, '', after)] : [];
  if (after === null) return weakenedDeletion(top, file, before, moves);
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
  const texts = files.map((file) => ({ file, before: baseText(scope.top, scope.base, file), after: headText(scope.top, file) }));
  const moves = texts.some(({ file, after }) => after === null && TEST_FILE.test(file)) ? changeMoves(scope, texts) : { gone: new Set(), movedTo: new Map() };
  return texts.flatMap((text) => weakenedFile(scope.top, text, moves));
}
