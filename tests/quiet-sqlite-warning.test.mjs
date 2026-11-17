// Tests for home/tools/recall/lib/quiet-sqlite-warning.mjs: it drops only Node's "SQLite is an experimental feature"
// warning, every other warning still prints, and every file that loads node:sqlite imports it first and loads sqlite late.
// The warning is emitted by hand in a child process, so these tests fail without the fix on any Node version
// (Node 26 prints nothing for SQLite). One test runs the real recall CLI and only on Node 22.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeTempDir } from './temp-dir-helpers.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const FILTER = fileURLToPath(new URL('../home/tools/recall/lib/quiet-sqlite-warning.mjs', import.meta.url));
const CLI = fileURLToPath(new URL('../home/tools/recall/recall.mjs', import.meta.url));
const SQLITE_WARNING = 'SQLite is an experimental feature and might change at any time';
const EXPECTED_ENTRY_POINTS = ['home/hooks/recall-digest.mjs', 'home/tools/recall/checkpoint-job.mjs', 'home/tools/recall/recall.mjs'];

/** Run `code` as an ES module in a child that imports the filter first (unless `withFilter` is false). */
function child(code, { withFilter = true, nodeArgs = [] } = {}) {
  const prelude = withFilter ? `import ${JSON.stringify(pathToFileURL(FILTER).href)};\n` : '';
  return spawnSync(process.execPath, [...nodeArgs, '--input-type=module', '-e', prelude + code], { encoding: 'utf8' });
}

test('the SQLite experimental warning is dropped: stderr stays empty', () => {
  const result = child(`process.emitWarning(${JSON.stringify(SQLITE_WARNING)}, 'ExperimentalWarning');`);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
});

test('without the filter the same warning does print (the child really can see it)', () => {
  const result = child(`process.emitWarning(${JSON.stringify(SQLITE_WARNING)}, 'ExperimentalWarning');`, { withFilter: false });
  assert.match(result.stderr, /ExperimentalWarning: SQLite is an experimental feature/);
});

test('another ExperimentalWarning still reaches stderr', () => {
  const result = child("process.emitWarning('Type stripping is experimental', 'ExperimentalWarning');");
  assert.match(result.stderr, /ExperimentalWarning: Type stripping is experimental/);
});

test('a DeprecationWarning still reaches stderr, also one that mentions SQLite', () => {
  const plain = child("process.emitWarning('old api', 'DeprecationWarning', 'DEP0999');");
  assert.match(plain.stderr, /DeprecationWarning: old api/);
  const sqlite = child("process.emitWarning('SQLite option is deprecated', 'DeprecationWarning', 'DEP0998');");
  assert.match(sqlite.stderr, /DeprecationWarning: SQLite option is deprecated/);
});

test('the options form and an Error object of the SQLite warning are dropped too; other options-form warnings print', () => {
  const dropped = child(`
    process.emitWarning(${JSON.stringify(SQLITE_WARNING)}, { type: 'ExperimentalWarning' });
    const error = new Error(${JSON.stringify(SQLITE_WARNING)}); error.name = 'ExperimentalWarning';
    process.emitWarning(error);`);
  assert.equal(dropped.stderr, '');
  const kept = child("process.emitWarning('something else', { type: 'ExperimentalWarning' });");
  assert.match(kept.stderr, /ExperimentalWarning: something else/);
});

test('warning listeners added by other code still see every warning except the dropped one', () => {
  const result = child(`
    const seen = [];
    process.on('warning', (warning) => seen.push(warning.message));
    process.emitWarning(${JSON.stringify(SQLITE_WARNING)}, 'ExperimentalWarning');
    process.emitWarning('other thing', 'ExperimentalWarning');
    process.emitWarning('a deprecation', 'DeprecationWarning', 'DEP0997');
    process.on('exit', () => console.log(JSON.stringify(seen)));`);
  assert.deepEqual(JSON.parse(result.stdout), ['other thing', 'a deprecation']);
});

test('--no-warnings from the caller keeps working: nothing prints and the filter does not break', () => {
  const result = child("process.emitWarning('other thing', 'ExperimentalWarning');", { nodeArgs: ['--no-warnings'] });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
});

// ---- the files that load node:sqlite ----

const LOADS_SQLITE = /^(?:import\s.*from\s+|const\s.*=\s*process\.getBuiltinModule\()'node:sqlite'/m;

/** Every .mjs file under home/ that imports or loads node:sqlite (a code line, not a comment), with its source. */
function sqliteLoaders() {
  const found = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.mjs') && LOADS_SQLITE.test(readFileSync(path, 'utf8'))) found.set(path, readFileSync(path, 'utf8'));
    }
  };
  walk(join(REPO, 'home'));
  return found;
}

// A static `import ... from 'node:sqlite'` is loaded (and warns) before any module body runs, so it can not come after the filter.
const IMPORT_SPEC = /^import\s[^'"\n]*?['"]([^'"]+)['"]|^import\s*['"]([^'"]+)['"]/gm;
const importsOf = (source) => [...source.matchAll(IMPORT_SPEC)].map((match) => match[1] ?? match[2]);
const relativeNames = (files) => [...files.keys()].map((file) => relative(REPO, file).replaceAll('\\', '/')).sort();

test('the files that load node:sqlite are the two known ones', () => {
  assert.deepEqual(relativeNames(sqliteLoaders()), ['home/hooks/recall-digest.mjs', 'home/tools/recall/lib/store.mjs']);
});

test('each such file imports the filter first and loads node:sqlite from its body, not with a static import', () => {
  for (const [file, source] of sqliteLoaders()) {
    const name = relative(REPO, file);
    const imports = importsOf(source);
    assert.equal(resolve(dirname(file), imports[0]), FILTER, `${name} must import quiet-sqlite-warning.mjs before anything else (first import is ${imports[0]})`);
    assert.equal(imports.includes('node:sqlite'), false, `${name} must not import node:sqlite statically: Node loads it before the filter runs`);
    assert.match(source, /process\.getBuiltinModule\('node:sqlite'\)/, `${name} must load node:sqlite with process.getBuiltinModule`);
  }
});

// ---- the real tool ----

const NODE_22 = process.versions.node.startsWith('22.');
test('recall index on an empty root prints nothing on stderr', { skip: !NODE_22 && `the SQLite warning exists only on Node 22 (this is ${process.version})` }, () => {
  const dir = makeTempDir('quiet-sqlite-');
  const env = { ...process.env, RECALL_DB: join(dir, 'db', 'index.db'), RECALL_ROOT: join(dir, 'projects'), RECALL_HOME: dir, RECALL_RERANK: 'off' };
  const result = spawnSync(process.execPath, [CLI, 'index'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});

test('loading the recall-digest hook prints nothing on stderr', { skip: !NODE_22 && `the SQLite warning exists only on Node 22 (this is ${process.version})` }, () => {
  const hook = pathToFileURL(fileURLToPath(new URL('../home/hooks/recall-digest.mjs', import.meta.url))).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(hook)});`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});
