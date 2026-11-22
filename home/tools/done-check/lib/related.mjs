// Picks the node:test files that a change can break: the test files named by the globs of a `node --test` script part that are
// changed themselves, import a changed file (static import, export-from, require or dynamic import with a literal path, up to 3 hops), or
// write a changed file's path in their text (a test that spawns a script).
// Exports: nodeRelatedTests(root, globs, files, max) -> absolute paths; testFilesOfGlobs(root, globs) -> absolute paths;
//   pathsNamedByTests(root, paths) -> the repo-relative paths whose file name some test-looking file writes (the scope's first, cheap guess).
// Invariants: reads only regular files under `root` (a link, FIFO or device is skipped, a file over 1 MiB is not read); never follows
//   a link; skips node_modules and .git; a glob that is absolute or climbs out with `..` matches nothing; the same input always gives the
//   same answer (order: changed test first, then direct, then deeper imports, ties by path), so a key built on it is stable.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const MAX_IMPORT_HOPS = 3;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_WALKED_ENTRIES = 100_000; // a walk that grows past this stops: a huge folder must not hang a hook
const SKIPPED_FOLDERS = new Set(['node_modules', '.git']);
const CODE_EXTENSIONS = ['.mjs', '.js', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.jsx', '.vue'];
const SCRIPT_EXTENSION = /\.(mjs|cjs|js)$/;
const TEST_LOOKING = /(?:^|\/)(?:tests?|__tests__)\/|[._-](?:test|spec)\.[cm]?[jt]sx?$/; // a path a test usually lives at
const MAX_NAMED_CANDIDATES = 200; // changed non-code files looked up at most; more than this is a bulk edit, not one a test reads
const IMPORT_FORMS = [
  /\b(?:import|export)\s+(?:[^'"`;]*?\bfrom\s*)?['"]([^'"\n]+)['"]/g,
  /\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];
const CASE_BLIND_PLATFORM = process.platform === 'win32' || process.platform === 'darwin';
const pathKey = (path) => (CASE_BLIND_PLATFORM ? path.toLowerCase() : path);
const withSlashes = (path) => path.split(sep).join('/');
const IGNORABLE_ERRORS = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM']);

/** The `lstat` of `path`, or null when it is missing or cannot be looked at; any other error is a real failure and is thrown. */
function statOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (IGNORABLE_ERRORS.has(error.code)) return null;
    throw error;
  }
}

const isRegularFile = (path) => statOrNull(path)?.isFile() === true;

/** The text of a regular file of at most 1 MiB; '' for anything else. */
function readText(path) {
  const info = statOrNull(path);
  if (!info?.isFile() || info.size > MAX_TEXT_BYTES) return '';
  return readFileSync(path, 'utf8');
}

/** Expands the first `{a,b}` group of a glob, recursively, into plain globs. */
function expandBraces(glob) {
  const open = glob.indexOf('{');
  if (open < 0) return [glob];
  let depth = 0;
  const pieces = [];
  let pieceStart = open + 1;
  for (let at = open; at < glob.length; at += 1) {
    if (glob[at] === '{') depth += 1;
    else if (glob[at] === ',' && depth === 1) { pieces.push(glob.slice(pieceStart, at)); pieceStart = at + 1; }
    else if (glob[at] === '}') {
      depth -= 1;
      if (depth === 0) {
        pieces.push(glob.slice(pieceStart, at));
        const head = glob.slice(0, open);
        const tail = glob.slice(at + 1);
        return pieces.flatMap((piece) => expandBraces(`${head}${piece}${tail}`));
      }
    }
  }
  return [glob]; // an unclosed brace is plain text
}

/** The RegExp of one brace-free glob: `**` crosses folders, `*` and `?` stay in one folder, `[abc]` is a class. */
function globToRegExp(glob) {
  let source = '';
  for (let at = 0; at < glob.length; at += 1) {
    const char = glob[at];
    if (glob.startsWith('**/', at)) { source += '(?:.*/)?'; at += 2; }
    else if (glob.startsWith('**', at)) { source += '.*'; at += 1; }
    else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else if (char === '[' && glob.indexOf(']', at) > at) { const close = glob.indexOf(']', at); source += `[${glob.slice(at + 1, close).replace(/\\/g, '\\\\')}]`; at = close; }
    else source += char.replace(/[.+^${}()|\\\]/]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/** The folder part of a glob before its first wildcard segment: where a walk has to start ('' = the root). */
function staticFolderOf(glob) {
  const segments = glob.split('/');
  const plain = [];
  for (const segment of segments.slice(0, -1)) {
    if (/[*?[\]]/.test(segment)) break;
    plain.push(segment);
  }
  return plain.join('/');
}

/** Every regular file below `folder` as a repo-relative `/` path, without node_modules and .git, stopping at the walk cap. */
function walkFiles(root, folder, found) {
  const pending = [folder];
  while (pending.length > 0 && found.size < MAX_WALKED_ENTRIES) {
    const current = pending.pop();
    let entries;
    try {
      entries = readdirSync(join(root, current), { withFileTypes: true });
    } catch (error) {
      if (IGNORABLE_ERRORS.has(error.code)) continue;
      throw error;
    }
    for (const entry of entries) {
      const path = current ? `${current}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !SKIPPED_FOLDERS.has(entry.name)) pending.push(path);
      else if (entry.isFile()) found.add(path);
    }
  }
}

/** True for a glob that must match nothing: absolute, or with a `..` segment. */
const escapesRoot = (glob) => glob.startsWith('/') || /^[A-Za-z]:/.test(glob) || glob.split('/').includes('..');

/**
 * The files the globs name, found by walking only the folders the globs start in.
 * @param {string} root absolute folder the globs are relative to (the package root)
 * @param {string[]} globs globs with `*`, `**`, `?`, `[..]` and `{a,b}`
 * @returns {string[]} absolute paths, sorted by their repo-relative path
 */
export function testFilesOfGlobs(root, globs) {
  const matches = new Set();
  for (const raw of globs) {
    const glob = raw.replace(/^(\.\/)+/, '');
    if (escapesRoot(glob)) continue;
    for (const plainGlob of expandBraces(glob)) {
      const found = new Set();
      walkFiles(root, staticFolderOf(plainGlob), found);
      const matcher = globToRegExp(plainGlob);
      for (const path of found) if (matcher.test(path)) matches.add(path);
    }
  }
  return [...matches].sort().map((path) => resolve(root, path));
}

/** The existing file a relative import specifier means, or null (a bare package name, or nothing on disk). */
function resolveImport(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), specifier.replace(/[?#].*$/, ''));
  const swapped = SCRIPT_EXTENSION.test(base) ? ['.ts', '.tsx', '.mts', '.cts'].map((extension) => base.replace(SCRIPT_EXTENSION, extension)) : [];
  const candidates = [base, ...CODE_EXTENSIONS.map((extension) => base + extension), ...swapped, ...CODE_EXTENSIONS.map((extension) => join(base, `index${extension}`))];
  return candidates.find(isRegularFile) ?? null;
}

/** Remembers, per file, the files it imports, so a shared helper is read once. */
function importGraph() {
  const importsByFile = new Map();
  return (file) => {
    if (!importsByFile.has(file)) {
      const text = readText(file);
      const specifiers = IMPORT_FORMS.flatMap((form) => [...text.matchAll(form)].map((match) => match[1]));
      importsByFile.set(file, [...new Set(specifiers.map((specifier) => resolveImport(file, specifier)).filter(Boolean))]);
    }
    return importsByFile.get(file);
  };
}

/** True when `text` writes the repo-relative `path` as a path (not as the tail of a longer name). */
function namesPath(text, path) {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const before = path.includes('/') ? '(?:^|[^\\w.-])' : '(?:^|[\\s\'"`]|\\./)';
  return new RegExp(`${before}${escaped}(?![\\w])`).test(text);
}

/** How near a test is to the change: 0 changed itself, 1 imports or names a changed file, 2-3 through other files, null unrelated. */
function distanceOf(testFile, changedKeys, changedPaths, importsOf) {
  if (changedKeys.has(pathKey(testFile))) return 0;
  const seen = new Set([testFile]);
  let frontier = [testFile];
  for (let hop = 1; hop <= MAX_IMPORT_HOPS; hop += 1) {
    const next = [];
    for (const file of frontier) {
      for (const imported of importsOf(file)) {
        if (changedKeys.has(pathKey(imported))) return hop;
        if (!seen.has(imported)) { seen.add(imported); next.push(imported); }
      }
    }
    frontier = next;
  }
  const text = readText(testFile);
  return changedPaths.some((path) => namesPath(text, path)) ? 1 : null;
}

/**
 * The test files of a `node --test` script part that a change can break, nearest first, at most `max`.
 * @param {string} root absolute package root; the globs and `files` are relative to it
 * @param {string[]} globs the globs of the script part, for example `tests/*.test.mjs`
 * @param {string[]} files changed code files, relative to `root` with `/` separators
 * @param {number} max most files to return (MAX_NODE_RELATED)
 * @returns {string[]} absolute paths: changed tests first, then by import distance, ties by path; the same input gives the same list
 */
export function nodeRelatedTests(root, globs, files, max) {
  const changedKeys = new Set(files.map((file) => pathKey(resolve(root, file))));
  const changedPaths = files.map((file) => withSlashes(relative(root, resolve(root, file))));
  const importsOf = importGraph();
  const ranked = [];
  for (const testFile of testFilesOfGlobs(root, globs)) {
    const distance = distanceOf(testFile, changedKeys, changedPaths, importsOf);
    if (distance !== null) ranked.push({ testFile, distance });
  }
  ranked.sort((left, right) => left.distance - right.distance || (left.testFile < right.testFile ? -1 : 1));
  return ranked.slice(0, max).map((entry) => entry.testFile);
}

/**
 * Of changed non-code files, the ones some test file names. The scope uses it to decide whether a markdown or json change is worth a check
 * (a test that reads `docs/rules.md` can break when it changes); the exact path match is still done by nodeRelatedTests against the real globs.
 * It is a cheap guess: a test-looking file (a `test`, `tests` or `__tests__` folder, or `.test.` / `.spec.` in the name) that holds the
 * file's name, so a path written in pieces is found too. Reads each test file once, at most 1 MiB, never follows a link.
 * @param {string} root absolute folder the paths are relative to
 * @param {string[]} paths changed files, repo-relative with `/` separators
 * @returns {string[]} the paths a test names, in the order given (at most MAX_NAMED_CANDIDATES are looked at)
 */
export function pathsNamedByTests(root, paths) {
  const wanted = paths.slice(0, MAX_NAMED_CANDIDATES);
  if (wanted.length === 0) return [];
  const found = new Set();
  walkFiles(root, '', found);
  const named = new Set();
  for (const file of [...found].sort().filter((path) => TEST_LOOKING.test(path))) {
    const text = readText(join(root, file));
    for (const path of wanted) if (!named.has(path) && text.includes(path.split('/').pop())) named.add(path);
    if (named.size === wanted.length) break;
  }
  return wanted.filter((path) => named.has(path));
}
