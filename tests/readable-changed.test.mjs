// Tests for `readable check --changed`: it reports only what the change ADDED. Each case commits a legacy tree, edits or adds
// files, and checks the report. Whole-tree mode (no --changed) stays an audit and is covered in readable-cli.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { commitAll, git, HEADER, project, readable, write } from './readable-helpers.mjs';

const legacy = () => {
  const root = project({
    'src/utils/a.ts': 'old();\n', 'data/customers.csv': 'a,b\n', 'app/src/main/java/com/acme/Invoice.java': 'class A {}\n',
    'src/legacy/x.ts': 'old();\n', 'src/legacy/y.ts': 'old();\n', 'src/legacy/z.ts': 'old();\n', 'legacy.yml': 'old: 1\n',
    'two/a.mjs': HEADER, 'two/b.mjs': HEADER,
  });
  commitAll(root);
  return root;
};
const changed = (root, ...extra) => readable(['check', root, '--changed', ...extra]);

test('editing a file in a legacy folder with a bad name, no README or no header reports nothing', () => {
  const root = legacy();
  assert.equal(readable(['check', root]).status, 1, 'the whole tree still sees the legacy findings');
  write(root, {
    'src/utils/a.ts': 'old();\nedited();\n', 'data/customers.csv': 'a,b\nc,d\n', 'app/src/main/java/com/acme/Invoice.java': 'class A { int x; }\n',
    'src/legacy/x.ts': 'old();\nedited();\n',
  });
  assert.equal(changed(root).stdout.trim(), 'readable: ok');
});

test('a legacy deep folder with an edited file reports nothing; an added file in it is reported', () => {
  const root = project({ 'a/b/c/d/e/f/old.mjs': HEADER });
  commitAll(root);
  write(root, { 'a/b/c/d/e/f/old.mjs': `${HEADER}edited();\n` });
  assert.equal(changed(root).stdout.trim(), 'readable: ok');
  write(root, { 'a/b/c/d/e/f/new.mjs': HEADER });
  assert.match(changed(root).stdout, /^a\/b\/c\/d\/e\/f\/:1 C32 deep-nesting/m);
});

test('a new file with a dumping-ground name or no header is reported; a new file with a plain name in an old folder is not', () => {
  const root = legacy();
  write(root, { 'src/utils/billing-total.ts': HEADER, 'src/legacy/helpers.ts': HEADER, 'src/legacy/misc.ts': 'x();\n' });
  const out = changed(root).stdout;
  assert.match(out, /^src\/legacy\/helpers\.ts:1 C32 dumping-ground/m);
  assert.match(out, /^src\/legacy\/misc\.ts:1 C32 dumping-ground/m);
  assert.match(out, /^src\/legacy\/misc\.ts:1 C26 no-header/m);
  assert.doesNotMatch(out, /billing-total|src\/utils\/:1|no-readme/);
});

test('a new folder with a dumping-ground name is reported; an old folder with the same name is not', () => {
  const root = legacy();
  write(root, { 'lib/utils/a.ts': HEADER });
  const out = changed(root).stdout;
  assert.match(out, /^lib\/utils\/:1 C32 dumping-ground/m);
  assert.doesNotMatch(out, /^src\/utils\//m);
});

test('no-readme: reported when the change creates the folder or adds its third source file, not for a folder already at three', () => {
  const root = legacy();
  write(root, { 'two/c.mjs': HEADER, 'src/legacy/w.ts': HEADER, 'fresh/a.mjs': HEADER, 'fresh/b.mjs': HEADER, 'fresh/c.mjs': HEADER });
  const out = changed(root).stdout;
  assert.match(out, /^two\/:1 C34 no-readme/m);
  assert.match(out, /^fresh\/:1 C34 no-readme/m);
  assert.doesNotMatch(out, /src\/legacy\/:1/);
});

test('deep-nesting and no-header are checked only for added files', () => {
  const root = legacy();
  write(root, { 'a/b/c/d/e/f/new.mjs': HEADER, 'a/b/c/d/e/f/headerless.mjs': 'x();\n', 'app/src/main/java/com/acme/billing/Other.java': '// Purpose: x\nclass B {}\n' });
  const out = changed(root).stdout;
  assert.match(out, /^a\/b\/c\/d\/e\/f\/:1 C32 deep-nesting/m);
  assert.match(out, /^a\/b\/c\/d\/e\/f\/headerless\.mjs:1 C26 no-header/m);
  assert.doesNotMatch(out, /Other\.java/);
});

test('config-comment: a new key is reported, an edited value of an old key is not', () => {
  const root = legacy();
  write(root, { 'legacy.yml': 'old: 2\nadded: 3\n' });
  const out = changed(root).stdout;
  assert.match(out, /^legacy\.yml:2 C35 config-comment: key "added"/m);
  assert.doesNotMatch(out, /"old"/);
  write(root, { 'legacy.yml': 'old: 4\n' });
  assert.equal(changed(root).stdout.trim(), 'readable: ok');
});

test('a changed lock file or ci step line is not reported', () => {
  const root = project({ 'pnpm-lock.yaml': 'packages:\n  /a@1:\n    resolution: x\n', '.github/workflows/ci.yml': '# CI\nsteps:\n  - run: a\n' });
  commitAll(root);
  write(root, { 'pnpm-lock.yaml': 'packages:\n  /a@2:\n    resolution: y\n', '.github/workflows/ci.yml': '# CI\nsteps:\n  - run: a\n  - uses: actions/checkout@v4\n' });
  assert.equal(changed(root).stdout.trim(), 'readable: ok');
});

test('--base compares with the given commit, including work committed on a branch', () => {
  const root = project({ 'a.mjs': HEADER });
  commitAll(root);
  git(root, 'checkout', '-q', '-b', 'feature');
  write(root, { 'b.mjs': 'run();\n' });
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'feature work');
  assert.match(changed(root).stdout, /^b\.mjs:1 C26/m);
  assert.match(changed(root, '--base', 'HEAD~1').stdout, /^b\.mjs:1 C26/m);
  assert.equal(changed(root, '--base', 'HEAD').stdout.trim(), 'readable: ok');
  assert.equal(changed(root, '--base', 'no-such-ref').status, 2);
});
