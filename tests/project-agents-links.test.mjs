// Links in a project's `.claude/agents` (security review p0-0.1, S4 and N5). A cloned repository can carry relative links, which git
// stores. The hook once followed a linked `.claude` or `.claude/agents` folder and told the lead to delete maxTurns lines "without
// asking" in files that live in another repository or in a plugin checkout. Now a linked folder is not read and gets no delete advice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectAgentNote } from '../home/hooks/lib/project-agents.mjs';
import { POSIX, agent } from './project-agents-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const MODE_HOOK = fileURLToPath(new URL('../home/hooks/mode.mjs', import.meta.url));
const skip = !POSIX && 'making a link needs a privilege on Windows';
const LINK_OUTSIDE_NOTE = 'Project agent files: .claude/agents is a link to outside the project (or lies behind one), so it is not read and nothing there is edited - tell the owner.';
const LINK_INSIDE_NOTE = 'Project agent files: .claude/agents is a link (or lies behind one), so it is not read and nothing is edited through it - tell the owner.';

/** A temp root with a personal agents folder, an empty project and another repository whose agent files set maxTurns and shadow. */
async function linkSandbox() {
  const root = makeTempDir('proj-agents-links-');
  const paths = { root, home: join(root, 'home'), personalDir: join(root, 'home', '.claude', 'agents'), projectDir: join(root, 'proj'), otherAgents: join(root, 'other-repo', '.claude', 'agents') };
  for (const dir of [paths.personalDir, paths.projectDir, paths.otherAgents]) await mkdir(dir, { recursive: true });
  for (const name of ['reviewer', 'runner']) await writeFile(join(paths.personalDir, `${name}.md`), agent(name));
  await writeFile(join(paths.otherAgents, 'deploy.md'), agent('deploy', 'maxTurns: 40\n'));
  await writeFile(join(paths.otherAgents, 'reviewer.md'), agent('reviewer'));
  return paths;
}

test('fixture A: .claude/agents is a relative link into another repository: nothing is read, no delete advice', { skip }, async () => {
  const { projectDir, personalDir, home } = await linkSandbox();
  await mkdir(join(projectDir, '.claude'));
  await symlink('../../other-repo/.claude/agents', join(projectDir, '.claude', 'agents'));
  const note = projectAgentNote(projectDir, personalDir);
  assert.equal(note, LINK_OUTSIDE_NOTE);
  assert.doesNotMatch(note, /deploy|reviewer|maxTurns|deletes|no need to ask/);
  const input = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'links-1', source: 'startup', cwd: projectDir });
  const hook = spawnSync(process.execPath, [MODE_HOOK], { input, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
  assert.match(hook.stdout, /^Mode: /m);
  assert.ok(hook.stdout.includes(LINK_OUTSIDE_NOTE), 'the SessionStart hook prints the note');
  assert.doesNotMatch(hook.stdout, /deploy\.md|no need to ask/);
});

test('fixture B: .claude itself is a relative link into another repository: nothing is read, no delete advice', { skip }, async () => {
  const { projectDir, personalDir } = await linkSandbox();
  await symlink('../other-repo/.claude', join(projectDir, '.claude'));
  assert.equal(projectAgentNote(projectDir, personalDir), LINK_OUTSIDE_NOTE);
});

test('a link that stays inside the project is not read either, and the note does not say "outside"', { skip }, async () => {
  const { projectDir, personalDir } = await linkSandbox();
  await mkdir(join(projectDir, 'shared', 'agents'), { recursive: true });
  await writeFile(join(projectDir, 'shared', 'agents', 'deploy.md'), agent('reviewer', 'maxTurns: 40\n'));
  await mkdir(join(projectDir, '.claude'));
  await symlink('../shared/agents', join(projectDir, '.claude', 'agents'));
  assert.equal(projectAgentNote(projectDir, personalDir), LINK_INSIDE_NOTE);
  // .claude as the link, the folder behind it a real one inside the project
  const second = await linkSandbox();
  await mkdir(join(second.projectDir, 'config', 'agents'), { recursive: true });
  await writeFile(join(second.projectDir, 'config', 'agents', 'deploy.md'), agent('deploy', 'maxTurns: 40\n'));
  await symlink('config', join(second.projectDir, '.claude'));
  assert.equal(projectAgentNote(second.projectDir, second.personalDir), LINK_INSIDE_NOTE);
});

test('the personal agents folder reached through a link (a session started in the home folder) is still not flagged', { skip }, async () => {
  const { home, personalDir, root } = await linkSandbox();
  await writeFile(join(personalDir, 'runner.md'), agent('runner', 'maxTurns: 9\n'));
  const linkedHome = join(root, 'linked-home');
  await mkdir(linkedHome);
  await symlink(join(home, '.claude'), join(linkedHome, '.claude'));
  assert.equal(projectAgentNote(linkedHome, join(linkedHome, '.claude', 'agents')), '');
  assert.equal(projectAgentNote(linkedHome, personalDir), '');
});

test('a link loop or a dangling link as the agents folder gives no note and does not throw', { skip }, async () => {
  const { projectDir, personalDir } = await linkSandbox();
  await mkdir(join(projectDir, '.claude'));
  await symlink('agents', join(projectDir, '.claude', 'agents'));
  assert.equal(projectAgentNote(projectDir, personalDir), '');
  const dangling = await linkSandbox();
  await symlink('nowhere', join(dangling.projectDir, '.claude'));
  assert.equal(projectAgentNote(dangling.projectDir, dangling.personalDir), '');
});
