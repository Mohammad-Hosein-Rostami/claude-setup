// Tests for scripts/install.sh: the `workflows` link and the `--project-workflows <repo> [--copy]` option.
// Exports: none (node:test file). Runs the real installer with HOME set to a temp folder and --no-plugins --no-tools,
// so nothing outside the temp folder changes (the repo's own git hooksPath is set to the value it already has).
// Skips with a reason when jq is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, readlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './temp-dir-helpers.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const skip = spawnSync('jq', ['--version']).status === 0 ? false : 'jq not installed';

function install(flags) {
  const home = makeTempDir('install-wf-');
  const project = join(home, 'project');
  mkdirSync(project);
  spawnSync('git', ['init', '-q', project]);
  const run = spawnSync('bash', [join(REPO, 'scripts', 'install.sh'), '--no-plugins', '--no-tools', ...flags(project)], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  return { home, project, run };
}

test('install links home/workflows as ~/.claude/workflows', { skip }, () => {
  const { home, run } = install(() => []);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readlinkSync(join(home, '.claude', 'workflows')), join(REPO, 'home', 'workflows'));
});

test('settings.json lets Workflow read the link path and runs it without a dialog', { skip }, () => {
  const { home } = install(() => []);
  const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
  assert.ok(settings.permissions.allow.includes('Workflow'));
  assert.ok(settings.permissions.additionalDirectories.includes(join(home, '.claude', 'workflows')));
  assert.equal(settings.statusLine.refreshInterval, 30);
});

test('--project-workflows links the scripts into <repo>/.claude/workflows and hides the link from git', { skip }, () => {
  const { project, run } = install((p) => ['--project-workflows', p]);
  assert.equal(run.status, 0, run.stderr);
  const target = join(project, '.claude', 'workflows');
  assert.equal(readlinkSync(target), join(REPO, 'home', 'workflows'));
  assert.match(readFileSync(join(project, '.git', 'info', 'exclude'), 'utf8'), /^\.claude\/workflows$/m);
  const again = spawnSync('bash', [join(REPO, 'scripts', 'install.sh'), '--no-plugins', '--no-tools', '--project-workflows', project], { env: { ...process.env, HOME: join(project, '..') }, encoding: 'utf8' });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(join(project, '.git', 'info', 'exclude'), 'utf8').match(/^\.claude\/workflows$/gm).length, 1, 'the exclude line is added once');
});

test('--project-workflows --copy copies the scripts for the team to commit and leaves git alone', { skip }, () => {
  const { project, run } = install((p) => ['--project-workflows', p, '--copy']);
  assert.equal(run.status, 0, run.stderr);
  const target = join(project, '.claude', 'workflows');
  assert.equal(lstatSync(target).isSymbolicLink(), false);
  assert.ok(readdirSync(target).includes('bugfix.js'));
  assert.equal(existsSync(join(project, '.git', 'info', 'exclude')) && /workflows/.test(readFileSync(join(project, '.git', 'info', 'exclude'), 'utf8')), false);
});

test('--project-workflows needs a git repository and --copy needs --project-workflows', { skip }, () => {
  const plain = makeTempDir('install-wf-plain-');
  const home = makeTempDir('install-wf-home-');
  const notGit = spawnSync('bash', [join(REPO, 'scripts', 'install.sh'), '--no-plugins', '--no-tools', '--project-workflows', plain], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.equal(notGit.status, 2);
  assert.match(notGit.stderr, /not a git repository/);
  const copyOnly = spawnSync('bash', [join(REPO, 'scripts', 'install.sh'), '--no-plugins', '--no-tools', '--copy'], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.equal(copyOnly.status, 2);
  assert.match(copyOnly.stderr, /--copy needs --project-workflows/);
});
