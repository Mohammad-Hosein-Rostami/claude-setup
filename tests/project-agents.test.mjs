// Project agent files that set maxTurns or shadow a personal agent are flagged at SessionStart (mode hook) and by doctor
// (seen live: a project's own agents capped at 25-60 turns stopped mid-task and needed ~110 continue messages).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectAgentNote } from '../home/hooks/lib/project-agents.mjs';

const DOCTOR = fileURLToPath(new URL('../scripts/doctor.sh', import.meta.url));
const MODE_HOOK = fileURLToPath(new URL('../home/hooks/mode.mjs', import.meta.url));
const agent = (name, extra = '') => `---\nname: ${name}\ndescription: x\n${extra}---\nBody\n`;

async function sandbox({ project = {}, personal = { runner: '', reviewer: '' } } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'proj-agents-'));
  const home = join(root, 'home');
  const projectDir = join(root, 'proj');
  await mkdir(join(home, '.claude', 'agents'), { recursive: true });
  await mkdir(join(projectDir, '.claude', 'agents'), { recursive: true });
  for (const [name, extra] of Object.entries(personal)) await writeFile(join(home, '.claude', 'agents', `${name}.md`), agent(name, extra));
  for (const [name, extra] of Object.entries(project)) await writeFile(join(projectDir, '.claude', 'agents', `${name}.md`), agent(name, extra));
  return { home, projectDir, personalDir: join(home, '.claude', 'agents') };
}

test('a project agent with maxTurns is named in the note', async () => {
  const { projectDir, personalDir } = await sandbox({ project: { builder: 'maxTurns: 60\n' } });
  const note = projectAgentNote(projectDir, personalDir);
  assert.match(note, /builder\.md \(maxTurns 60\)/);
  assert.match(note, /these cap the agent's turns; the owner's rule is no maxTurns - tell the owner \(team file: ask before editing\)/);
  assert.equal(note.includes('\n'), false);
});

test('a project agent that shadows a personal agent is named, with or without maxTurns', async () => {
  const { projectDir, personalDir } = await sandbox({ project: { runner: '', reviewer: 'maxTurns: 30\n', builder: '' } });
  const note = projectAgentNote(projectDir, personalDir);
  assert.match(note, /runner\.md \(shadows the personal agent\)/);
  assert.match(note, /reviewer\.md \(maxTurns 30, shadows the personal agent\)/);
  assert.doesNotMatch(note, /builder/);
});

test('no note for clean project agents, no agents folder, or maxTurns only in the body', async () => {
  const clean = await sandbox({ project: { builder: '' } });
  assert.equal(projectAgentNote(clean.projectDir, clean.personalDir), '');
  assert.equal(projectAgentNote(join(clean.projectDir, 'nope'), clean.personalDir), '');
  assert.equal(projectAgentNote(undefined, clean.personalDir), '');
  await writeFile(join(clean.projectDir, '.claude', 'agents', 'prose.md'), `${agent('prose')}maxTurns: 5 is discussed here\n`);
  assert.equal(projectAgentNote(clean.projectDir, clean.personalDir), '');
});

test('the personal agents folder is not flagged as a project', async () => {
  const { home, personalDir } = await sandbox({ personal: { runner: 'maxTurns: 9\n' } });
  assert.equal(projectAgentNote(home, personalDir), '');
});

function runModeHook(home, projectDir, source = 'startup') {
  const input = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'abc-1', source, cwd: projectDir });
  return spawnSync('node', [MODE_HOOK], { input, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
}

test('the SessionStart mode hook prints the note for a capped project agent and stays quiet otherwise', async () => {
  const capped = await sandbox({ project: { builder: 'maxTurns: 60\n' } });
  assert.match(runModeHook(capped.home, capped.projectDir).stdout, /builder\.md \(maxTurns 60\).*no maxTurns/);
  const clean = await sandbox({ project: { builder: '' } });
  assert.doesNotMatch(runModeHook(clean.home, clean.projectDir).stdout, /maxTurns/);
});

const hasJq = spawnSync('jq', ['--version']).status === 0;

test('doctor warns about a capped project agent (DOCTOR_PROJECT) and is ok for a clean one', { skip: !hasJq && 'jq not installed' }, async () => {
  const run = ({ home, projectDir }) => spawnSync('bash', [DOCTOR], { encoding: 'utf8', env: { ...process.env, HOME: home, DOCTOR_PROJECT: projectDir, DOCTOR_ONLY: 'check_project_agents' } });
  const capped = run(await sandbox({ project: { builder: 'maxTurns: 60\n' } }));
  assert.match(capped.stdout, /^WARN\s+Project agent files .*builder\.md \(maxTurns 60\)/m);
  assert.equal(capped.status, 0);
  const clean = run(await sandbox({ project: { builder: '' } }));
  assert.match(clean.stdout, /^ok\s+project agents/m);
});
