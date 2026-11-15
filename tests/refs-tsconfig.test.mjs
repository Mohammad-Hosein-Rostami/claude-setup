// Tests for the tsconfig readers of home/tools/refs: extends, references, paths, include/files, JSON with comments.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findingLines, project, refs } from './refs-helpers.mjs';

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

test('tsconfig-extends: a present base gives nothing, a missing one gives the exact line', () => {
  const present = project({ 'tsconfig.json': json({ extends: './base.json' }), 'base.json': '{}' });
  assert.deepEqual(findingLines(refs(present)), []);
  assert.equal(refs(present).status, 0);
  const missing = project({ 'tsconfig.json': '{\n  "extends": "./base.json"\n}\n' });
  const result = refs(missing);
  assert.equal(result.status, 1);
  assert.deepEqual(findingLines(result), ['tsconfig.json:2 tsconfig-extends ./base.json -> missing']);
  assert.match(result.stdout, /refs: 1 findings, 0 hints in 1 files scanned\n$/);
});

test('tsconfig-extends: a name without .json, an array and a package name are handled', () => {
  const root = project({
    'tsconfig.json': '{\n  "extends": ["./base", "@tsconfig/node20/tsconfig.json", "some-package", "./gone"]\n}\n',
    'base.json': '{}',
  });
  assert.deepEqual(findingLines(refs(root)), ['tsconfig.json:2 tsconfig-extends ./gone -> missing']);
});

test('tsconfig-reference: a referenced folder or file must exist', () => {
  const root = project({
    'tsconfig.json': '{\n  "references": [\n    { "path": "./pkg-a" },\n    { "path": "./pkg-b/tsconfig.app.json" },\n    { "path": "./pkg-c" }\n  ]\n}\n',
    'pkg-a/tsconfig.json': '{}',
    'pkg-b/tsconfig.app.json': '{}',
  });
  assert.deepEqual(findingLines(refs(root)), ['tsconfig.json:5 tsconfig-reference ./pkg-c -> missing']);
});

test('tsconfig-path: alias targets resolve against baseUrl; a wildcard target is checked up to the wildcard', () => {
  const config = [
    '{', '  "compilerOptions": {', '    "baseUrl": "src",', '    "paths": {',
    '      "@app/*": ["app/*"],', '      "@lib/*": ["libs/*"],', '      "@one": ["one/index.ts"],', '      "@two": ["two/gone.ts"],', '      "@dir": ["shared"]',
    '    }', '  }', '}', '',
  ].join('\n');
  const root = project({ 'tsconfig.json': config, 'src/app/a.ts': '', 'src/one/index.ts': '', 'src/shared/x.ts': '' });
  assert.deepEqual(findingLines(refs(root)), [
    'tsconfig.json:6 tsconfig-path libs/* -> missing',
    'tsconfig.json:8 tsconfig-path two/gone.ts -> missing',
  ]);
});

test('tsconfig-path: without baseUrl the folder of the config is the base; an alias to a file without extension is accepted', () => {
  const root = project({
    'tsconfig.json': '{\n  "compilerOptions": {\n    "paths": {\n      "@a": ["./src/a"],\n      "@b": ["./src/b"]\n    }\n  }\n}\n',
    'src/a.ts': '',
  });
  assert.deepEqual(findingLines(refs(root)), ['tsconfig.json:5 tsconfig-path ./src/b -> missing']);
});

test('tsconfig-include: literal include and files entries are checked, globs are not', () => {
  const root = project({
    'tsconfig.json': '{\n  "include": ["src", "gone-dir", "lib/**/*.ts", "x/*.ts"],\n  "files": ["main.ts", "gone.ts"]\n}\n',
    'src/a.ts': '',
    'main.ts': '',
  });
  assert.deepEqual(findingLines(refs(root)), [
    'tsconfig.json:2 tsconfig-include gone-dir -> missing',
    'tsconfig.json:3 tsconfig-include gone.ts -> missing',
  ]);
});

test('tsconfig and jsconfig variants are read; other json files are not', () => {
  const root = project({
    'tsconfig.build.json': json({ extends: './a.json' }),
    'sub/jsconfig.json': json({ extends: './b.json' }),
    'other.json': json({ extends: './c.json' }),
  });
  assert.deepEqual(findingLines(refs(root)), [
    'sub/jsconfig.json:2 tsconfig-extends ./b.json -> missing',
    'tsconfig.build.json:2 tsconfig-extends ./a.json -> missing',
  ]);
});

test('JSON with comments and trailing commas is read, and the line numbers stay right', () => {
  const text = '// top comment\n{\n  /* block\n     comment */\n  "extends": "./a.json", // why\n  "include": ["src",],\n}\n';
  const root = project({ 'tsconfig.json': text });
  assert.deepEqual(findingLines(refs(root)), [
    'tsconfig.json:5 tsconfig-extends ./a.json -> missing',
    'tsconfig.json:6 tsconfig-include src -> missing',
  ]);
});

test('a BOM and CRLF line ends do not change values or lines', () => {
  const root = project({ 'tsconfig.json': '﻿{\r\n  "extends": "./a.json"\r\n}\r\n' });
  assert.deepEqual(findingLines(refs(root)), ['tsconfig.json:2 tsconfig-extends ./a.json -> missing']);
});

test('a case-only mismatch counts as missing (real directory entries are compared)', () => {
  const root = project({ 'tsconfig.json': json({ extends: './Base.json' }), 'base.json': '{}' });
  assert.deepEqual(findingLines(refs(root)), ['tsconfig.json:2 tsconfig-extends ./Base.json -> missing']);
});

test('values with spaces and Windows separators are read as paths', () => {
  const root = project({
    'tsconfig.json': '{\n  "extends": ".\\\\my configs\\\\base.json",\n  "include": ["my src\\\\gone"]\n}\n',
    'my configs/base.json': '{}',
  });
  assert.deepEqual(findingLines(refs(root)), ['tsconfig.json:3 tsconfig-include my src\\gone -> missing']);
});

test('an unparsable tsconfig is a hint unreadable? and the exit code stays 0', () => {
  const root = project({ 'tsconfig.json': '{\n  "extends": \n' });
  const result = refs(root);
  assert.equal(result.status, 0);
  assert.match(findingLines(result)[0], /^tsconfig\.json:\d+ unreadable\? .+/);
  assert.match(result.stdout, /refs: 0 findings, 1 hints in 1 files scanned/);
});

const withPaths = (extra = '') => `{\n  ${extra}"compilerOptions": {\n    "paths": { "@app/*": ["app/*"] }\n  }\n}\n`;

test('tsconfig-path: baseUrl set in the extends parent decides where alias targets are looked for', () => {
  const parent = '{ "compilerOptions": { "baseUrl": "./src" } }';
  const child = withPaths('"extends": "../../tsconfig.base.json",\n  ');
  const present = project({ 'tsconfig.base.json': parent, 'apps/x/tsconfig.json': child, 'src/app/a.ts': '' });
  assert.deepEqual(findingLines(refs(present)), []);
  const missing = project({ 'tsconfig.base.json': parent, 'apps/x/tsconfig.json': child, 'apps/x/app/a.ts': '' });
  assert.deepEqual(findingLines(refs(missing)), ['apps/x/tsconfig.json:4 tsconfig-path app/* -> missing']);
});

test('tsconfig-path: baseUrl is found through a two-level chain, and the last entry of an extends array wins', () => {
  const chain = project({
    'a.json': '{ "compilerOptions": { "baseUrl": "./libs" } }', 'b.json': '{ "extends": "./a" }', 'tsconfig.json': withPaths('"extends": "./b.json",\n  '),
    'libs/app/x.ts': '',
  });
  assert.deepEqual(findingLines(refs(chain)), []);
  const array = project({
    'one.json': '{ "compilerOptions": { "baseUrl": "./wrong" } }', 'two.json': '{ "compilerOptions": { "baseUrl": "./right" } }',
    'tsconfig.json': withPaths('"extends": ["./one.json", "./two.json"],\n  '), 'right/app/x.ts': '',
  });
  assert.deepEqual(findingLines(refs(array)), []);
});

test('tsconfig-path: with no baseUrl anywhere the targets are relative to the file that defines paths', () => {
  const root = project({ 'base.json': '{}', 'tsconfig.json': withPaths('"extends": "./base.json",\n  '), 'app/x.ts': '' });
  assert.deepEqual(findingLines(refs(root)), []);
  const missing = project({ 'base.json': '{}', 'tsconfig.json': withPaths('"extends": "./base.json",\n  ') });
  assert.deepEqual(findingLines(refs(missing)), ['tsconfig.json:4 tsconfig-path app/* -> missing']);
});

test('tsconfig-path: a package parent or a missing parent gives one hint tsconfig-path? and no finding', () => {
  const viaPackage = refs(project({ 'tsconfig.json': withPaths('"extends": "@tsconfig/node20/tsconfig.json",\n  ') }));
  assert.equal(viaPackage.status, 0);
  assert.deepEqual(findingLines(viaPackage), ['tsconfig.json:4 tsconfig-path? paths not checked: extends "@tsconfig/node20/tsconfig.json" names a package']);
  const missingParent = refs(project({ 'tsconfig.json': withPaths('"extends": "./gone.json",\n  ') }));
  assert.deepEqual(findingLines(missingParent), [
    'tsconfig.json:2 tsconfig-extends ./gone.json -> missing',
    'tsconfig.json:4 tsconfig-path? paths not checked: extends "./gone.json" cannot be read',
  ]);
});
