// Tests for scripts/install.sh (which runs scripts/install.mjs) now that workflows are gone (2026-11-22): no `workflows` link,
// Workflow turned off in settings.json (disableWorkflows and the env switch, no deny rule), and the removed `--project-workflows <repo> [--copy]` options refused.
// Exports: none (node:test file). Runs the real installer with HOME set to a temp folder and --no-plugins --no-tools,
// so nothing outside the temp folder changes.
// Skips with a reason when jq is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { cleanEnv } from './clean-env.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const skip = spawnSync('jq', ['--version']).status === 0 ? false : 'jq not installed';

function install(flags) {
  const home = makeTempDir('install-wf-');
  const project = join(home, 'project');
  mkdirSync(project);
  spawnSync('git', ['init', '-q', project]);
  const run = spawnSync('bash', [join(REPO, 'scripts', 'install.sh'), '--no-plugins', '--no-tools', ...flags(project)], { env: cleanEnv({ HOME: home }), encoding: 'utf8' });
  return { home, project, run };
}

const linkExists = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

test('install no longer links home/workflows as ~/.claude/workflows', { skip }, () => {
  const { home, run } = install(() => []);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(linkExists(join(home, '.claude', 'workflows')), false);
});

test('settings.json turns Workflow off (disableWorkflows and the env switch, no allow, no extra folder) and keeps the status line refresh', { skip }, () => {
  const { home } = install(() => []);
  const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.disableWorkflows, true);
  assert.equal(settings.env.CLAUDE_CODE_DISABLE_WORKFLOWS, '1');
  assert.ok(!settings.permissions.allow.includes('Workflow'));
  assert.ok(!(settings.permissions.additionalDirectories ?? []).includes(join(home, '.claude', 'workflows')));
  assert.equal(settings.statusLine.refreshInterval, 5);
});

test('--project-workflows and --copy are refused: exit 2, a message that workflows are gone, and no link in the project', { skip }, () => {
  for (const flags of [(project) => ['--project-workflows', project], (project) => ['--project-workflows', project, '--copy'], () => ['--copy']]) {
    const { project, run } = install(flags);
    assert.equal(run.status, 2, run.stdout + run.stderr);
    assert.match(run.stderr, /was removed: workflows are gone/);
    assert.equal(existsSync(join(project, '.claude', 'workflows')), false);
  }
});
