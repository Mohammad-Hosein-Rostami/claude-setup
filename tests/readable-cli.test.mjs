// Tests for home/tools/readable/readable.mjs end to end on real folders: exit codes, the report format, .gitignore (also of
// parent folders), the allow-list files, framework exemptions and a crash. The `--changed` behaviour is in readable-changed.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitAll, git, HEADER, project, readable, write } from './readable-helpers.mjs';

test('a clean project exits 0 and prints ok', () => {
  const root = project({ 'README.md': '# x\n', 'src/a.mjs': HEADER, 'src/README.md': '# src\n' });
  const result = readable(['check', root]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), 'readable: ok');
});

test('findings exit 1 with file:line, rule id, the plain fix and a count per check', () => {
  const root = project({ 'utils/a.mjs': 'export {};\n', 'utils/b.mjs': HEADER, 'utils/c.mjs': HEADER, 'ci.yml': 'retries: 3\n' });
  const result = readable(['check', root]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^ci\.yml:1 C35 config-comment: key "retries" has no comment\. Fix: /m);
  assert.match(result.stdout, /^utils\/:1 C32 dumping-ground: Folder name "utils" says nothing/m);
  assert.match(result.stdout, /^utils\/:1 C34 no-readme: 3 source files/m);
  assert.match(result.stdout, /^utils\/a\.mjs:1 C26 no-header: /m);
  assert.match(result.stdout.trim(), /readable: 4 findings \(no-readme 1, dumping-ground 1, no-header 1, config-comment 1\)$/);
});

test('usage errors exit 2: no command, no folder, missing folder, bad flag, --base without --changed', () => {
  const root = project({ 'a.txt': 'x' });
  for (const args of [[], ['check'], ['check', join(root, 'missing')], ['check', root, '--wat'], ['check', root, '--base', 'main'], ['check', root, '--changed', '--base']]) {
    const result = readable(args);
    assert.equal(result.status, 2, args.join(' '));
    assert.notEqual(result.stderr, '', args.join(' '));
  }
});

test('--changed outside a git repo exits 2 and says why', () => {
  const result = readable(['check', project({ 'a.txt': 'x' }), '--changed']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /git/);
});

test('.gitignore, vendored and generated folders, lock files and generated files are skipped', () => {
  const root = project({
    '.gitignore': 'generated-out/\n*.tmp.mjs\n',
    'generated-out/misc/a.mjs': 'x();\n', 'a.tmp.mjs': 'x();\n', 'node_modules/utils/a.mjs': 'x();\n', 'vendor/b/a.mjs': 'x();\n',
    'pnpm-lock.yaml': 'packages:\n  /foo@1.0.0:\n    resolution: x\n', 'api.gen.ts': 'x();\n', 'types.d.ts': 'x\n',
  });
  assert.equal(readable(['check', root]).stdout.trim(), 'readable: ok');
});

test('the .gitignore of a parent folder applies when a subfolder is checked', () => {
  const root = project({ '.gitignore': 'gen/\n', 'apps/web/gen/x/a.mjs': 'x();\n', 'apps/web/src/b.mjs': HEADER });
  commitAll(root);
  assert.equal(readable(['check', join(root, 'apps/web')]).stdout.trim(), 'readable: ok');
});

test('framework layouts are not findings: Maven packages, Next.js routes, Rails helpers, workspace packages, i18n files', () => {
  const root = project({
    'app/src/main/java/com/acme/common/billing/Invoice.java': '// Purpose: x\nclass Invoice {}\n',
    'apps/web/src/app/(shop)/orders/[id]/edit/page.tsx': '// Purpose: x\nexport {};\n',
    'apps/web/src/app/invoices/new/page.tsx': '// Purpose: x\nexport {};\n',
    'app/helpers/format.rb': '# Purpose: x\n', 'packages/shared/index.ts': '// Purpose: x\n', 'packages/common/index.ts': '// Purpose: x\n',
    'public/locales/en/common.json': '{}\n', 'config/locales/en.yml': 'en:\n  hello: Hi\n', 'views/invoices/new.html.erb': '<p>x</p>\n',
  });
  assert.equal(readable(['check', root]).stdout.trim(), 'readable: ok');
});

test('ci workflow step keys uses and run are not findings, other uncommented keys still are', () => {
  const root = project({ '.github/workflows/ci.yml': '# CI\njobs:\n  test:\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm test\n' });
  assert.equal(readable(['check', root]).status, 0);
  write(root, { '.github/workflows/other.yml': 'retries: 3\n' });
  assert.equal(readable(['check', root]).status, 1);
});

test('the local allow-list silences a name; it needs a reason', () => {
  const files = { 'data/rows.json': '[]\n' };
  const local = project({ ...files, '.claude/readable.local.json': '{"allow":[{"path":"./data/","reason":"hand-edited fixtures"}]}' });
  assert.equal(readable(['check', local]).status, 0);
  const team = project({ ...files, '.readable.json': '{"allow":[{"path":"data","reason":"fixtures"}]}' });
  assert.equal(readable(['check', team]).status, 0);
  assert.equal(readable(['check', project(files)]).status, 1);
});

test('a malformed allow-list, an entry without a reason or a path, or an unknown key is a usage error (exit 2)', () => {
  const bad = ['{nope', '{"allow":[{"path":"data"}]}', '{"allow":[{"path":"data","reason":" "}]}', '{"allow":[{"reason":"r"}]}',
    '{"alow":[{"path":"data","reason":"r"}]}', '{"allow":"data"}', '[]'];
  for (const text of bad) {
    for (const file of ['.claude/readable.local.json', '.readable.json']) {
      const result = readable(['check', project({ 'data/rows.json': '[]\n', [file]: text })]);
      assert.equal(result.status, 2, `${file} ${text}`);
      assert.match(result.stderr, new RegExp(file.replace('.', '\\.')));
    }
  }
});

test('git variables from a surrounding hook do not redirect --changed to another repository', () => {
  const root = project({ 'a.mjs': 'legacy();\n' });
  commitAll(root);
  const other = project({ 'z.mjs': HEADER });
  commitAll(other);
  write(root, { 'b.mjs': 'run();\n' });
  const result = readable(['check', root, '--changed'], { GIT_DIR: join(other, '.git'), GIT_INDEX_FILE: join(other, '.git', 'index') });
  assert.match(result.stdout, /^b\.mjs:1 C26/m);
  assert.doesNotMatch(result.stdout, /a\.mjs|z\.mjs/);
});

test('a crash exits 3, not 1, so it is never mistaken for findings', () => {
  if (process.getuid?.() === 0) return; // root can read any folder, so the fixture cannot fail
  const root = project({ 'a.mjs': HEADER });
  mkdirSync(join(root, 'locked'));
  chmodSync(join(root, 'locked'), 0o000);
  try {
    const result = readable(['check', root]);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /readable: crashed/);
  } finally {
    chmodSync(join(root, 'locked'), 0o755);
  }
});

test('inside a git repo the list comes from git: a path ignored only by .git/info/exclude is not reported', () => {
  const root = project({ 'a.mjs': HEADER, 'agent-trees/misc/b.mjs': 'x();\n' });
  git(root, 'init', '-q', '-b', 'main');
  assert.equal(readable(['check', root]).status, 1, 'not ignored yet');
  writeFileSync(join(root, '.git', 'info', 'exclude'), 'agent-trees/\n');
  assert.equal(readable(['check', root]).stdout.trim(), 'readable: ok');
});

test('inside a git repo, new untracked files that are not ignored are still reported', () => {
  const root = project({ 'a.mjs': HEADER, '.gitignore': 'secret/\n' });
  commitAll(root);
  write(root, { 'fresh.mjs': 'x();\n', 'secret/hidden.mjs': 'x();\n' });
  const out = readable(['check', root]).stdout;
  assert.match(out, /^fresh\.mjs:1 C26 no-header/m);
  assert.doesNotMatch(out, /hidden/);
});

test('a nested folder with its own .git (a linked worktree or another repo) is never entered, in a repo or outside one', () => {
  const files = { 'a.mjs': HEADER, 'nested/.git': 'gitdir: /elsewhere\n', 'nested/misc/b.mjs': 'x();\n' };
  assert.equal(readable(['check', project(files)]).stdout.trim(), 'readable: ok');
  const inRepo = project(files);
  git(inRepo, 'init', '-q', '-b', 'main');
  assert.equal(readable(['check', inRepo]).stdout.trim(), 'readable: ok');
});
