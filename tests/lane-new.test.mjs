// Tests for scripts/lane-new.sh: worktree + branch next to the main checkout, npm ci in the tools install.sh lists, refusals.
// A throwaway repo holds copies of the script and a stub install.sh; a stub `npm` on PATH records its calls (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/lane-new.sh', import.meta.url));
const INSTALL = readFileSync(fileURLToPath(new URL('../scripts/install.sh', import.meta.url)), 'utf8');
const skip = process.platform === 'win32' && 'bash script';
const GIT_IDENTITY = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_IDENTITY } });

/** A repo `<parent>/claude-setup` on branch main with the script, an install.sh listing two tools, and a lockfile for one. */
function makeRepo() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'lane-new-')));
  const repo = join(parent, 'claude-setup');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  mkdirSync(join(repo, 'home', 'tools', 'with-lock'), { recursive: true });
  mkdirSync(join(repo, 'home', 'tools', 'no-lock'), { recursive: true });
  copyFileSync(SCRIPT, join(repo, 'scripts', 'lane-new.sh'));
  writeFileSync(join(repo, 'scripts', 'install.sh'), 'TOOLS_WITH_DEPS=(with-lock no-lock)\n');
  writeFileSync(join(repo, 'home', 'tools', 'with-lock', 'package-lock.json'), '{}\n');
  writeFileSync(join(repo, 'home', 'tools', 'no-lock', 'package.json'), '{}\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  const bin = join(parent, 'bin');
  mkdirSync(bin);
  const calls = join(parent, 'npm-calls.txt');
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "$@" >> "${calls}"\n`);
  chmodSync(join(bin, 'npm'), 0o755);
  return { parent, repo, bin, calls };
}

const lane = ({ repo, bin }, ...args) =>
  spawnSync('bash', [join(repo, 'scripts', 'lane-new.sh'), ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...GIT_IDENTITY } });

test('install.sh keeps the one list of tools with dependencies that lane-new.sh reads', { skip }, () => {
  assert.match(INSTALL, /^TOOLS_WITH_DEPS=\(ui-check env-names\)$/m);
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
