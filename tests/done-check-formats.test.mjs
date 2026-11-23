// Tests that the done-check parsers read what the real tools print: each sample in tests/fixtures/done-check/ (captured from tsc 5.8.3,
// eslint 9.39.5, vitest 4.1.9 and node 26.5 TAP, jest written from its documented shape) goes through its parser, and so does the
// Windows variant of the sample (backslash paths, CRLF), which must give the same failure ids (spec A12).
// Written from the design (section 6 parse.mjs, section 5 pass bar) before the engine exists: red until home/tools/done-check/lib/parse.mjs lands.
// Choices the spec leaves open, fixed here so the parser lane has one reading: a test-file load failure (vitest, jest, node TAP) is a
// failure of that file, never "0 failures"; skipped and todo tests are not failures; a TAP suite line that failed only because a
// subtest failed is not counted again (node's own `# fail` count is the guide); the name of a failed test file is its path, so its id
// shows `/` on Windows too; an eslint warning is never a failure; text that is
// empty or no result at all gives null (never an empty ok, spec A13).
// `changedLinesOf` is assumed to be `(file) => [from, to][]`; the fake below matches by path ending, so an absolute or a repo-relative file works.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEslintJson, parseJestJson, parseTap, parseTsc, parseVitestJson } from '../home/tools/done-check/lib/parse.mjs';
import { findHits, readDenyList, wordPattern } from '../scripts/share-check.mjs';

const SAMPLES = fileURLToPath(new URL('./fixtures/done-check/', import.meta.url));
const sample = (name) => readFileSync(SAMPLES + name, 'utf8');
const slash = (text) => text.replaceAll('\\', '/');
// The part of a path from its first `src/` or `test/` folder: the same for `/work/proj/src/a.ts`, `C:\work\proj\src\a.ts` and `src/a.ts`.
const tail = (file) => slash(file).replace(/^.*?\b((?:src|test)\/)/, '$1');
const splitId = (id) => [tail(id.slice(0, id.indexOf('|'))), id.slice(id.indexOf('|') + 1)];
/** Failure ids made comparable across systems: the file part cut to its tail. */
const comparableIds = (result) => result.failures.map((failure) => splitId(failure.id).join('|')).sort();
const noCarriageReturn = (result) =>
  result.failures.every((f) => !/[\r\n]/.test(f.id) && !/[\r\n]/.test(f.text) && !f.file.includes('\\') && !/[\r\n]/.test(f.file));

test('every sample file is described in the README, and each Windows variant really has CRLF and backslash paths', () => {
  const readme = sample('README.md');
  const files = readdirSync(SAMPLES).filter((name) => name !== 'README.md' && name !== '.gitattributes');
  assert.ok(files.length >= 10, `only ${files.length} samples found`);
  for (const name of files) assert.ok(readme.includes(name), `${name} is not named in the README`);
  for (const name of files.filter((n) => n.includes('-windows'))) {
    const text = sample(name);
    assert.match(text, /\r\n/, `${name} has no CRLF`);
    assert.match(text, /\\/, `${name} has no backslash`);
  }
});

// The folder in front of a `node_modules/` may only be a neutral one: the tools folder `/work/tools`, the README's `<tools-checkout>`
// placeholder, or a pnpm store entry (`@scope+name@version`), so no sample names the project the tools came from.
const NODE_MODULES_PARENT = /([^\s/"'`(]+)\/node_modules\//g;
const neutralParent = (folder) => folder === 'tools' || folder === '<tools-checkout>' || /^@[^@/]+\+[^@/]+@[\d.]+$/.test(folder);

test('no sample holds a user name, a home folder or a scratch path', () => {
  // the person's private words (personal/share-deny.txt of the main checkout, scripts/share-check.mjs); none listed: the generic checks
  const { words } = readDenyList(SAMPLES);
  const denied = (words ?? []).map((word) => ({ word, pattern: wordPattern(word) }));
  for (const name of readdirSync(SAMPLES)) {
    const text = sample(name);
    assert.doesNotMatch(text, /\/Users\/|\/home\/\w|scratchpad|\/private\/tmp|\/var\/folders/i, name);
    const parents = [...text.matchAll(NODE_MODULES_PARENT)].map((match) => match[1]);
    assert.deepEqual(parents.filter((folder) => !neutralParent(folder)), [], `${name}: node_modules under a named folder`);
    assert.deepEqual(findHits(text, denied).map((hit) => `${name}:${hit.line}`), [], `${name}: a share deny word`);
  }
});

test('the node_modules folder check refuses a project-named folder and keeps the neutral ones', () => {
  const parents = (text) => [...text.matchAll(NODE_MODULES_PARENT)].map((match) => match[1]).filter((folder) => !neutralParent(folder));
  assert.deepEqual(parents('node <my-shop>/node_modules/vitest/vitest.mjs and /x/my-shop/node_modules/a'), ['<my-shop>', 'my-shop']);
  assert.deepEqual(parents('file:///work/tools/node_modules/.pnpm/@vitest+runner@4.1.9/node_modules/x <tools-checkout>/node_modules/y'), []);
});

test('tsc: five diagnostics with file, line, code in the id, the message cut to one line, a path with a space', () => {
  const result = parseTsc(sample('tsc-5.8.3-errors.txt'));
  assert.equal(result.total, 5);
  assert.equal(result.failures.length, 5);
  assert.ok(result.failures.every((f) => f.kind === 'types'));
  assert.deepEqual(result.failures.map((f) => [f.file, f.line]), [
    ['src/cart.ts', 5], ['src/cart.ts', 6], ['src/label.ts', 2], ['src/label.ts', 5], ['src/two words/note.ts', 1],
  ]);
  assert.deepEqual(result.failures.map((f) => f.id.split('|').slice(0, 2).join('|')), [
    'src/cart.ts|TS2345', 'src/cart.ts|TS2322', 'src/label.ts|TS2339', 'src/label.ts|TS7006', 'src/two words/note.ts|TS2322',
  ]);
  assert.match(result.failures[0].id, /^src\/cart\.ts\|TS2345\|Argument of type/); // the caller of a changed type, spec A1
  assert.ok(noCarriageReturn(result));
});

test('tsc: the id ignores the line, so moving code does not make an old failure new', () => {
  const moved = parseTsc(sample('tsc-5.8.3-errors.txt').replace(/\((\d+),/g, (_m, line) => `(${Number(line) + 40},`));
  assert.deepEqual(moved.failures.map((f) => f.id), parseTsc(sample('tsc-5.8.3-errors.txt')).failures.map((f) => f.id));
});

test('tsc Windows sample (backslash paths, CRLF): same ids, `/` in files, no carriage return left', () => {
  const posix = parseTsc(sample('tsc-5.8.3-errors.txt'));
  const windows = parseTsc(sample('tsc-5.8.3-errors-windows.txt'));
  assert.deepEqual(windows.failures.map((f) => f.id), posix.failures.map((f) => f.id));
  assert.deepEqual(windows.failures.map((f) => [f.file, f.line]), posix.failures.map((f) => [f.file, f.line]));
  assert.equal(windows.total, 5);
  assert.ok(noCarriageReturn(windows));
});

test('tsc: text with no diagnostic and no result is unreadable, never an empty ok', () => {
  assert.equal(parseTsc('Segmentation fault: 11\n'), null);
});

// eslint ------------------------------------------------------------------------------------------------------------------------------
/** Fake of the changed-lines lookup: ranges per file, found by the path ending. */
function changedLinesOf(byEnding) {
  return (file) => {
    const path = slash(file);
    const ending = Object.keys(byEnding).find((end) => path.endsWith(end));
    return ending ? byEnding[ending] : [];
  };
}
const lineOf = (failure) => [tail(failure.file), failure.line];

test('eslint: only severity-2 messages on changed lines are failures; warnings never are', () => {
  const result = parseEslintJson(sample('eslint-9.39.5-errors.json'), changedLinesOf({ 'src/discount.js': [[2, 2]] }));
  assert.deepEqual(result.failures.map(lineOf), [['src/discount.js', 2]]);
  assert.equal(result.failures[0].kind, 'lint');
  assert.match(result.failures[0].text, /unusedRate/);
  assert.ok(noCarriageReturn(result));
});

test('eslint: every error line in the changed range counts, a parse error too, a warning on a changed line still does not', () => {
  const lines = changedLinesOf({ 'src/discount.js': [[1, 100]], 'src/two words/broken.js': [[1, 1]] });
  const result = parseEslintJson(sample('eslint-9.39.5-errors.json'), lines);
  assert.deepEqual(result.failures.map(lineOf), [['src/discount.js', 2], ['src/discount.js', 5], ['src/two words/broken.js', 1]]);
  assert.match(result.failures[2].text, /Parsing error/);
});

test('eslint: an error outside the changed lines is old code, not a failure (and no changed line is not null)', () => {
  const result = parseEslintJson(sample('eslint-9.39.5-errors.json'), changedLinesOf({ 'src/discount.js': [[7, 8]] }));
  assert.deepEqual(result, { failures: [], total: result.total });
  assert.notEqual(result, null);
});

test('eslint Windows sample (backslash filePath, CRLF between lines): same files, lines and ids', () => {
  const lines = changedLinesOf({ 'src/discount.js': [[1, 100]], 'src/two words/broken.js': [[1, 1]] });
  const posix = parseEslintJson(sample('eslint-9.39.5-errors.json'), lines);
  const windows = parseEslintJson(sample('eslint-9.39.5-errors-windows.json'), lines);
  assert.equal(windows.failures.length, 3);
  assert.deepEqual(windows.failures.map(lineOf), posix.failures.map(lineOf));
  assert.deepEqual(comparableIds(windows), comparableIds(posix));
  assert.ok(noCarriageReturn(windows));
});

test('eslint: empty, garbage, cut-off and wrong-shape output is null', () => {
  const none = changedLinesOf({});
  for (const text of ['', '  \n', 'not json', '{"a":1}', '{"filePath":"a"}', sample('eslint-9.39.5-errors.json').slice(0, 300)]) {
    assert.equal(parseEslintJson(text, none), null, JSON.stringify(text.slice(0, 30)));
  }
});

// vitest and jest: the same result shape (testResults[].assertionResults[]) --------------------------------------------------------------
const RESULT_JSON_TOOLS = [
  { tool: 'vitest', parse: parseVitestJson, posix: 'vitest-4.1.9-fail.json', windows: 'vitest-4.1.9-fail-windows.json',
    failedFile: 'src/math.test.ts', loadFile: 'src/broken.test.ts', otherFile: 'src/two words/note.test.ts', otherName: 'note is text', total: 6, failures: 3 },
  { tool: 'jest', parse: parseJestJson, posix: 'jest-30-docs-fail.json', windows: 'jest-30-docs-fail-windows.json',
    failedFile: 'src/math.test.js', loadFile: 'src/broken.test.js', otherFile: null, otherName: null, total: 6, failures: 2 },
];

for (const spec of RESULT_JSON_TOOLS) {
  test(`${spec.tool}: failed tests and a file that did not load are failures; skipped and todo are not`, () => {
    const result = spec.parse(sample(spec.posix));
    assert.equal(result.total, spec.total);
    assert.equal(result.failures.length, spec.failures);
    assert.ok(result.failures.every((f) => f.kind === 'tests'));
    const ids = comparableIds(result);
    assert.ok(ids.includes(`${spec.failedFile}|add adds negative numbers`), ids.join('\n'));
    assert.ok(ids.some((id) => id.startsWith(`${spec.loadFile}|`)), `no failure for ${spec.loadFile}: ${ids.join(' / ')}`);
    if (spec.otherFile) assert.ok(ids.includes(`${spec.otherFile}|${spec.otherName}`), ids.join('\n'));
    assert.ok(!ids.some((id) => /wraps around|rejects NaN/.test(id)), 'a skipped or todo test was counted');
    const loadFailure = result.failures.find((f) => tail(f.file) === spec.loadFile);
    assert.match(loadFailure.text, /Cannot find module/);
    assert.ok(noCarriageReturn(result));
  });

  test(`${spec.tool} Windows sample (C:\\ paths, CRLF): same ids as the posix sample`, () => {
    const posix = spec.parse(sample(spec.posix));
    const windows = spec.parse(sample(spec.windows));
    assert.deepEqual(comparableIds(windows), comparableIds(posix));
    assert.equal(windows.total, posix.total);
    assert.ok(noCarriageReturn(windows));
  });

  test(`${spec.tool}: empty, garbage, cut-off and wrong-shape output is null, never an ok (A13)`, () => {
    const cutOff = sample(spec.posix).slice(0, 400);
    for (const text of ['', ' \r\n ', 'garbage', '{', 'null', '[]', '{}', '{"a":1}', cutOff]) {
      assert.equal(spec.parse(text), null, JSON.stringify(text.slice(0, 30)));
    }
  });
}

test('vitest: a `related` run that found no test is a valid result with 0 tests, not null and not a failure', () => {
  assert.deepEqual(parseVitestJson(sample('vitest-4.1.9-none-related.json')), { failures: [], total: 0 });
});

// node:test TAP ---------------------------------------------------------------------------------------------------------------------------
test('TAP: the three real failures (nested test, throw, file that did not load) match the tool\'s own `# fail 3`, out of 7 tests', () => {
  const result = parseTap(sample('node-tap-26.5.0-fail.txt'));
  assert.equal(result.total, 7);
  assert.equal(result.failures.length, 3, 'the `not ok - slugify` suite line must not count again');
  assert.ok(result.failures.every((f) => f.kind === 'tests'));
  const ids = comparableIds(result);
  assert.ok(ids.some((id) => id.startsWith('test/load.test.mjs|')), ids.join('\n'));
  assert.ok(ids.some((id) => id.startsWith('test/slug.test.mjs|') && id.includes('joins with dashes')), ids.join('\n'));
  assert.ok(ids.some((id) => id.startsWith('test/two words/sum.test.mjs|') && id.endsWith('throws on purpose')), ids.join('\n'));
  assert.ok(!ids.some((id) => /keeps accents|handles emoji/.test(id)), 'a skipped or todo test was counted');
  const thrown = result.failures.find((f) => f.id.endsWith('throws on purpose'));
  assert.match(thrown.text, /boom: first line/);
  assert.ok(noCarriageReturn(result));
});

test('TAP: a passing run is a valid result with its test count', () => {
  assert.deepEqual(parseTap(sample('node-tap-26.5.0-pass.txt')), { failures: [], total: 2 });
});

test('TAP Windows sample (C:\\ paths, CRLF): same ids as the posix sample', () => {
  const posix = parseTap(sample('node-tap-26.5.0-fail.txt'));
  const windows = parseTap(sample('node-tap-26.5.0-fail-windows.txt'));
  assert.deepEqual(comparableIds(windows), comparableIds(posix));
  assert.equal(windows.total, 7);
  assert.ok(noCarriageReturn(windows));
});

test('TAP: empty, garbage or a header with no result is null; a cut-off run (no summary) is null too', () => {
  const cutOff = sample('node-tap-26.5.0-fail.txt').split('# tests')[0];
  for (const text of ['', ' \n', 'garbage', 'TAP version 13\n', cutOff]) {
    assert.equal(parseTap(text), null, JSON.stringify(text.slice(0, 30)));
  }
});
