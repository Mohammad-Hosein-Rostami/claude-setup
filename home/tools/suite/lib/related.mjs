// Picks the node:test files a change can affect, so a step runs those instead of the full suite.
// Exports: relatedTests.
// Rules, per changed file (repo-relative, `/` separators):
// - `package.json`, `settings/*` or `.githooks/*`: the full suite (they change how everything runs).
// - a test file (`*.test.mjs`, `*.test.js`): itself (a deleted one: nothing).
// - a `.mjs`/`.js` file: every test that reaches it through imports (static or literal dynamic), and every test that names the
//   basename of such a file in its text: tests spawn tools and hooks by path (`new URL('../home/tools/x/x.mjs', import.meta.url)`
//   or a joined path), so the file they spawn is named, not imported.
// - any other file: the tests that name its basename.
// - a file with no test is the full suite, except a plain doc: a `.md` outside home/agents and home/skills that is not a CLAUDE.md.
// - more than FULL_SHARE of all test files: the full suite.
// Invariants: only reads; an empty change, or a change of plain docs only, is `none` (no test is related: nothing ran, nothing
//   passed); a wrong pick can only cost time, since the full suite still runs before landing.
import { readFileSync } from 'node:fs';
import { basename, join, posix } from 'node:path';
import { gitText } from '../../git-tidy/lib/git.mjs';

const TEST_FILE = /\.test\.(?:mjs|js)$/;
const SOURCE_FILE = /\.(?:mjs|js)$/;
const FULL_SHARE = 0.4; // past this share of all tests the full suite is about as fast and needs no selection to be right
const ALWAYS_FULL = [/(?:^|\/)package\.json$/, /^settings\//, /^\.githooks\//];
const STEERING_DOCS = [/^home\/agents\//, /^home\/skills\//, /(?:^|\/)CLAUDE\.md$/]; // tests pin their text, so they are not plain docs
// The literal specifier of `from '<x>'` (static import and export), `import '<x>'` and `import('<x>')`.
const IMPORT_PATTERNS = [/\bfrom\s*['"]([^'"\n]+)['"]/g, /\bimport\s*\(?\s*['"]([^'"\n]+)['"]/g];

const isPlainDoc = (file) => file.endsWith('.md') && !STEERING_DOCS.some((pattern) => pattern.test(file));
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when `text` names `name` as a whole file name (`lib/git.mjs` names `git.mjs`; `tidy-git.mjs` does not). */
const namesFile = (text, name) => new RegExp(`(?:^|[^\\w.-])${escapeRegExp(name)}(?![\\w.-])`).test(text);

/** The repo's files as git sees them: tracked and untracked, ignored ones (node_modules, build output) left out. */
function repoFiles(repo) {
  return gitText(repo, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
}

/** Map of every `.mjs`/`.js` file that exists in the worktree -> its text (a tracked file deleted in the worktree is left out). */
function readSources(repo, files) {
  const sources = new Map();
  for (const file of files.filter((name) => SOURCE_FILE.test(name))) {
    try {
      sources.set(file, readFileSync(join(repo, file), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return sources;
}

/** Map of file -> the files that import it, over every `.mjs`/`.js` source text. */
function importedBy(sources) {
  const importers = new Map();
  for (const [file, text] of sources) {
    for (const pattern of IMPORT_PATTERNS) {
      for (const [, specifier] of text.matchAll(pattern)) {
        if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue; // packages and node: built-ins
        const target = posix.normalize(posix.join(posix.dirname(file), specifier));
        if (!importers.has(target)) importers.set(target, new Set());
        importers.get(target).add(file);
      }
    }
  }
  return importers;
}

/** `file` and every file that reaches it through imports, transitively. */
function reachingFiles(file, importers) {
  const reached = new Set([file]);
  const queue = [file];
  while (queue.length > 0) {
    for (const importer of importers.get(queue.pop()) ?? []) {
      if (reached.has(importer)) continue;
      reached.add(importer);
      queue.push(importer);
    }
  }
  return reached;
}

/** The test files one changed file selects (see the rules in the header). */
function testsFor(file, { tests, testSet, sources, importers }) {
  if (TEST_FILE.test(file)) return testSet.has(file) ? [file] : [];
  const reached = SOURCE_FILE.test(file) ? reachingFiles(file, importers) : new Set([file]);
  const names = [...new Set([...reached].map((path) => basename(path)))];
  return tests.filter((test) => reached.has(test) || names.some((name) => namesFile(sources.get(test), name)));
}

/**
 * The test files a change can affect.
 * @param {{ repo: string, changedFiles: string[] }} change the repository's top folder and the changed files (repo-relative)
 * @returns {{ kind: 'files', files: string[] } | { kind: 'full', why: string } | { kind: 'none' }} sorted test paths, the full suite
 *   with the reason, or none when no test is related
 * @throws {Error} git cannot list the repository's files
 */
export function relatedTests({ repo, changedFiles }) {
  if (changedFiles.length === 0) return { kind: 'none' };
  const forced = changedFiles.find((file) => ALWAYS_FULL.some((pattern) => pattern.test(file)));
  if (forced !== undefined) return { kind: 'full', why: `${forced} changes how every test runs` };
  const sources = readSources(repo, repoFiles(repo));
  const tests = [...sources.keys()].filter((file) => TEST_FILE.test(file)).sort();
  const context = { tests, testSet: new Set(tests), sources, importers: importedBy(sources) };
  const selected = new Set();
  for (const file of changedFiles) {
    const hits = testsFor(file, context);
    if (hits.length === 0 && !isPlainDoc(file) && !TEST_FILE.test(file)) return { kind: 'full', why: `no test reaches ${file}` };
    for (const test of hits) selected.add(test);
  }
  if (selected.size === 0) return { kind: 'none' };
  if (selected.size > tests.length * FULL_SHARE) return { kind: 'full', why: `${selected.size} of ${tests.length} test files are related` };
  return { kind: 'files', files: [...selected].sort() };
}
