// Purpose: name the tests a change can break, so a commit runs those and only the landing runs the whole suite.
// Usage: node scripts/affected-tests.mjs (--staged | --base <ref> | <path>...) (--list | --run) [--why]
//   --staged  the files of the commit being made (read the staged list BEFORE a hook clears the GIT_* variables: a partial
//             `git commit -- <path>` stages through a temporary index that only GIT_INDEX_FILE names)
//   --base    everything changed since the merge-base with <ref>: commits, uncommitted edits, new untracked files
//   --list    prints test paths, one per line (the reason goes to stderr); --run runs them with `node --test` and exits with its code
//   --why     also prints, on stderr, which changed path led to each test
// Exports: buildMap(root), affected(changed, map, { onBase }), listTests(root).
// Invariants: when unsure the whole suite runs (a code file no test reaches, a change in .githooks/ settings/ or this script,
//   the branch main or master, a map that cannot be built); only a change that no test can read (documents) runs nothing.
//   Exit codes: 0 ok (or the tests' own code with --run), 2 usage or a test path with a space (the hook word-splits the list).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CODE_FILE = /\.(?:mjs|cjs|js|sh|ps1|jq)$/;
const SOURCE_FOLDERS = ['home', 'scripts', 'tests'];
const SKIPPED_FOLDERS = new Set(['node_modules', '.git']);
const SCRIPT_PATH = 'scripts/affected-tests.mjs';
const ALWAYS_FULL_PREFIXES = ['.githooks/', 'settings/'];
const BASE_BRANCHES = ['main', 'master'];
const NOTHING_CHANGED = 'no code or text file that a test reads changed';
const IMPORT_OF_FILE = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g;
const PATH_FRAGMENT = /\b((?:home|scripts|tests)\/[\w./-]+)/g;
const QUOTED_NAME = /['"`]([\w./@-]+)['"`]/g;
const USAGE = 'usage: affected-tests.mjs (--staged | --base <ref> | <path>...) (--list | --run) [--why]';
const ACTIONS = ['--list', '--run'];

// Text that tests read but never import: a changed file under the prefix runs these tests (only those that exist).
const TEXT_FILE_TESTS = [
  ['home/modes/', ['modes-consistency', 'mode', 'mode-context', 'ccm']],
  ['home/CLAUDE.md', ['modes-consistency', 'rules-text', 'mode-context']],
  ['home/rules/', ['modes-consistency', 'rules-text', 'mode']],
  ['home/agents/', ['agent-files', 'agent-model-guard', 'agent-model-guard-briefs', 'agent-model-guard-matrix', 'agent-model-guard-writers', 'project-agents', 'modes-consistency', 'rules-text']],
  ['home/skills/', ['agent-files', 'modes-consistency', 'mode-context', 'skill-router']],
  ['home/workflows/', ['workflow-scripts']],
  ['docs/modes.md', ['modes-consistency']],
  ['docs/daily-use.md', ['modes-consistency', 'watch-idle-cli']],
];
// Documents no test reads at run time (docs/modes.md and docs/daily-use.md are read, see above): a change here runs nothing.
const DOCUMENT_PREFIXES = ['docs/', 'home/standards/', 'home/project-notes/'];

const posix = (path) => path.split(sep).join('/');
const isCode = (path) => CODE_FILE.test(path) || path.startsWith('home/bin/');
const isJsFile = (path) => /\.(?:mjs|cjs|js)$/.test(path);
// A script under home/ or scripts/ that names a data file ('install.sh' in a scanner) does not run it; one that names a
// script does. Shell scripts, tests and test helpers stay unrestricted: they run what they name.
const isSourceJs = (path) => isJsFile(path) && !path.startsWith('tests/');
const isTest = (path) => /^tests\/[^/]+\.test\.mjs$/.test(path);
const decidesWhatRuns = (path) => ALWAYS_FULL_PREFIXES.some((prefix) => path.startsWith(prefix)) || path === SCRIPT_PATH;
const isDocument = (path) =>
  path.endsWith('README.md') || DOCUMENT_PREFIXES.some((prefix) => path.startsWith(prefix)) || (!path.includes('/') && path.endsWith('.md'));

/** Paths (relative to `root`, with `/`) of every file below `folder`, without node_modules and .git. */
function filesBelow(root, folder) {
  if (!existsSync(join(root, folder))) return [];
  return readdirSync(join(root, folder), { withFileTypes: true }).flatMap((entry) => {
    if (SKIPPED_FOLDERS.has(entry.name)) return [];
    const path = `${folder}/${entry.name}`;
    return entry.isDirectory() ? filesBelow(root, path) : [path];
  });
}

/** The top-level `tests/*.test.mjs` files, sorted: the files the suite command runs. */
export function listTests(root) {
  return readdirSync(join(root, 'tests')).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => `tests/${name}`);
}

/** Files that `path` refers to: relative imports, `home/...` path fragments, and quoted file names (spawned scripts, fixtures). */
function referencesOf(root, path, known, byName) {
  const text = readFileSync(join(root, path), 'utf8');
  const found = new Set();
  for (const [, specifier] of text.matchAll(IMPORT_OF_FILE)) {
    const target = posix(relative(root, resolve(root, dirname(path), specifier)));
    if (known.has(target)) found.add(target);
  }
  for (const [, fragment] of text.matchAll(PATH_FRAGMENT)) {
    const folder = fragment.replace(/\/+$/, '');
    for (const file of known) if (file === folder || file.startsWith(`${folder}/`)) found.add(file);
  }
  for (const [, quoted] of text.matchAll(QUOTED_NAME)) for (const file of byName.get(quoted.split('/').pop()) ?? []) found.add(file);
  found.delete(path);
  return isSourceJs(path) ? new Set([...found].filter(isJsFile)) : found;
}

/** Every file reachable from `start` through `references`, `start` included. */
function reachable(start, references) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    for (const next of references(queue.pop())) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/** Files grouped by their last path part, so a quoted `'ccm'` or `'x.mjs'` finds the file it names. */
function groupByName(files) {
  const byName = new Map();
  for (const file of files) {
    const name = file.split('/').pop();
    byName.set(name, [...(byName.get(name) ?? []), file]);
  }
  return byName;
}

/**
 * The map from files to the tests that reach them.
 * @param {string} root repo root (the folder with home/, scripts/ and tests/)
 * @returns {{ tests: string[], testsOf: Map<string, string[]> }} `tests`: every `tests/*.test.mjs`; `testsOf`: for each
 *   file under home/, scripts/ and tests/, the tests that reach it: the test itself, what it imports, what it or its
 *   helpers spawn or read by path string, and so on without end
 */
export function buildMap(root) {
  const tests = listTests(root);
  const known = new Set(SOURCE_FOLDERS.flatMap((folder) => filesBelow(root, folder)));
  const byName = groupByName(known);
  const cache = new Map();
  const references = (path) => {
    if (!cache.has(path)) cache.set(path, isCode(path) ? referencesOf(root, path, known, byName) : new Set());
    return cache.get(path);
  };
  const testsOf = new Map();
  for (const test of tests) {
    for (const file of reachable(test, references)) testsOf.set(file, [...(testsOf.get(file) ?? []), test]);
  }
  return { tests, testsOf };
}

const textFileTests = (path, map) =>
  TEXT_FILE_TESTS.filter(([prefix]) => path.startsWith(prefix))
    .flatMap(([, names]) => names.map((name) => `tests/${name}.test.mjs`))
    .filter((test) => map.tests.includes(test));

/** The tests one changed path leads to, or 'full' when only the whole suite is safe. */
function testsFor(path, map) {
  if (decidesWhatRuns(path)) return 'full';
  if (isTest(path)) return map.tests.includes(path) ? [path] : [];
  const found = [...new Set([...(map.testsOf.get(path) ?? []), ...textFileTests(path, map)])];
  if (found.length > 0) return found;
  if (path.startsWith('tests/') && !isCode(path)) return [];
  return isDocument(path) || !(isCode(path) || path.startsWith('home/')) ? [] : 'full';
}

/**
 * Which tests a change needs.
 * @param {string[]} changed repo-relative paths with `/` (added, changed or deleted)
 * @param {{ tests: string[], testsOf: Map<string, string[]> } | null} map from buildMap; null when it could not be built
 * @param {{ onBase: boolean }} options onBase: the checked-out branch is main or master
 * @returns {{ full: boolean, reason: string, tests: string[] }} full: run every test (`tests` is then the whole list, empty
 *   for a null map); otherwise `tests` is the sorted list, possibly empty
 */
export function affected(changed, map, { onBase }) {
  if (map === null) return { full: true, reason: 'the test map could not be built', tests: [] };
  if (onBase) return { full: true, reason: 'the branch is main or master', tests: map.tests };
  const tests = new Set();
  for (const path of changed) {
    const found = testsFor(path, map);
    if (found === 'full') {
      const reason = decidesWhatRuns(path) ? `${path} changed (it decides which tests run)` : `no test reaches ${path}`;
      return { full: true, reason, tests: map.tests };
    }
    for (const test of found) tests.add(test);
  }
  const reason = tests.size > 0 ? `${tests.size} of ${map.tests.length} tests reach the change` : NOTHING_CHANGED;
  return { full: false, reason, tests: [...tests].sort() };
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.trim()}`);
  return result.stdout;
}

const gitPaths = (root, args) => git(root, args).split('\0').filter((path) => path !== '');

function changedSince(root, ref) {
  const mergeBase = git(root, ['merge-base', ref, 'HEAD']).trim();
  const tracked = gitPaths(root, ['diff', '--name-only', '-z', '--no-renames', mergeBase]);
  return [...new Set([...tracked, ...gitPaths(root, ['ls-files', '-z', '--others', '--exclude-standard'])])];
}

const stagedFiles = (root) => gitPaths(root, ['diff', '--cached', '--name-only', '-z', '--no-renames']);

const onBaseBranch = (root) => BASE_BRANCHES.includes(spawnSync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim());

/** Reads argv into { source: 'staged' | { base } | string[], action, why }, or null when the call is malformed. */
function parseArgs(argv) {
  const paths = [];
  const flags = new Set();
  let base = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base') base = argv[++i] ?? '';
    else if ([...ACTIONS, '--staged', '--why'].includes(argv[i])) flags.add(argv[i]);
    else if (argv[i].startsWith('--')) return null;
    else paths.push(argv[i]);
  }
  const staged = flags.has('--staged');
  const sourceCount = [staged, base !== null, paths.length > 0].filter(Boolean).length;
  const actions = ACTIONS.filter((flag) => flags.has(flag));
  if (sourceCount !== 1 || actions.length !== 1 || base === '') return null;
  const source = staged ? 'staged' : base !== null ? { base } : paths.map((path) => posix(path).replace(/^\.\//, ''));
  return { source, action: actions[0], why: flags.has('--why') };
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  return 2;
}

/** Prints, on stderr, the changed paths each test came from. */
function explain(changed, result, map) {
  for (const path of changed) {
    const found = testsFor(path, map);
    if (found !== 'full') for (const test of found.filter((name) => result.tests.includes(name))) process.stderr.write(`  ${path} -> ${test}\n`);
  }
}

function summaryLine(result, map, mapError) {
  if (result.full) return `full suite: ${result.reason}${mapError ? ` (${mapError})` : ''}`;
  if (result.tests.length === 0) return `no affected tests (${result.reason})`;
  return `affected tests: ${result.tests.length} of ${map.tests.length} (${result.reason})`;
}

function tryBuildMap(root) {
  try {
    return { map: buildMap(root), error: '' };
  } catch (error) {
    return { map: null, error: error.message };
  }
}

function main(argv) {
  const args = parseArgs(argv);
  if (args === null) return fail(USAGE);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { map, error } = tryBuildMap(root);
  let changed;
  try {
    changed = args.source === 'staged' ? stagedFiles(root) : Array.isArray(args.source) ? args.source : changedSince(root, args.source.base);
  } catch (gitError) {
    return fail(`affected-tests: ${gitError.message}`);
  }
  const result = affected(changed, map, { onBase: onBaseBranch(root) });
  if (map === null) result.tests = listTests(root);
  const spaced = result.tests.find((path) => /\s/.test(path));
  if (spaced) return fail(`affected-tests: the test path "${spaced}" has a space; rename it (the hook splits the list on spaces)`);
  process.stderr.write(`${summaryLine(result, map, error)}\n`);
  if (args.why && map !== null) explain(changed, result, map);
  if (args.action === '--list') {
    for (const test of result.tests) process.stdout.write(`${test}\n`);
    return 0;
  }
  if (result.tests.length === 0) return 0;
  return spawnSync(process.execPath, ['--test', '--test-reporter=dot', ...result.tests], { cwd: root, stdio: 'inherit' }).status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
