// Tests for scripts/lane-new.sh: worktree + branch next to the main checkout, npm ci in the tools install.mjs lists, refusals.
// A throwaway repo holds copies of the script and a stub install.mjs; a stub `npm` on PATH records its calls (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './temp-dir-helpers.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/lane-new.sh', import.meta.url));
const INSTALL = readFileSync(fileURLToPath(new URL('../scripts/install.mjs', import.meta.url)), 'utf8');
const INSTALL_PS1 = readFileSync(fileURLToPath(new URL('../scripts/install.ps1', import.meta.url)), 'utf8');
const TOOLS_LINE = /^export const TOOLS_WITH_DEPS = \[('[a-z-]+'(?:, '[a-z-]+')*)\];$/m;
const skip = process.platform === 'win32' && 'bash script';
const GIT_IDENTITY = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_IDENTITY } });

/** A repo `<parent>/claude-setup` on branch main with the script, an install.mjs listing two tools, and a lockfile for one. */
function makeRepo() {
  const parent = realpathSync(makeTempDir('lane-new-'));
  const repo = join(parent, 'claude-setup');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  mkdirSync(join(repo, 'home', 'tools', 'with-lock'), { recursive: true });
  mkdirSync(join(repo, 'home', 'tools', 'no-lock'), { recursive: true });
  copyFileSync(SCRIPT, join(repo, 'scripts', 'lane-new.sh'));
  writeFileSync(join(repo, 'scripts', 'install.mjs'), "export const TOOLS_WITH_DEPS = ['with-lock', 'no-lock'];\n");
  writeFileSync(join(repo, 'home', 'tools', 'with-lock', 'package-lock.json'), '{}\n');
  writeFileSync(join(repo, 'home', 'tools', 'no-lock', 'package.json'), '{}\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  const bin = join(parent, 'bin');
  mkdirSync(bin);
  const calls = join(parent, 'npm-calls.txt');
  // `npm ci` fails for any folder named in FAIL_TOOL, like a lockfile that does not match
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "$@" >> "${calls}"\ncase "$*" in *"/$FAIL_TOOL") echo "npm ERR! stub failure" >&2; exit 1;; esac\n`);
  chmodSync(join(bin, 'npm'), 0o755);
  return { parent, repo, bin, calls };
}

const lane = ({ repo, bin }, ...args) =>
  spawnSync('bash', [join(repo, 'scripts', 'lane-new.sh'), ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...GIT_IDENTITY } });

test('install.mjs keeps the one list of tools with dependencies that lane-new.sh reads', { skip }, () => {
  assert.match(INSTALL, TOOLS_LINE);
});

test('install.ps1 keeps no tool list of its own: it calls install.mjs, which holds TOOLS_WITH_DEPS', () => {
  assert.match(INSTALL.match(TOOLS_LINE)[1], /'ui-check'/);
  assert.doesNotMatch(INSTALL_PS1, /Install-OneToolDeps|TOOLS_WITH_DEPS/);
  assert.match(INSTALL_PS1, /scripts\\install\.mjs/);
});

test('creates ../claude-setup-wt/<name> on lane/<name>, runs npm ci only where a lockfile exists, prints the path last', { skip }, () => {
  const ctx = makeRepo();
  const r = lane(ctx, 'x1');
  const path = join(ctx.parent, 'claude-setup-wt', 'x1');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), path);
  assert.equal(git(path, 'branch', '--show-current').stdout.trim(), 'lane/x1');
  assert.equal(readFileSync(ctx.calls, 'utf8').trim(), `ci --prefix ${path}/home/tools/with-lock`);
});

test('a second lane started from inside the first still lands next to the main checkout, on the base given', { skip }, () => {
  const ctx = makeRepo();
  assert.equal(lane(ctx, 'x1').status, 0);
  git(ctx.repo, 'branch', 'other', 'main');
  const first = join(ctx.parent, 'claude-setup-wt', 'x1');
  const r = spawnSync('bash', [join(first, 'scripts', 'lane-new.sh'), 'x2', 'other'], { encoding: 'utf8', env: { ...process.env, PATH: `${ctx.bin}:${process.env.PATH}`, ...GIT_IDENTITY } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), join(ctx.parent, 'claude-setup-wt', 'x2'));
});

test('refuses an existing branch, an existing folder and a bad name, and changes nothing', { skip }, () => {
  const ctx = makeRepo();
  git(ctx.repo, 'branch', 'lane/taken');
  const taken = lane(ctx, 'taken');
  assert.equal(taken.status, 1);
  assert.match(taken.stderr, /branch lane\/taken already exists/);
  assert.equal(existsSync(join(ctx.parent, 'claude-setup-wt', 'taken')), false);
  mkdirSync(join(ctx.parent, 'claude-setup-wt', 'there'), { recursive: true });
  const there = lane(ctx, 'there');
  assert.equal(there.status, 1);
  assert.match(there.stderr, /folder .* already exists/);
  assert.equal(git(ctx.repo, 'branch', '--list', 'lane/there').stdout.trim(), '');
  for (const bad of [[], ['../evil'], ['-x'], ['a b']]) assert.equal(lane(ctx, ...bad).status, 2, bad.join(' '));
  assert.equal(existsSync(ctx.calls), false);
});

test('a failing npm ci prints what is half made and how to finish or remove it, exits non-zero, deletes nothing', { skip }, () => {
  const ctx = makeRepo();
  const r = spawnSync('bash', [join(ctx.repo, 'scripts', 'lane-new.sh'), 'f1'], { encoding: 'utf8', env: { ...process.env, PATH: `${ctx.bin}:${process.env.PATH}`, FAIL_TOOL: 'with-lock', ...GIT_IDENTITY } });
  const path = join(ctx.parent, 'claude-setup-wt', 'f1');
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, '', 'the path is printed only for a lane that is ready');
  assert.match(r.stderr, /lane not ready: npm ci failed for with-lock/);
  assert.ok(r.stderr.includes(path));
  assert.ok(r.stderr.includes(`npm ci --prefix ${path}/home/tools/with-lock`));
  assert.ok(r.stderr.includes(`git worktree remove ${path}`));
  assert.ok(r.stderr.includes('git branch -D lane/f1'));
  assert.equal(existsSync(path), true);
  assert.equal(git(ctx.repo, 'branch', '--list', '--format=%(refname:short)', 'lane/f1').stdout.trim(), 'lane/f1');
});

test('a base that starts with a dash or names nothing is refused before anything is created', { skip }, () => {
  const ctx = makeRepo();
  for (const base of ['--quiet', '-b', 'no-such-ref']) {
    const r = lane(ctx, 'q1', base);
    assert.equal(r.status, 2, base);
    assert.match(r.stderr, /unknown base|usage/, base);
  }
  assert.equal(existsSync(join(ctx.parent, 'claude-setup-wt', 'q1')), false);
  assert.equal(git(ctx.repo, 'branch', '--list', 'lane/q1').stdout.trim(), '');
});
