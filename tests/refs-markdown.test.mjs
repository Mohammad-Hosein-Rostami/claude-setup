// Tests for the markdown readers of home/tools/refs (md-link, md-path?) and for files it must never open (.env*).
import test from 'node:test';
import assert from 'node:assert/strict';
import { findingLines, project, refs } from './refs-helpers.mjs';

test('md-link: a present relative link gives nothing, a missing one names the line', () => {
  const root = project({ 'README.md': '# T\n\nSee [guide](docs/guide.md) and [gone](docs/gone.md).\n', 'docs/guide.md': '[up](../README.md)\n' });
  const result = refs(root);
  assert.equal(result.status, 1);
  assert.deepEqual(findingLines(result), ['README.md:3 md-link docs/gone.md -> missing']);
});

test('md-link: anchors and queries are stripped; links are relative to the file; a leading slash is relative to the folder scanned', () => {
  const text = '[a](./a.md#intro)\n[b](a.md?plain=1)\n[c](/docs/a.md)\n[d](a.md#x?y)\n[e](gone.md#intro)\n';
  const root = project({ 'docs/a.md': '', 'docs/index.md': text });
  assert.deepEqual(findingLines(refs(root)), ['docs/index.md:5 md-link gone.md -> missing']);
});

test('md-link: urls, mailto, other schemes and bare anchors are skipped', () => {
  const text = '[a](http://x.test/a) [b](https://x.test/b) [c](mailto:a@b.test) [d](#top) [e](tel:123) [f](//cdn.test/x)\n';
  assert.deepEqual(findingLines(refs(project({ 'README.md': text }))), []);
});

test('md-link: links inside fenced code (``` and ~~~) and inline code are skipped; text after the fence is read again', () => {
  const text = '```md\n[a](gone-1.md)\n```\n~~~\n[b](gone-2.md)\n~~~\n`[c](gone-3.md)`\n[d](gone-4.md)\n';
  assert.deepEqual(findingLines(refs(project({ 'README.md': text }))), ['README.md:8 md-link gone-4.md -> missing']);
});

test('md-link: titles, images, angle brackets, spaces and %20 in the path, and Windows separators', () => {
  const text = '[a](a.md "the title")\n![i](img/pic.png)\n[s](<my file.md>)\n[t](my%20file.md)\n[w](sub\\gone.md)\n[g](<gone file.md>)\n';
  const root = project({ 'README.md': text, 'a.md': '', 'img/pic.png': '', 'my file.md': '' });
  assert.deepEqual(findingLines(refs(root)), ['README.md:5 md-link sub\\gone.md -> missing', 'README.md:6 md-link gone file.md -> missing']);
});

test('md-link: .mdc files in hidden folders are read, CRLF files keep their line numbers', () => {
  const root = project({ '.cursor/rules/style.mdc': '---\r\ndescription: x\r\n---\r\n[r](../../docs/gone.md)\r\n' });
  assert.deepEqual(findingLines(refs(root)), ['.cursor/rules/style.mdc:4 md-link ../../docs/gone.md -> missing']);
});

test('md-path?: a backticked path whose first segment is a top-level folder but whose full path is missing is a hint', () => {
  const text = 'Edit `src/gone.ts` or `src/a.ts`, run `scripts/` or `src/a.ts:12`.\nNot paths: `a/b` `src/*.ts` `src/<name>` `${HOME}/x` `https://x.test/src/y` `src/a b` `/src/y` `src/...`.\n';
  const root = project({ 'README.md': text, 'src/a.ts': '', 'scripts/x.sh': '' });
  const result = refs(root);
  assert.equal(result.status, 0);
  assert.deepEqual(findingLines(result), ['README.md:1 md-path? src/gone.ts -> missing']);
  assert.match(result.stdout, /refs: 0 findings, 1 hints in 1 files scanned/);
});

test('md-path?: code in a fence is not read', () => {
  const root = project({ 'README.md': '```\n`src/gone.ts`\n```\n', 'src/a.ts': '' });
  assert.deepEqual(findingLines(refs(root)), []);
});

test('files named .env* are never opened, whatever their extension', () => {
  const marker = 'SECRET_MARKER_8731';
  const root = project({
    '.env': `TOKEN=${marker}\n`,
    '.env.md': `[x](${marker}/gone.md)\n`,
    '.env.local': `extends=${marker}\n`,
    'docker-compose.yml': 'services:\n  a:\n    env_file: .env\n',
  });
  const result = refs(root, '--json');
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(marker));
  assert.equal(JSON.parse(result.stdout).scanned, 1);
});

test('md-link: balanced parentheses and <...> targets are read whole', () => {
  const text = '[a](docs/a_(b).md)\n[b](docs/gone_(c).md)\n[c](<docs/with (parens).md>)\n[d](docs/a_(b).md "title")\n[e](docs/a_(b).md#x)\n';
  const root = project({ 'README.md': text, 'docs/a_(b).md': '', 'docs/with (parens).md': '' });
  assert.deepEqual(findingLines(refs(root)), ['README.md:2 md-link docs/gone_(c).md -> missing']);
});

test('md-link: site-root links and links that leave the scanned folder are skipped', () => {
  const root = project({ 'sub/README.md': '[a](/api/users) [b](../../issues/12) [c](../../../x/y.md) [d](../gone.md)\n' });
  assert.deepEqual(findingLines(refs(root)), ['sub/README.md:1 md-link ../gone.md -> missing']);
});

test('md-path?: npm names are skipped (@scope/pkg and a dependency of a scanned package.json); a real missing path still fires', () => {
  const text = 'Use `@nx/react`, `react-dom/client` and `tools/gone.sh`.\n';
  const pkg = '{ "dependencies": { "react-dom": "1" }, "devDependencies": { "@nx/react": "1" } }';
  const root = project({ 'README.md': text, 'package.json': pkg, '@nx/react/x': '', 'react-dom/y': '', 'tools/a.sh': '' });
  assert.deepEqual(findingLines(refs(root)), ['README.md:1 md-path? tools/gone.sh -> missing']);
});
