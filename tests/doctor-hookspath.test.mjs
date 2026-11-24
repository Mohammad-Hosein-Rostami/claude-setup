// Tests for the doctor check check_git_hooks_path (scripts/doctor/checks-setup.sh, DOCTOR_ONLY mode): the setup repo's commit hook
// (the gitleaks scan) runs only while core.hooksPath is .githooks, so doctor FAILs otherwise and names the command that fixes it.
// Exports: none (node:test file). doctor.sh and scripts/doctor/ are copied into a fresh git repo in a temp folder (doctor checks
// the repo it sits in); the global and system git config are left out, so the machine's own git config cannot change the result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './temp-dir-helpers.mjs';

const SCRIPTS = fileURLToPath(new URL('../scripts', import.meta.url));
const FIX_LINE = 'git config core.hooksPath .githooks';

/** A git repo holding a copy of doctor (with a space in its path), and an env with no global or system git config. */
function setupRepo() {
  const root = makeTempDir('doctor hookspath ');
  const repo = join(root, 'setup repo');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  cpSync(join(SCRIPTS, 'doctor.sh'), join(repo, 'scripts', 'doctor.sh'));
  cpSync(join(SCRIPTS, 'doctor'), join(repo, 'scripts', 'doctor'), { recursive: true });
  const emptyConfig = join(root, 'empty-gitconfig');
  writeFileSync(emptyConfig, '');
  const env = { ...process.env, HOME: root, USERPROFILE: root, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1', DOCTOR_ONLY: 'check_git_hooks_path' };
  assert.equal(spawnSync('git', ['init', '-q', repo], { env }).status, 0);
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' });
  const doctor = () => spawnSync('bash', [join(repo, 'scripts', 'doctor.sh')], { env, encoding: 'utf8' });
  return { git, doctor };
}

test('core.hooksPath unset in the setup repo: doctor FAILs and names git config core.hooksPath .githooks', () => {
  const { doctor } = setupRepo();
  const run = doctor();
  assert.equal(run.status, 1, run.stdout + run.stderr);
  const fail = run.stdout.split('\n').find((line) => line.startsWith('FAIL  '));
  assert.ok(fail?.includes('git hooksPath is not set') && fail.includes(FIX_LINE), run.stdout);
});

test('core.hooksPath set to another folder: doctor FAILs and names the value and the fix', () => {
  const { git, doctor } = setupRepo();
  git('config', 'core.hooksPath', '.git/hooks');
  const run = doctor();
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /^FAIL {2}git hooksPath is \.git\/hooks in .*: commits there run no secret scan; run in .*: git config core\.hooksPath \.githooks/m);
});

test('core.hooksPath is .githooks: one ok line, exit 0', () => {
  const { git, doctor } = setupRepo();
  git('config', 'core.hooksPath', '.githooks');
  const run = doctor();
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout.trim(), /^ok {4}git hooksPath = \.githooks in .*setup repo \(commits run the secret scan\)$/);
});
