// Unit tests for the format trust of home/hooks/post-edit.mjs (lib/format-trust.mjs): which scripts count as one plain call of a known
// formatter (formatterCall, and what plannedChecks makes of them untrusted), and when CLAUDE_POST_EDIT_TRUST_FORMAT is trusted
// (trustedFormat: the value, a team file, a tracked or untracked local file, the package inside the session's project folder). The hook
// run itself is in post-edit-trust.test.mjs. Every project is a cs-test temp folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatterCall, plannedChecks, trustedFormat } from '../home/hooks/post-edit.mjs';
import { git } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const TRUST_ENV = 'CLAUDE_POST_EDIT_TRUST_FORMAT';
const EDITED = 'src/a.ts';
const TEAM = '.claude/settings.json';
const LOCAL = '.claude/settings.local.json';
const trustFile = (value = '1') => JSON.stringify({ env: { [TRUST_ENV]: value } });
const binOf = (tool) => `/bin/${tool}`; // a found node_modules/.bin binary
const IGNORED_BY_TEAM = new RegExp(`team switch ${TRUST_ENV} ignored: the team file .*settings\\.json sets it`);
const IGNORED_TRACKED_LOCAL = new RegExp(`team switch ${TRUST_ENV} ignored: .*settings\\.local\\.json sets it but git tracks that file`);

// Scripts that are more than one plain call of a known formatter (a chain, substitution, quote, pipe), or no known formatter call.
const REFUSED = [
  'prettier --write && node evil.js',
  'prettier; node evil.js',
  'prettier $(node evil.js)',
  'prettier `node evil.js`',
  'prettier --write\nnode evil.js',
  'prettier "x"',
  'prettier --write | cat',
  'eslint',
  'ruff check',
  'blackish',
  'node evil.js',
];
// Plain calls of a known formatter: the words the binary runs with.
const ACCEPTED = [
  ['eslint --fix', ['eslint', '--fix']],
  ['eslint src --fix', ['eslint', 'src', '--fix']],
  ['ruff format', ['ruff', 'format']],
  ['black', ['black']],
  ['prettier --write', ['prettier', '--write']],
];

test('formatterCall refuses chains, pipes, substitutions, quotes and calls that are no known formatter', () => {
  for (const script of REFUSED) assert.equal(formatterCall(script), null, JSON.stringify(script));
});

test('formatterCall accepts one plain call of a known formatter and returns its words', () => {
  for (const [script, words] of ACCEPTED) assert.deepEqual(formatterCall(script), words, script);
});

test('plannedChecks untrusted plans nothing for a refused script, and the tool binary with the file for an accepted one', () => {
  for (const script of REFUSED) assert.deepEqual(plannedChecks({ format: script }, EDITED, binOf), [], JSON.stringify(script));
  for (const [script, [tool, ...args]] of ACCEPTED) {
    assert.deepEqual(plannedChecks({ format: script }, EDITED, binOf), [{ name: 'format', cmd: binOf(tool), args: [...args, EDITED] }], script);
  }
});

test('plannedChecks untrusted runs an accepted formatter by its bare name on PATH when node_modules/.bin has none', () => {
  assert.deepEqual(plannedChecks({ format: 'black' }, 'a.py', () => null), [{ name: 'format', cmd: 'black', args: ['a.py'] }]);
});

/** A project folder (real path) holding `files` (path -> text); `gitMode` null, 'init' or 'commit'. */
function project(files = {}, gitMode = null) {
  const dir = realpathSync(makeTempDir('post-edit-trust-unit-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  if (gitMode !== null) git(dir, 'init', '-q');
  if (gitMode === 'commit') {
    git(dir, 'add', '-A');
    git(dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'team');
  }
  return dir;
}

test('trustedFormat: "1" from the shell trusts a package in the hook cwd or CLAUDE_PROJECT_DIR, or below it', () => {
  const dir = project({ 'pkg/package.json': '{}' }, 'init');
  assert.deepEqual(trustedFormat({ [TRUST_ENV]: '1' }, dir, dir), { trusted: true, ignored: null });
  assert.deepEqual(trustedFormat({ [TRUST_ENV]: '1' }, dir, join(dir, 'pkg')), { trusted: true, ignored: null });
  assert.deepEqual(trustedFormat({ [TRUST_ENV]: '1', CLAUDE_PROJECT_DIR: dir }, undefined, dir), { trusted: true, ignored: null });
});

test('trustedFormat: unset, or any value other than "1", is not trusted', () => {
  const dir = project({}, 'init');
  for (const env of [{}, { [TRUST_ENV]: 'true' }, { [TRUST_ENV]: '0' }, { [TRUST_ENV]: '' }, { [TRUST_ENV]: ' 1' }]) {
    assert.equal(trustedFormat(env, dir, dir).trusted, false, JSON.stringify(env));
  }
});

test('trustedFormat: a committed team file that sets it is ignored, also with the shell value; the reason names the team file', () => {
  const dir = project({ [TEAM]: trustFile() }, 'commit');
  const got = trustedFormat({ [TRUST_ENV]: '1' }, dir, dir);
  assert.equal(got.trusted, false);
  assert.match(got.ignored ?? '', IGNORED_BY_TEAM);
});

test('trustedFormat: a settings.local.json that git tracks is a team file; an untracked one is trusted', () => {
  const tracked = project({ [LOCAL]: trustFile() }, 'commit');
  const got = trustedFormat({ [TRUST_ENV]: '1' }, tracked, tracked);
  assert.equal(got.trusted, false);
  assert.match(got.ignored ?? '', IGNORED_TRACKED_LOCAL);
  const untracked = project({ [LOCAL]: trustFile() }, 'init');
  assert.deepEqual(trustedFormat({ [TRUST_ENV]: '1' }, untracked, untracked), { trusted: true, ignored: null });
});

test('trustedFormat: a package outside the session folders is not trusted (a trust set for one project never reaches another)', () => {
  const session = project({}, 'init');
  const elsewhere = project({ 'package.json': '{}' }, 'init');
  assert.equal(trustedFormat({ [TRUST_ENV]: '1' }, session, elsewhere).trusted, false, 'cwd is another folder');
  assert.equal(trustedFormat({ [TRUST_ENV]: '1', CLAUDE_PROJECT_DIR: session }, undefined, elsewhere).trusted, false, 'CLAUDE_PROJECT_DIR is another folder');
  assert.equal(trustedFormat({ [TRUST_ENV]: '1' }, undefined, elsewhere).trusted, false, 'no session folder at all');
  assert.equal(trustedFormat({ [TRUST_ENV]: '1' }, 'relative/dir', elsewhere).trusted, false, 'a relative cwd is no folder');
});

test('trustedFormat: a package folder reached through a link that points outside the project is not trusted', () => {
  const session = project({}, 'init');
  const outside = project({ 'package.json': '{}' });
  symlinkSync(outside, join(session, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); // a junction needs no admin right on Windows
  assert.equal(trustedFormat({ [TRUST_ENV]: '1' }, session, join(session, 'linked')).trusted, false);
});
