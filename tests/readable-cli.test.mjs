// Tests for home/tools/readable/readable.mjs end to end: real folders in a temp dir, a real git repo for --changed.
// Covers exit codes, .gitignore, the allow-list file, and that --changed ignores untouched legacy findings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../home/tools/readable/readable.mjs', import.meta.url));
const HEADER = '// Purpose: fixture.\n';
// Under the pre-commit hook git sets GIT_DIR and GIT_INDEX_FILE; a child git would then act on the repo being committed
// instead of the fixture. Drop every GIT_* variable, then set only the identity the fixture commits need.
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
const GIT_ENV = { ...CLEAN_ENV, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

/** Builds a folder from {path: text}. */
function project(files) {
  const root = mkdtempSync(join(tmpdir(), 'readable-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
const readable = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: GIT_ENV });
const git = (root, ...args) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: GIT_ENV });
  assert.equal(result.status, 0, result.stderr);
};
function commitAll(root) {
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
}

test('a clean project exits 0 and prints ok', () => {
  const root = project({ 'README.md': '# x\n', 'src/a.mjs': HEADER, 'src/README.md': '# src\n' });
  const result = readable('check', root);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), 'readable: ok');
});

test('findings exit 1 with file:line, rule id, the plain fix and a count per check', () => {
  const root = project({ 'utils/a.mjs': 'export {};\n', 'utils/b.mjs': HEADER, 'utils/c.mjs': HEADER, 'ci.yml': 'retries: 3\n' });
  const result = readable('check', root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^ci\.yml:1 C35 config-comment: key "retries" has no comment\. Fix: /m);
  assert.match(result.stdout, /^utils\/:1 C32 dumping-ground: /m);
  assert.match(result.stdout, /^utils\/:1 C34 no-readme: 3 source files/m);
  assert.match(result.stdout, /^utils\/a\.mjs:1 C26 no-header: /m);
  assert.match(result.stdout.trim(), /readable: 4 findings \(no-readme 1, dumping-ground 1, no-header 1, config-comment 1\)$/);
  assert.match(result.stdout, /Folder name "utils" says nothing/);
});

test('usage errors exit 2: no command, no folder, missing folder, bad flag, --base without --changed', () => {
  const root = project({ 'a.txt': 'x' });
  for (const args of [[], ['check'], ['check', join(root, 'missing')], ['check', root, '--wat'], ['check', root, '--base', 'main'], ['check', root, '--changed', '--base']]) {
    const result = readable(...args);
    assert.equal(result.status, 2, args.join(' '));
    assert.notEqual(result.stderr, '', args.join(' '));
  }
});

test('--changed outside a git repo exits 2 and says why', () => {
  const result = readable('check', project({ 'a.txt': 'x' }), '--changed');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /git/);
});

test('.gitignore and vendored folders are skipped', () => {
  const root = project({
    '.gitignore': 'generated-out/\n*.tmp.mjs\n',
    'generated-out/misc/a.mjs': 'x();\n', 'a.tmp.mjs': 'x();\n', 'node_modules/utils/a.mjs': 'x();\n', 'vendor/b/a.mjs': 'x();\n',
  });
  assert.equal(readable('check', root).stdout.trim(), 'readable: ok');
});

test('an allow-list entry with a reason silences the name; without a reason it does not and is reported', () => {
  const files = { 'data/rows.json': '[]\n' };
  const allowed = project({ ...files, '.readable.json': '{"allow":[{"path":"data","reason":"hand-edited fixtures"}]}' });
  assert.equal(readable('check', allowed).status, 0);
  const noReason = project({ ...files, '.readable.json': '{"allow":[{"path":"data"}]}' });
  const result = readable('check', noReason);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /dumping-ground/);
  assert.match(result.stdout, /\.readable\.json:1 C32 allow-list: .*without a "reason"/);
});

test('--changed keeps findings in touched files and drops legacy ones', () => {
  const root = project({ 'old-stuff/a.mjs': 'legacy();\n', 'legacy.yml': 'old: 1\n', 'src/ok.mjs': HEADER });
  commitAll(root);
  assert.equal(readable('check', root).status, 1, 'whole tree sees the legacy findings');
  assert.equal(readable('check', root, '--changed').stdout.trim(), 'readable: ok');
  writeFileSync(join(root, 'src/new.mjs'), 'run();\n');
  writeFileSync(join(root, 'legacy.yml'), 'old: 1\nadded: 2\n');
  const result = readable('check', root, '--changed');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^src\/new\.mjs:1 C26 no-header/m);
  assert.match(result.stdout, /^legacy\.yml:2 C35 config-comment: key "added"/m);
  assert.doesNotMatch(result.stdout, /old-stuff|"old"/);
});

test('--changed also flags a folder that crossed the README threshold through a new file', () => {
  const root = project({ 'app/a.mjs': HEADER, 'app/b.mjs': HEADER });
  commitAll(root);
  writeFileSync(join(root, 'app/c.mjs'), HEADER);
  assert.match(readable('check', root, '--changed').stdout, /^app\/:1 C34 no-readme/m);
});

test('--base compares with the given commit, including work committed on a branch', () => {
  const root = project({ 'a.mjs': HEADER });
  commitAll(root);
  git(root, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(root, 'b.mjs'), 'run();\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'feature work');
  assert.match(readable('check', root, '--changed').stdout, /^b\.mjs:1 C26/m);
  assert.match(readable('check', root, '--changed', '--base', 'HEAD~1').stdout, /^b\.mjs:1 C26/m);
  assert.equal(readable('check', root, '--changed', '--base', 'HEAD').stdout.trim(), 'readable: ok');
  assert.equal(readable('check', root, '--changed', '--base', 'no-such-ref').status, 2);
});
