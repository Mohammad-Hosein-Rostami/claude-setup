// Tests for the doctor checks check_plugin_session_start, check_hook_files, check_workflows_gone, check_prod_hosts and
// check_doctor_accepted (scripts/doctor.sh, DOCTOR_ONLY mode).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { cleanEnv } from './clean-env.mjs';

const DOCTOR = fileURLToPath(new URL('../scripts/doctor.sh', import.meta.url));
const hasJq = spawnSync('jq', ['--version']).status === 0;
const skip = !hasJq && 'jq not installed';
const skipLink = skip || (process.platform === 'win32' && 'needs symlinks'); // the link test makes a symlink, which Windows may refuse (EPERM)
async function fakeHome({ plugin } = {}) {
  const home = makeTempDir('doctor-home-');
  const claude = join(home, '.claude');
  await mkdir(join(claude, 'plugins'), { recursive: true });
  const settings = { enabledPlugins: {} };
  const installed = { version: 2, plugins: {} };
  if (plugin) {
    const dir = join(home, 'plugin-cache', 'noisy');
    await mkdir(join(dir, 'hooks'), { recursive: true });
    await writeFile(join(dir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'x' }] }] } }));
    await writeFile(join(dir, 'hooks', 'session-start.sh'), plugin.text);
    settings.enabledPlugins['noisy@market'] = plugin.enabled;
    installed.plugins['noisy@market'] = [{ installPath: dir }];
  }
  await writeFile(join(claude, 'settings.json'), JSON.stringify(settings));
  await writeFile(join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify(installed));
  return home;
}

function doctor(home, checks) {
  return spawnSync('bash', [DOCTOR], { env: cleanEnv({ HOME: home, DOCTOR_ONLY: checks }), encoding: 'utf8' });
}

test('check_plugin_session_start warns about an enabled plugin that injects EXTREMELY_IMPORTANT', { skip }, async () => {
  const result = doctor(await fakeHome({ plugin: { enabled: true, text: '<EXTREMELY_IMPORTANT>rules</EXTREMELY_IMPORTANT>' } }), 'check_plugin_session_start');
  assert.match(result.stdout, /WARN\s+plugin noisy@market injects EXTREMELY_IMPORTANT/);
  assert.equal(result.status, 0); // a warning, not a failure
});

test('check_plugin_session_start is quiet about disabled plugins and clean hooks', { skip }, async () => {
  const disabled = doctor(await fakeHome({ plugin: { enabled: false, text: 'EXTREMELY_IMPORTANT' } }), 'check_plugin_session_start');
  assert.doesNotMatch(disabled.stdout, /WARN/);
  const clean = doctor(await fakeHome({ plugin: { enabled: true, text: 'echo hi' } }), 'check_plugin_session_start');
  assert.doesNotMatch(clean.stdout, /WARN/);
  assert.match(clean.stdout, /SessionStart hook without EXTREMELY_IMPORTANT/);
});

test('check_hook_files also covers hook files named in agent frontmatter', { skip }, async () => {
  const repo = makeTempDir('doctor-repo-');
  await mkdir(join(repo, 'scripts'), { recursive: true });
  await mkdir(join(repo, 'settings'), { recursive: true });
  await mkdir(join(repo, 'home', 'hooks'), { recursive: true });
  await mkdir(join(repo, 'home', 'agents'), { recursive: true });
  await cp(DOCTOR, join(repo, 'scripts', 'doctor.sh'));
  await writeFile(join(repo, 'settings', 'base.json'), '{}');
  await writeFile(join(repo, 'home', 'agents', 'a.md'), '---\nhooks:\n  PreToolUse:\n    - hooks:\n        - command: node "$HOME/.claude/hooks/gone.mjs"\n---\n');
  const run = () => spawnSync('bash', [join(repo, 'scripts', 'doctor.sh')], { env: cleanEnv({ HOME: repo, DOCTOR_ONLY: 'check_hook_files' }), encoding: 'utf8' });
  const missing = run();
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /FAIL\s+agent frontmatter hook file missing: home\/hooks\/gone\.mjs/);
  await writeFile(join(repo, 'home', 'hooks', 'gone.mjs'), '// stub\n');
  const present = run();
  assert.equal(present.status, 0);
  assert.match(present.stdout, /ok\s+hook files referenced by agent frontmatter exist/);
});

// check_workflows_gone: workflows are gone (2026-11-22), so no ~/.claude/workflows path may be left; a leftover is a warning.
const workflowGoneCheck = (home) => spawnSync('bash', [DOCTOR], { env: cleanEnv({ HOME: home, USERPROFILE: home, DOCTOR_ONLY: 'check_workflows_gone' }), encoding: 'utf8' });

test('check_workflows_gone passes when there is no ~/.claude/workflows', { skip }, async () => {
  const home = makeTempDir('doctor-wf-gone-');
  await mkdir(join(home, '.claude'), { recursive: true });
  const run = workflowGoneCheck(home);
  assert.equal(run.status, 0, run.stdout);
  assert.match(run.stdout, /ok\s+no .*workflows: the retired workflows link is gone/);
});

test('check_workflows_gone warns about a leftover ~/.claude/workflows and says how to remove it', { skip }, async () => {
  const home = makeTempDir('doctor-wf-left-');
  await mkdir(join(home, '.claude', 'workflows'), { recursive: true });
  const run = workflowGoneCheck(home);
  assert.match(run.stdout, /WARN\s+.*workflows still exists: workflows are gone; re-run scripts\/install\.sh/);
  assert.doesNotMatch(run.stdout, /FAIL/);
});

test('check_prod_hosts fails when the prod-hosts file is a link, and passes for a plain file', { skip: skipLink }, async () => {
  const home = makeTempDir('doctor-home-');
  const privateDir = join(home, '.claude', 'private');
  await mkdir(privateDir, { recursive: true });
  const real = join(home, 'real-hosts');
  await writeFile(real, 'db1.example\n');
  const linkEnv = cleanEnv({ HOME: home, USERPROFILE: home, DOCTOR_ONLY: 'check_prod_hosts' });
  delete linkEnv.CLAUDE_PROD_HOSTS_FILE; // doctor.sh reads this one first; the link run must look at the temp HOME's own file
  const run = () => spawnSync('bash', [DOCTOR], { encoding: 'utf8', env: linkEnv });
  await symlink(real, join(privateDir, 'prod-hosts'));
  const linked = run();
  assert.equal(linked.status, 1);
  assert.match(linked.stdout, /^FAIL\s+prod-hosts is a link or not a plain file/m);
  await writeFile(join(home, 'plain'), 'db1.example\n');
  const plain = spawnSync('bash', [DOCTOR], {
    encoding: 'utf8',
    env: cleanEnv({ HOME: home, USERPROFILE: home, DOCTOR_ONLY: 'check_prod_hosts', CLAUDE_PROD_HOSTS_FILE: join(home, 'plain') }),
  });
  assert.equal(plain.status, 0);
  assert.match(plain.stdout, /^ok\s+prod-hosts list: 1 entries/m);
});

// Lead decision 2026-11-24: ollama-off named recall's Ollama check, which was removed; an older machine's accepted list that still
// holds it gets no WARN (the id is skipped, not counted), while an id doctor never knew still gets one.
test('check_doctor_accepted skips the retired ollama-off id silently and still warns about an unknown id', async () => {
  const home = makeTempDir('doctor-home-');
  const list = join(home, 'accepted');
  const run = () => spawnSync('bash', [DOCTOR], {
    encoding: 'utf8',
    env: cleanEnv({ HOME: home, USERPROFILE: home, DOCTOR_ONLY: 'check_doctor_accepted', CLAUDE_DOCTOR_ACCEPTED_FILE: list }),
  });
  await writeFile(list, 'ollama-off\napple-terminal-notes\n');
  const retired = run();
  assert.doesNotMatch(retired.stdout, /^WARN/m);
  assert.match(retired.stdout, /^ok\s+doctor accepted list: 1 ids/m);
  await writeFile(list, 'ollama-off\nolama-of\n');
  assert.match(run().stdout, /^WARN\s+doctor accepted list .* holds ids doctor cannot accept: olama-of \(/m);
});
