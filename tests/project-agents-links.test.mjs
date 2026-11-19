// Links in a project's `.claude/agents` (security review p0-0.1, S4 and N5). A cloned repository can carry relative links, which git
// stores. The hook once followed a linked `.claude` or `.claude/agents` folder and told the lead to delete maxTurns lines "without
// asking" in files that live in another repository or in a plugin checkout. Now a linked folder is not read and gets no delete advice.
// A linked agent file was skipped without a word, which hid whatever it points at; now it is listed as "a link: not read".
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
import { MAX_AGENT_FILES, NOTE_MAX_CHARS, projectAgentNote } from '../home/hooks/lib/project-agents.mjs';
import { CAP_ADVICE, LINK_ADVICE, POSIX, SHADOW_ADVICE, agent, noteOf } from './project-agents-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const REAL_PERSONAL_AGENTS_DIR = fileURLToPath(new URL('../home/agents', import.meta.url));
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

/** A project with a real `.claude/agents` and, outside that folder, a file whose frontmatter shadows reviewer and sets maxTurns. */
async function projectWithLinkTarget() {
  const paths = await linkSandbox();
  const agentsDir = join(paths.projectDir, '.claude', 'agents');
  await mkdir(agentsDir, { recursive: true });
  await mkdir(join(paths.projectDir, 'docs'));
  await writeFile(join(paths.projectDir, 'docs', 'r.md'), agent('reviewer', 'maxTurns: 2\n'));
  return { ...paths, agentsDir };
}

test('fixture E: a linked agent file is listed as a link that was not read, with the tell-the-owner advice', { skip }, async () => {
  const { projectDir, personalDir, agentsDir } = await projectWithLinkTarget();
  await symlink('../../docs/r.md', join(agentsDir, 'helper.md'));
  const note = projectAgentNote(projectDir, personalDir);
  assert.equal(note, noteOf({ advice: LINK_ADVICE, items: ['"helper.md" (a link: not read)'] }));
  assert.doesNotMatch(note, /maxTurns|no need to ask/, 'the file behind the link is not read, so nothing is said about its content');
});

test('fixture D: a link named like a personal agent is listed as a link and as shadowing, ahead of a capped file', { skip }, async () => {
  const { projectDir, personalDir, agentsDir } = await projectWithLinkTarget();
  await symlink('../../docs/r.md', join(agentsDir, 'reviewer.md'));
  await symlink('../../docs/r.md', join(agentsDir, 'z-other.md'));
  await writeFile(join(agentsDir, 'builder.md'), agent('builder', 'maxTurns: 60\n'));
  const items = ['"reviewer.md" (a link: not read, shadows the personal agent)', '"z-other.md" (a link: not read)', 'builder.md (maxTurns 60)'];
  assert.equal(projectAgentNote(projectDir, personalDir), noteOf({ advice: `${CAP_ADVICE}; ${SHADOW_ADVICE}; ${LINK_ADVICE}`, shadowed: ['reviewer'], items }));
});

// The most the hook itself can say: every piece of advice, every real personal agent shadowed, and both counts. None of it is ever cut.
test('with the real personal agents, all the advice, their names and both counts fit NOTE_MAX_CHARS', { skip }, async () => {
  const personal = readdirSync(REAL_PERSONAL_AGENTS_DIR).filter((file) => file.endsWith('.md')).map((file) => file.slice(0, -'.md'.length)).sort();
  const { projectDir, agentsDir } = await projectWithLinkTarget();
  const FILES = 100_000; // six digits in each count
  const worstFile = agent('x', `maxTurns: 999999\ntools: ${personal.join(', ')}\n`);
  await writeFile(join(agentsDir, `0${'\u00d8'.repeat(80)}.md`), worstFile);
  await symlink('../../docs/r.md', join(agentsDir, `1${'\u00d8'.repeat(80)}.md`));
  for (let i = 2; i < MAX_AGENT_FILES; i += 1) await writeFile(join(agentsDir, `2${String(i).padStart(3, '0')}${'\u00d8'.repeat(80)}.md`), worstFile);
  const note = projectAgentNote(projectDir, REAL_PERSONAL_AGENTS_DIR);
  const expected = (unchecked, more) => noteOf({ advice: `${CAP_ADVICE}; ${SHADOW_ADVICE}; ${LINK_ADVICE}`, shadowed: personal, unchecked, more });
  assert.equal(note, expected(0, MAX_AGENT_FILES));
  const worst = expected(FILES - MAX_AGENT_FILES, FILES);
  assert.ok(worst.length <= NOTE_MAX_CHARS, `with six-digit counts the note is ${worst.length} chars, cap ${NOTE_MAX_CHARS}`);
});
