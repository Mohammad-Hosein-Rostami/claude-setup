// Tests for home/tools/readable/lib: each check has a failing and a passing fixture, the .gitignore matcher, the allow-list
// (a reason is required), the diff parser and the report text. Fixtures are plain strings and path lists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAllowList } from '../home/tools/readable/lib/allow.mjs';
import { configKind, findUncommentedKeys } from '../home/tools/readable/lib/config-comments.mjs';
import { parseDiffAddedLines } from '../home/tools/readable/lib/git-changes.mjs';
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

test('dumping-ground: bare names of files and folders are findings, with or without an extension', () => {
  const files = ['src/utils/format.js', 'src/misc.ts', 'src/helpers.test.ts', 'src/data.json', 'lib/old/x.js'];
  assert.deepEqual(checks(findDumpingNames(files)).sort(), [
    'dumping-ground:lib/old/', 'dumping-ground:src/data.json', 'dumping-ground:src/helpers.test.ts', 'dumping-ground:src/misc.ts', 'dumping-ground:src/utils/',
  ]);
});

test('dumping-ground: names that only contain the word, and domain names, pass', () => {
  assert.deepEqual(findDumpingNames(['src/billing/invoice.js', 'src/shared-mailbox/send.js', 'src/metadata.json', 'src/utilities.js']), []);
});

test('dumping-ground: an allow-listed path passes, a different path with the same name does not', () => {
  const files = ['src/data/a.json', 'lib/data/b.json'];
  assert.deepEqual(checks(findDumpingNames(files, new Set(['src/data']))), ['dumping-ground:lib/data/']);
});

test('allow-list: an entry needs a path and a reason; a missing reason is reported and not applied', () => {
  const ok = parseAllowList('{"allow":[{"path":"src/data/","reason":"fixtures"}]}');
  assert.deepEqual([...ok.allowed], ['src/data']);
  const noReason = parseAllowList('{"allow":[{"path":"src/data"},{"path":"x","reason":"  "},{"reason":"r"}]}');
  assert.equal(noReason.allowed.size, 0);
  assert.equal(noReason.problems.length, 3);
  assert.match(parseAllowList('{nope').problems[0], /not valid JSON/);
  assert.deepEqual(parseAllowList(null), { allowed: new Set(), problems: [] });
});

test('deep-nesting: six folders is a finding (one per folder), five is fine', () => {
  const deep = ['a/b/c/d/e/f/one.js', 'a/b/c/d/e/f/two.js'];
  assert.deepEqual(checks(findDeepNesting(deep)), ['deep-nesting:a/b/c/d/e/f/']);
  assert.deepEqual(findDeepNesting(['a/b/c/d/e/one.js', 'top.js']), []);
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

test('diff parser: added line ranges per file, deleted files and zero-length hunks are skipped', () => {
  const diff = ['diff --git a/x.yml b/x.yml', '--- a/x.yml', '+++ b/x.yml', '@@ -1,2 +3,2 @@', '@@ -9 +12 @@', '@@ -5,2 +6,0 @@',
    'diff --git a/gone b/gone', '--- a/gone', '+++ /dev/null', '@@ -1 +0,0 @@'].join('\n');
  assert.deepEqual([...parseDiffAddedLines(diff)], [['x.yml', new Set([3, 4, 12])]]);
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
