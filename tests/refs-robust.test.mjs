// Tests for how home/tools/refs behaves on awkward input: unreadable files, case differences in folders, unclosed quotes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { findingLines, project, refs } from './refs-helpers.mjs';

test('a file that cannot be read is a hint unreadable? with the reason, and the run goes on', () => {
  const root = project({ 'a/tsconfig.json': '{}', 'b/tsconfig.json': '{ "extends": "./gone.json" }' });
  chmodSync(join(root, 'a/tsconfig.json'), 0o000);
  const result = refs(root);
  chmodSync(join(root, 'a/tsconfig.json'), 0o644); // so the temp folder can be cleaned up later
  if (process.getuid?.() === 0) return; // root reads any file, so there is nothing to observe
  assert.equal(result.status, 1);
  assert.deepEqual(findingLines(result).map((line) => line.split(' ').slice(0, 2).join(' ')), ['b/tsconfig.json:1 tsconfig-extends', 'a/tsconfig.json:1 unreadable?']);
});

test('a case-only difference in a folder name is missing, in the middle of a path too', () => {
  const root = project({ 'tsconfig.json': '{\n  "include": ["Src/app"],\n  "files": ["src/App.ts"]\n}\n', 'src/app/a.ts': '', 'src/app.ts': '' });
  assert.deepEqual(findingLines(refs(root)), [
    'tsconfig.json:2 tsconfig-include Src/app -> missing',
    'tsconfig.json:3 tsconfig-include src/App.ts -> missing',
  ]);
});

test('an unclosed quote in a config file does not shift the line numbers of what follows', () => {
  const root = project({ 'vite.config.ts': "const broken = 'oops;\nexport default { root: './gone' };\n" });
  assert.deepEqual(findingLines(refs(root)), ['vite.config.ts:2 config-path? ./gone -> missing']);
});

test('a file used as a folder in a reference is missing, not an error', () => {
  const root = project({ 'tsconfig.json': '{ "extends": "./file.txt/inner.json" }', 'file.txt': 'x' });
  assert.deepEqual(findingLines(refs(root)), ['tsconfig.json:1 tsconfig-extends ./file.txt/inner.json -> missing']);
});

test('a reference with a NUL character is missing, not a crash', () => {
  const root = project({ 'tsconfig.json': '{ "extends": "./a\\u0000b.json" }' });
  assert.equal(refs(root).status, 1);
});
