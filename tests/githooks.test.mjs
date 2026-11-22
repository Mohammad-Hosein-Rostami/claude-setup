// Tests for .githooks/pre-commit, run through real `git commit` in a throw-away repo that holds a copy of the hook. The hook is the
// safety floor only: gitleaks on the staged changes and `node --check` on each staged hook file under home/hooks/. It runs no test.
// gitleaks is a stub on PATH (the real one is not what is tested here).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLEAN_ENV, git, makeRepo } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const skip = process.platform === 'win32' && 'bash hooks';
const { NODE_TEST_CONTEXT: _outerRunner, ...OUTSIDE_A_TEST_RUN } = CLEAN_ENV; // else a node child reports to this run

function write(repo, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
}

/** A repo on branch feat with the hook installed (core.hooksPath), two hook files and a test file that fails if it ever runs. */
function makeHookRepo({ gitleaksExit = 0 } = {}) {
  const repo = makeRepo();
  const bin = realpathSync(makeTempDir('githooks-bin-'));
  writeFileSync(join(bin, 'gitleaks'), `#!/bin/sh\nexit ${gitleaksExit}\n`);
  chmodSync(join(bin, 'gitleaks'), 0o755);
  cpSync(join(ROOT, '.githooks'), join(repo, '.githooks'), { recursive: true });
  write(repo, {
    'home/hooks/a.mjs': 'export const a = 1;\n',
    'home/hooks/lib/b.mjs': 'export const b = 1;\n',
    'tests/a.test.mjs': "import test from 'node:test';\ntest('a', () => { throw new Error('a test ran in the commit hook'); });\n",
  });
  git(repo, 'config', 'core.hooksPath', '.githooks');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '--no-verify', '-m', 'seed');
  git(repo, 'switch', '-q', '-c', 'feat');
  const env = { ...OUTSIDE_A_TEST_RUN, PATH: `${bin}:${process.env.PATH}` };
  const sh = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', env });
  return { repo, sh };
}

test('pre-commit lets a commit of a hook file that parses through, and runs no test', { skip }, () => {
  const { repo, sh } = makeHookRepo();
  writeFileSync(join(repo, 'home/hooks/a.mjs'), 'export const a = 2;\n');
  git(repo, 'add', 'home/hooks/a.mjs');
  const result = sh('commit', '-q', '-m', 'change a');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(git(repo, 'log', '--format=%s', '-1'), 'change a');
});

test('pre-commit blocks a hook file that does not parse, in a folder below home/hooks too, and names the file', { skip }, () => {
  const { repo, sh } = makeHookRepo();
  for (const file of ['home/hooks/a.mjs', 'home/hooks/lib/b.mjs']) {
    writeFileSync(join(repo, file), 'export const = ;\n');
    git(repo, 'add', file);
    const blocked = sh('commit', '-q', '-m', `break ${file}`);
    assert.notEqual(blocked.status, 0, file);
    assert.match(blocked.stderr, new RegExp(`pre-commit: ${file.replace(/\./g, '\\.')} does not parse`), file);
    assert.equal(git(repo, 'log', '--format=%s', '-1'), 'seed', file);
    git(repo, 'restore', '--staged', '--worktree', file);
  }
});

test('pre-commit checks the staged text, not the working copy', { skip }, () => {
  const { repo, sh } = makeHookRepo();
  writeFileSync(join(repo, 'home/hooks/a.mjs'), 'export const = ;\n');
  git(repo, 'add', 'home/hooks/a.mjs');
  writeFileSync(join(repo, 'home/hooks/a.mjs'), 'export const a = 9;\n');
  assert.notEqual(sh('commit', '-q', '-m', 'staged text is broken').status, 0);
});

test('pre-commit does not parse-check files outside home/hooks', { skip }, () => {
  const { repo, sh } = makeHookRepo();
  write(repo, { 'scripts/odd.mjs': 'export const = ;\n', 'docs/notes.md': '# notes\n' });
  git(repo, 'add', '.');
  const result = sh('commit', '-q', '-m', 'docs and a script');
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('pre-commit stops the commit when gitleaks finds something', { skip }, () => {
  const { repo, sh } = makeHookRepo({ gitleaksExit: 1 });
  writeFileSync(join(repo, 'home/hooks/a.mjs'), 'export const a = 4;\n');
  git(repo, 'add', 'home/hooks/a.mjs');
  assert.notEqual(sh('commit', '-q', '-m', 'leak').status, 0);
  assert.equal(git(repo, 'log', '--format=%s', '-1'), 'seed');
});
