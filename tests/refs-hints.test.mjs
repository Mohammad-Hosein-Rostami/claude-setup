// Tests for the heuristic readers of home/tools/refs: script-path? (package.json scripts) and config-path? (*.config.*, eslint).
import test from 'node:test';
import assert from 'node:assert/strict';
import { findingLines, project, refs } from './refs-helpers.mjs';

test('script-path?: a ./ or ../ token, or a token with a slash and an extension, that does not exist', () => {
  const scripts = [
    '{', '  "scripts": {', '    "build": "node ./scripts/build.mjs",', '    "gone": "node ./scripts/gone.mjs --verbose",', '    "ext": "tsx tools/gone-tool.ts && echo ok",',
    '    "here": "node scripts/exists.mjs; tsc -p tsconfig.json",', '    "skip": "echo $HOME/x.sh ./*.js a=./b https://x.test/a.js @scope/pkg",', '    "up": "node \\"../gone-up/x.js\\"",', '    "noext": "run tools/script"', '  }', '}', '',
  ].join('\n');
  const root = project({ 'package.json': scripts, 'scripts/build.mjs': '', 'scripts/exists.mjs': '', 'tsconfig.json': '{}' });
  const result = refs(root);
  assert.equal(result.status, 0);
  assert.deepEqual(findingLines(result), [
    'package.json:4 script-path? ./scripts/gone.mjs -> missing',
    'package.json:5 script-path? tools/gone-tool.ts -> missing',
    'package.json:8 script-path? ../gone-up/x.js -> missing',
  ]);
});

test('script-path?: paths are relative to the package folder, not the scanned root', () => {
  const root = project({ 'packages/a/package.json': '{\n  "scripts": { "x": "node ./run.mjs", "y": "node ./gone.mjs" }\n}\n', 'packages/a/run.mjs': '' });
  assert.deepEqual(findingLines(refs(root)), ['packages/a/package.json:2 script-path? ./gone.mjs -> missing']);
});

const CONFIG = [
  "import plugin from './plugins/plugin.ts';", "import sibling from './sibling';", "import gone from './gone-import.mjs';", 'export default {',
  "  root: './gone-dir', // './comment-gone'", '  /* "./block-gone" */', '  alias: { a: "../gone/lib", b: \'./present\', glob: \'./src/*.ts\', t: `./${plugin}/y`, ok: \'./\' },',
  '  pattern: /["\'].\\/x/, // regex with quotes', "  tpl: `./tpl-gone`,", '};', '',
].join('\n');

test('config-path?: ./ and ../ string literals in *.config.* files that do not exist; comments, globs and templates are skipped', () => {
  const root = project({ 'vite.config.ts': CONFIG, 'plugins/plugin.ts': '', 'sibling.ts': '', present: '', 'src/a.ts': '' });
  const result = refs(root);
  assert.equal(result.status, 0);
  assert.deepEqual(findingLines(result), [
    'vite.config.ts:3 config-path? ./gone-import.mjs -> missing',
    'vite.config.ts:5 config-path? ./gone-dir -> missing',
    'vite.config.ts:7 config-path? ../gone/lib -> missing',
    'vite.config.ts:9 config-path? ./tpl-gone -> missing',
  ]);
});

test('config-path?: eslint.config.*, .eslintrc* (js, json, yaml) and other *.config.* extensions are read; other files are not', () => {
  const root = project({
    'eslint.config.mjs': "export default [{ ignores: ['./gone-a'] }];\n",
    '.eslintrc.json': '{\n  "extends": ["./gone-b.json"]\n}\n',
    '.eslintrc.yml': 'extends:\n  - ./gone-c.yml\n',
    'jest.config.cjs': "module.exports = { setupFiles: ['./gone-d.js'] };\n",
    'app.js': "const x = './gone-e';\n",
  });
  assert.deepEqual(findingLines(refs(root)).map((line) => line.split(' ').slice(0, 3).join(' ')), [
    '.eslintrc.json:2 config-path? ./gone-b.json',
    '.eslintrc.yml:2 config-path? ./gone-c.yml',
    'eslint.config.mjs:1 config-path? ./gone-a',
    'jest.config.cjs:1 config-path? ./gone-d.js',
  ]);
});

test('config-path? with --no-hints prints nothing and still exits 0', () => {
  const root = project({ 'vite.config.ts': "export default { root: './gone' };\n" });
  const result = refs(root, '--no-hints');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'refs: 0 findings, 0 hints in 1 files scanned\n');
});

test('config-path?: a string that is an object key is skipped (module-federation exposes)', () => {
  const text = "export default {\n  exposes: { './XRemote': './src/remote-gone.ts', './Other': './src/other.ts' },\n};\n";
  const root = project({ 'federation.config.js': text, 'src/other.ts': '' });
  assert.deepEqual(findingLines(refs(root)), ['federation.config.js:2 config-path? ./src/remote-gone.ts -> missing']);
});

test('config-path?: values of output or cache keys are skipped, other keys still fire', () => {
  const text = [
    'export default {', "  cacheDir: './node_modules/.vite-gone',", "  build: { outDir: './out-gone' },", "  outputPath: './o-gone',", "  reportsDirectory: './r-gone',",
    "  dir: './d-gone',", "  tmp: './t-gone',", "  setupFile: './setup-gone.js',", '};', '',
  ].join('\n');
  assert.deepEqual(findingLines(refs(project({ 'vite.config.ts': text }))), ['vite.config.ts:8 config-path? ./setup-gone.js -> missing']);
});
