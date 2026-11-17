// Tests for the doctor checks check_mode_hook and check_plugin_session_start (scripts/doctor.sh, DOCTOR_ONLY mode).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './temp-dir-helpers.mjs';

const DOCTOR = fileURLToPath(new URL('../scripts/doctor.sh', import.meta.url));
const hasJq = spawnSync('jq', ['--version']).status === 0;
const skip = !hasJq && 'jq not installed';
const MODE_HOOK = 'node "{{HOME}}/hooks/mode.mjs"';
const ALL_EVENTS = ['SessionStart', 'UserPromptSubmit', 'UserPromptExpansion'];

const hookBlock = (events) => Object.fromEntries(events.map((event) => [event, [{ hooks: [{ type: 'command', command: MODE_HOOK }] }]]));

async function fakeHome({ events = ALL_EVENTS, plugin } = {}) {
  const home = makeTempDir('doctor-home-');
  const claude = join(home, '.claude');
  await mkdir(join(claude, 'hooks'), { recursive: true });
  await mkdir(join(claude, 'modes'), { recursive: true });
  await mkdir(join(claude, 'plugins'), { recursive: true });
  await writeFile(join(claude, 'hooks', 'mode.mjs'), '// stub\n');
  await writeFile(join(claude, 'modes', '_lead.md'), 'lead rules\n');
  const settings = { hooks: hookBlock(events), enabledPlugins: {} };
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
  return spawnSync('bash', [DOCTOR], { env: { ...process.env, HOME: home, DOCTOR_ONLY: checks }, encoding: 'utf8' });
}

test('check_mode_hook passes when the mode hook is registered for all three events', { skip }, async () => {
  const result = doctor(await fakeHome(), 'check_mode_hook');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^ok\s+mode hook registered/m);
});

test('check_mode_hook fails and names the missing event', { skip }, async () => {
  const result = doctor(await fakeHome({ events: ['UserPromptSubmit'] }), 'check_mode_hook');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL\s+mode hook not registered.*SessionStart.*UserPromptExpansion/);
});

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
  const run = () => spawnSync('bash', [join(repo, 'scripts', 'doctor.sh')], { env: { ...process.env, HOME: repo, DOCTOR_ONLY: 'check_hook_files' }, encoding: 'utf8' });
  const missing = run();
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /FAIL\s+agent frontmatter hook file missing: home\/hooks\/gone\.mjs/);
  await writeFile(join(repo, 'home', 'hooks', 'gone.mjs'), '// stub\n');
  const present = run();
  assert.equal(present.status, 0);
  assert.match(present.stdout, /ok\s+hook files referenced by agent frontmatter exist/);
});

// check_workflows: every wf-* skill's script is reachable through ~/.claude/workflows, and settings let Workflow read that link path.
const SCRIPT_SKILL = 'scriptPath `${CLAUDE_SKILL_DIR}/../../workflows/x.js`\n';
const RESUME_SKILL = 'list runs: `node ~/.claude/tools/wf-resume/wf-resume.mjs list`\n';
async function workflowRepo({ script = true, linked = true, allowed = true, skillText = SCRIPT_SKILL, resumeTool = false } = {}) {
  const home = makeTempDir('doctor-wf-');
  const repo = join(home, 'repo');
  await mkdir(join(repo, 'scripts'), { recursive: true });
  await mkdir(join(repo, 'home', 'skills', 'wf-x'), { recursive: true });
  await mkdir(join(home, '.claude', 'workflows'), { recursive: true });
  await cp(DOCTOR, join(repo, 'scripts', 'doctor.sh'));
  await writeFile(join(repo, 'home', 'skills', 'wf-x', 'SKILL.md'), skillText);
  if (resumeTool) {
    await mkdir(join(home, '.claude', 'tools', 'wf-resume'), { recursive: true });
    await writeFile(join(home, '.claude', 'tools', 'wf-resume', 'wf-resume.mjs'), '// stub\n');
  }
  if (script && linked) await writeFile(join(home, '.claude', 'workflows', 'x.js'), '// stub\n');
  const dirs = allowed ? [join(home, '.claude', 'workflows')] : [];
  await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { additionalDirectories: dirs } }));
  return { home, repo };
}
const workflowCheck = ({ home, repo }) => spawnSync('bash', [join(repo, 'scripts', 'doctor.sh')], { env: { ...process.env, HOME: home, DOCTOR_ONLY: 'check_workflows' }, encoding: 'utf8' });

test('check_workflows passes when every wf- skill script exists and the link path is allowed', { skip }, async () => {
  const run = workflowCheck(await workflowRepo());
  assert.equal(run.status, 0, run.stdout);
  assert.match(run.stdout, /ok\s+every wf-\* skill's workflow script exists/);
  assert.match(run.stdout, /ok\s+settings.json lets Workflow read/);
});

test('check_workflows fails and names a skill whose script is missing under ~/.claude/workflows', { skip }, async () => {
  const run = workflowCheck(await workflowRepo({ script: false }));
  assert.equal(run.status, 1);
  assert.match(run.stdout, /FAIL\s+wf-x: workflows\/x\.js missing under .*\.claude \(re-run scripts\/install\.sh\)/);
});

test('check_workflows fails when permissions.additionalDirectories lacks the workflows link path', { skip }, async () => {
  const run = workflowCheck(await workflowRepo({ allowed: false }));
  assert.equal(run.status, 1);
  assert.match(run.stdout, /FAIL\s+settings.json lacks permissions.additionalDirectories/);
});

test('check_workflows passes a skill that names the wf-resume tool when the tool exists under ~/.claude/tools', { skip }, async () => {
  const run = workflowCheck(await workflowRepo({ skillText: RESUME_SKILL, resumeTool: true, script: false }));
  assert.equal(run.status, 0, run.stdout);
  assert.doesNotMatch(run.stdout, /FAIL/);
});

test('check_workflows fails a skill that names the wf-resume tool when the tool is missing', { skip }, async () => {
  const run = workflowCheck(await workflowRepo({ skillText: RESUME_SKILL }));
  assert.equal(run.status, 1);
  assert.match(run.stdout, /FAIL\s+wf-x: tools\/wf-resume\/wf-resume\.mjs missing under .*\.claude/);
});

test('check_workflows still fails a skill that names neither a workflow script nor the wf-resume tool', { skip }, async () => {
  const run = workflowCheck(await workflowRepo({ skillText: 'no script here\n', resumeTool: true }));
  assert.equal(run.status, 1);
  assert.match(run.stdout, /FAIL\s+wf-x names no workflow script/);
});
