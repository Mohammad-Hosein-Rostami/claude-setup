// Tests for home/tools/readable/lib: each check has a failing and a passing fixture, the .gitignore matcher, the allow-list
// (a reason is required), the diff parser and the report text. Fixtures are plain strings and path lists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAllowList } from '../home/tools/readable/lib/allow.mjs';
import { UsageError } from '../home/tools/readable/lib/errors.mjs';
import { countedDepth, isFrameworkFolder, isLockOrGenerated, isLocaleFile } from '../home/tools/readable/lib/exemptions.mjs';
import { configKind, findUncommentedKeys } from '../home/tools/readable/lib/config-comments.mjs';
import { parseDiff } from '../home/tools/readable/lib/git-changes.mjs';
import { findMissingHeader } from '../home/tools/readable/lib/header-check.mjs';
import { matchRules, parseGitignore } from '../home/tools/readable/lib/ignore.mjs';
import { formatReport } from '../home/tools/readable/lib/report.mjs';
import { findDeepNesting, findDumpingNames, findMissingReadmes } from '../home/tools/readable/lib/structure-checks.mjs';

const checks = (findings) => findings.map((f) => `${f.check}:${f.path}`);

test('no-readme: three source files and no README is a finding', () => {
  const files = ['app/a.js', 'app/b.js', 'app/c.ts', 'app/notes.txt'];
  assert.deepEqual(checks(findMissingReadmes(files)), ['no-readme:app/']);
});

test('no-readme: a README, or fewer than three source files, passes', () => {
  assert.deepEqual(findMissingReadmes(['app/a.js', 'app/b.js', 'app/c.js', 'app/README.md']), []);
  assert.deepEqual(findMissingReadmes(['app/a.js', 'app/b.js', 'app/data.json', 'app/x.css']), []);
  assert.deepEqual(findMissingReadmes(['app/a.js', 'app/b.js', 'app/c.js', 'app/readme.rst']), []);
});

test('no-readme: declaration files do not count as source and a source file in a subfolder counts for that subfolder', () => {
  assert.deepEqual(findMissingReadmes(['t/a.d.ts', 't/b.d.ts', 't/c.d.ts']), []);
  assert.deepEqual(checks(findMissingReadmes(['a.js', 'b.js', 'c.js'])), ['no-readme:./']);
});

test('dumping-ground: bare folder names and file names like utils or helpers are findings', () => {
  const files = ['src/utils/format.js', 'src/misc.ts', 'src/helpers.test.ts', 'src/data/a.json', 'lib/old/x.js'];
  assert.deepEqual(checks(findDumpingNames(files)).sort(), [
    'dumping-ground:lib/old/', 'dumping-ground:src/data/', 'dumping-ground:src/helpers.test.ts', 'dumping-ground:src/misc.ts', 'dumping-ground:src/utils/',
  ]);
  assert.equal(findDumpingNames(['src/utils/a.js'])[0].message, 'Folder name "utils" says nothing about what is inside.');
});

test('dumping-ground: domain names pass, and so do file names new, old, data, common and shared', () => {
  assert.deepEqual(findDumpingNames(['src/billing/invoice.js', 'src/shared-mailbox/send.js', 'src/metadata.json', 'src/utilities.js',
    'views/new.html.erb', 'src/data.json', 'locales/en/common.json', 'src/shared.ts']), []);
});

test('dumping-ground: framework folders pass (Rails helpers, route new, packages/shared, Maven packages)', () => {
  const files = ['app/helpers/a.rb', 'src/app/invoices/new/page.tsx', 'packages/shared/a.ts', 'packages/common/a.ts', 'x/src/main/java/com/acme/util/A.java'];
  assert.deepEqual(findDumpingNames(files), []);
  assert.equal(findDumpingNames(['lib/helpers/a.rb', 'new/a.ts', 'src/shared/a.ts']).length, 3);
});

test('dumping-ground: an allow-listed path passes, a different path with the same name does not', () => {
  const files = ['src/data/a.json', 'lib/data/b.json'];
  assert.deepEqual(checks(findDumpingNames(files, new Set(['src/data']))), ['dumping-ground:lib/data/']);
});

test('allow-list: paths are read without ./ and trailing /; a missing reason, path, key or bad JSON throws UsageError', () => {
  assert.deepEqual(parseAllowList('{"allow":[{"path":"./src/data/","reason":"fixtures"}]}', 'f.json'), ['src/data']);
  for (const text of ['{"allow":[{"path":"a"}]}', '{"allow":[{"path":"a","reason":"  "}]}', '{"allow":[{"reason":"r"}]}', '{nope', '{"alow":[]}', '{"allow":"a"}', 'null']) {
    assert.throws(() => parseAllowList(text, 'f.json'), (error) => error instanceof UsageError && /f\.json/.test(error.message), text);
  }
});

test('exemptions: lock files, generated files and locale files', () => {
  for (const path of ['pnpm-lock.yaml', 'package-lock.json', 'a/yarn.lock', 'Cargo.lock', 'go.sum', 'api.gen.ts', 'x.pb.go', 'types.d.ts', 'a.min.js']) assert.equal(isLockOrGenerated(path), true, path);
  for (const path of ['src/lockdown.ts', 'config.yml', 'deck.js']) assert.equal(isLockOrGenerated(path), false, path);
  assert.equal(isLocaleFile('config/locales/en.yml'), true);
  assert.equal(isLocaleFile('config/app.yml'), false);
});

test('exemptions: counted depth skips Maven packages, folders below app/ or pages/, and (group) or [param] folders', () => {
  assert.equal(countedDepth(['a', 'b', 'c', 'd', 'e', 'f']), 6);
  assert.equal(countedDepth(['svc', 'src', 'main', 'java', 'com', 'acme', 'billing']), 4);
  assert.equal(countedDepth(['app', 'models', 'a', 'b', 'c', 'd', 'e']), 1);
  assert.equal(countedDepth(['apps', 'web', 'src', 'app', '(shop)', 'orders', '[id]', 'edit']), 4);
  assert.equal(countedDepth(['a', '(g)', '[id]', 'b']), 2);
  assert.equal(isFrameworkFolder('lib/helpers'), false);
});

test('deep-nesting: six folders is a finding (one per folder), five is fine', () => {
  const deep = ['a/b/c/d/e/f/one.js', 'a/b/c/d/e/f/two.js'];
  assert.deepEqual(checks(findDeepNesting(deep)), ['deep-nesting:a/b/c/d/e/f/']);
  assert.deepEqual(findDeepNesting(['a/b/c/d/e/one.js', 'top.js']), []);
  assert.deepEqual(findDeepNesting(['app/src/main/java/com/acme/billing/One.java', 'apps/web/src/app/(shop)/orders/[id]/edit/page.tsx']), []);
});

test('no-header: a file that starts with code is a finding, a leading comment passes', () => {
  assert.equal(findMissingHeader('a.mjs', "import x from 'y';\n").length, 1);
  assert.deepEqual(findMissingHeader('a.mjs', '// Purpose: x\nimport x from "y";\n'), []);
  assert.deepEqual(findMissingHeader('a.ts', '/** Purpose */\nexport {};\n'), []);
  assert.equal(findMissingHeader('a.py', 'import os\n').length, 1);
  assert.deepEqual(findMissingHeader('a.py', '"""Purpose."""\nimport os\n'), []);
});

test('no-header: a shebang or directive may come first; empty files and other languages are not flagged', () => {
  assert.deepEqual(findMissingHeader('cli.mjs', '#!/usr/bin/env node\n// Purpose\n'), []);
  assert.deepEqual(findMissingHeader('a.js', "'use strict';\n// Purpose\n"), []);
  assert.equal(findMissingHeader('cli.mjs', '#!/usr/bin/env node\nimport x from "y";\n').length, 1);
  assert.deepEqual(findMissingHeader('a.mjs', '\n\n'), []);
  assert.deepEqual(findMissingHeader('x.lua', 'print(1)\n'), []);
});

test('config-comment: kinds are yaml, toml, ini and example env files; json and real .env are exempt', () => {
  assert.deepEqual(['a.yml', 'a.yaml', 'a.toml', 'a.ini', '.env.example', 'api/.env.sample', 'local.env.example'].map(configKind), ['yaml', 'yaml', 'toml', 'ini', 'env', 'env', 'env']);
  assert.deepEqual(['a.json', '.env', 'a.js'].map(configKind), [null, null, null]);
  assert.deepEqual(findUncommentedKeys('a.json', '{"a": 1}', null), []);
});

test('config-comment: yaml keys without a comment are findings with their line number', () => {
  const found = findUncommentedKeys('ci.yml', 'name: build\nretries: 3\n', null);
  assert.deepEqual(found.map((f) => f.line), [1, 2]);
  assert.match(found[1].message, /"retries"/);
});

test('config-comment: an inline comment, a comment above, or a commented parent covers a yaml key', () => {
  const text = ['# why: vendor limit', 'retries: 3', 'timeout: 30 # seconds', '# the database', 'db:', '  host: x', '  port: 1'].join('\n');
  assert.deepEqual(findUncommentedKeys('a.yml', text, null), []);
});

test('config-comment: only the changed lines are checked when a set is given', () => {
  const text = 'old: 1\nnew: 2\n';
  assert.deepEqual(findUncommentedKeys('a.yml', text, new Set([2])).map((f) => f.line), [2]);
  assert.deepEqual(findUncommentedKeys('a.yml', text, new Set()), []);
});

test('config-comment: toml and ini sections, env blocks and ; comments', () => {
  assert.equal(findUncommentedKeys('a.toml', '[server]\nport = 1\n', null).length, 1);
  assert.deepEqual(findUncommentedKeys('a.toml', '# the server\n[server]\nport = 1\n', null), []);
  assert.equal(findUncommentedKeys('a.ini', '[a]\nk = v\n', null).length, 1);
  assert.deepEqual(findUncommentedKeys('a.ini', '; how long\ntimeout = 3\n', null), []);
  assert.deepEqual(findUncommentedKeys('.env.example', '# database\nDB_HOST=x\nDB_PORT=1\n', null), []);
  assert.equal(findUncommentedKeys('.env.example', 'DB_HOST=x\n\n# port\nDB_PORT=1\nOTHER=2\n', null).length, 1);
});

test('gitignore: patterns match like git (anchoring, folders only, negation, globs)', () => {
  const rules = parseGitignore('# c\nnode_modules/\n*.log\n/build\n!keep.log\ndocs/**/tmp\n');
  const ignored = (path, dir = false) => matchRules(rules, path, dir);
  assert.equal(ignored('a/node_modules', true), true);
  assert.equal(ignored('node_modules', false), null);
  assert.equal(ignored('a/b/x.log'), true);
  assert.equal(ignored('keep.log'), false);
  assert.equal(ignored('build', true), true);
  assert.equal(ignored('src/build', true), null);
  assert.equal(ignored('docs/a/b/tmp', true), true);
});

test('diff parser: added line numbers and deleted line texts per file; deleted files and zero-length hunks are skipped', () => {
  const diff = ['diff --git a/x.yml b/x.yml', '--- a/x.yml', '+++ b/x.yml', '@@ -1,2 +3,2 @@', '-old: 1', '-gone: 2', '+old: 2', '+new: 3', '@@ -9 +12 @@', '-k: v', '+k: w', '@@ -5,2 +6,0 @@',
    'diff --git a/gone b/gone', '--- a/gone', '+++ /dev/null', '@@ -1 +0,0 @@', '-x'].join('\n');
  assert.deepEqual([...parseDiff(diff)], [['x.yml', { lines: new Set([3, 4, 12]), removed: ['old: 1', 'gone: 2', 'k: v'] }]]);
});

test('config-comment: skips CI step keys, locale files, and keys whose line was only edited', () => {
  assert.deepEqual(findUncommentedKeys('ci.yml', 'steps:\n  - uses: a@1\n  - run: b\n  - name: c\n', null).map((f) => f.line), [1, 4]);
  assert.deepEqual(findUncommentedKeys('config/locales/en.yml', 'en:\n  hi: Hi\n', null), []);
  assert.deepEqual(findUncommentedKeys('a.yml', 'old: 2\nnew: 3\n', new Set([1, 2]), ['old: 1']).map((f) => f.line), [2]);
});

test('report: ok when empty; otherwise sorted lines and a count per check', () => {
  assert.equal(formatReport([]), 'readable: ok');
  const text = formatReport([
    { path: 'b.mjs', line: 1, rule: 'C26', check: 'no-header', message: 'm.', fix: 'f.' },
    { path: 'a/', line: 1, rule: 'C34', check: 'no-readme', message: 'm.', fix: 'f.' },
  ]).split('\n');
  assert.equal(text[0], 'a/:1 C34 no-readme: m. Fix: f.');
  assert.equal(text[2], 'readable: 2 findings (no-readme 1, no-header 1)');
});
