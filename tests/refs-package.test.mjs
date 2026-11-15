// Tests for the package.json and workspace readers of home/tools/refs: package-entry, package-entry?, workspace-glob.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findingLines, project, refs } from './refs-helpers.mjs';

test('package-entry: main, module, types and typings must exist; the exact line is named', () => {
  const root = project({
    'package.json': '{\n  "name": "x",\n  "main": "./src/index.js",\n  "module": "src/gone.mjs",\n  "types": "src/index.d.ts",\n  "typings": "src/gone.d.ts"\n}\n',
    'src/index.js': '',
    'src/index.d.ts': '',
  });
  const result = refs(root);
  assert.equal(result.status, 1);
  assert.deepEqual(findingLines(result), [
    'package.json:4 package-entry src/gone.mjs -> missing',
    'package.json:6 package-entry src/gone.d.ts -> missing',
  ]);
});

test('package-entry: bin as a string or an object, and every string leaf of exports', () => {
  const text = [
    '{', '  "bin": { "tool": "./bin/tool.js", "other": "./bin/gone.js" },', '  "exports": {', '    ".": { "import": "./src/a.mjs", "require": "./src/gone.cjs" },',
    '    "./x": ["./src/a.mjs", "./src/also-gone.js"],', '    "./y": null', '  }', '}', '',
  ].join('\n');
  const root = project({ 'package.json': text, 'bin/tool.js': '', 'src/a.mjs': '' });
  assert.deepEqual(findingLines(refs(root)), [
    'package.json:2 package-entry ./bin/gone.js -> missing',
    'package.json:4 package-entry ./src/gone.cjs -> missing',
    'package.json:5 package-entry ./src/also-gone.js -> missing',
  ]);
  const stringBin = project({ 'package.json': '{\n  "bin": "cli.js"\n}\n' });
  assert.deepEqual(findingLines(refs(stringBin)), ['package.json:2 package-entry cli.js -> missing']);
});

test('package-entry: an exports pattern with a wildcard is checked up to the wildcard', () => {
  const text = '{\n  "exports": {\n    "./a/*": "./src/a/*.js",\n    "./b/*": "./src/b/*.js"\n  }\n}\n';
  const root = project({ 'package.json': text, 'src/a/x.js': '' });
  assert.deepEqual(findingLines(refs(root)), ['package.json:4 package-entry ./src/b/*.js -> missing']);
});

test('package-entry? is a hint when the missing path is under a build output folder', () => {
  const text = '{\n  "main": "dist/index.js",\n  "module": "./build/index.mjs",\n  "types": "lib/index.d.ts",\n  "bin": "out/cli.js"\n}\n';
  const result = refs(project({ 'package.json': text }));
  assert.equal(result.status, 0);
  assert.deepEqual(findingLines(result), [
    'package.json:2 package-entry? dist/index.js -> missing',
    'package.json:3 package-entry? ./build/index.mjs -> missing',
    'package.json:4 package-entry? lib/index.d.ts -> missing',
    'package.json:5 package-entry? out/cli.js -> missing',
  ]);
  assert.match(result.stdout, /refs: 0 findings, 4 hints in 1 files scanned/);
});

test('workspace-glob: pnpm-workspace.yaml entries that match no folder; negated entries are skipped', () => {
  const yaml = 'packages:\n  # comment\n  - "apps/*"\n  - packages/*\n  - \'tools/gone/*\'\n  - "!**/fixtures/**"\n  - docs\n\ncatalog:\n  react: 18\n';
  const root = project({ 'pnpm-workspace.yaml': yaml, 'apps/web/a.txt': '', 'packages/core/a.txt': '' });
  assert.deepEqual(findingLines(refs(root)), [
    'pnpm-workspace.yaml:5 workspace-glob tools/gone/* -> missing',
    'pnpm-workspace.yaml:7 workspace-glob docs -> missing',
  ]);
});

test('workspace-glob: a pattern matches folders only, not files', () => {
  const root = project({ 'pnpm-workspace.yaml': 'packages:\n  - packages/*\n', 'packages/readme.txt': '' });
  assert.deepEqual(findingLines(refs(root)), ['pnpm-workspace.yaml:2 workspace-glob packages/* -> missing']);
});

test('workspace-glob: package.json workspaces as an array and as an object with packages', () => {
  const array = project({ 'package.json': '{\n  "workspaces": ["apps/*", "libs/*", "!apps/old"]\n}\n', 'apps/web/x': '' });
  assert.deepEqual(findingLines(refs(array)), ['package.json:2 workspace-glob libs/* -> missing']);
  const object = project({ 'package.json': '{\n  "workspaces": {\n    "packages": ["gone/**"]\n  }\n}\n' });
  assert.deepEqual(findingLines(refs(object)), ['package.json:3 workspace-glob gone/** -> missing']);
});

test('workspace-glob: ** and {a,b} patterns match nested and alternative folders', () => {
  const yaml = 'packages:\n  - "libs/**"\n  - "{apps,tools}/*"\n  - "{nope,never}/*"\n';
  const root = project({ 'pnpm-workspace.yaml': yaml, 'libs/a/b/x': '', 'tools/t/x': '' });
  assert.deepEqual(findingLines(refs(root)), ['pnpm-workspace.yaml:4 workspace-glob {nope,never}/* -> missing']);
});

test('package-entry: main, module, types and typings without an extension, or naming a folder with index.*, are fine', () => {
  const text = '{\n  "main": "src/index",\n  "module": "esm/entry",\n  "types": "types",\n  "typings": "src/gone"\n}\n';
  const root = project({ 'package.json': text, 'src/index.cjs': '', 'esm/entry.mjs': '', 'types/index.d.ts': '' });
  assert.deepEqual(findingLines(refs(root)), ['package.json:5 package-entry src/gone -> missing']);
  for (const [name, file] of [['js', 'a.js'], ['mjs', 'a.mjs'], ['ts', 'a.ts'], ['tsx', 'a.tsx'], ['mts', 'a.mts'], ['cts', 'a.cts'], ['d.ts', 'a.d.ts'], ['json', 'a.json']]) {
    assert.deepEqual(findingLines(refs(project({ 'package.json': '{ "main": "a" }', [file]: '' }))), [], name);
  }
});
