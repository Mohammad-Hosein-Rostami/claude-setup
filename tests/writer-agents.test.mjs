// Tests for lib/writer-agents.mjs: isWritingAgent (does an Agent call of this type launch a writing agent; the board marks an agent as a writer
// with it) and agentFileWrites (what the agent file's tools lines say). Each test gets a temp HOME and a temp project folder, so no real agent
// file is read; a FIFO at an agent file is tried in a child process, so a read that waited would end at the child's timeout, not hang the run.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { agentFileWrites, isWritingAgent } from '../home/hooks/lib/writer-agents.mjs';
import { cleanEnv } from './clean-env.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const posix = { skip: process.platform === 'win32' && 'FIFOs and links need POSIX' };
const WRITER_MODULE = pathToFileURL(fileURLToPath(new URL('../home/hooks/lib/writer-agents.mjs', import.meta.url))).href;
const CHILD_TIMEOUT_MS = 30_000; // only so a read that waits ends the run; the assertion reads the answer, never the time
const AGENT_FILE_BYTES = 64 * 1024; // the writer-agents head read: a line past it is not seen
const READ_ONLY_TYPES = ['lex', 'lex-scout', 'lex-web', 'pixel-qa', 'dev-run', 'tess', 'tess-review', 'tess-simple', 'tess-edge', 'Explore', 'Plan'];
const WRITER_TYPES = ['dev', 'dev-part', 'dev-docs', 'dev-ui', 'dev-pixel', 'dev-debug', 'tess-write', 'max', 'general-purpose', 'claude'];

/** A temp HOME and project folder; agent(type, lines, where) writes `<where>/.claude/agents/<type>.md` with the given front-matter lines. */
function setup() {
  const home = makeTempDir('writer-agents-home-');
  const project = makeTempDir('writer-agents-project-');
  const folderOf = (root) => {
    const folder = join(root, '.claude', 'agents');
    mkdirSync(folder, { recursive: true });
    return folder;
  };
  const agent = (type, lines, root = home) => {
    const path = join(folderOf(root), `${type}.md`);
    writeFileSync(path, `---\nname: ${type}\ndescription: test agent\n${lines.join('\n')}\n---\n`);
    return path;
  };
  return { home, project, env: { HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: project }, agent, folderOf };
}

test('read-only agent types never write, whatever their agent file says', () => {
  const { env, agent } = setup();
  for (const type of READ_ONLY_TYPES) agent(type, ['tools: Read, Write, Edit']); // a file that would allow writing: the name wins
  for (const type of READ_ONLY_TYPES) assert.equal(isWritingAgent(type, env), false, type);
});

test('writer agent types always write, whatever their agent file says, also with no file at all', () => {
  const { env, agent } = setup();
  for (const type of WRITER_TYPES) assert.equal(isWritingAgent(type, env), true, `${type}, no file`);
  for (const type of WRITER_TYPES) agent(type, ['tools: Read, Grep', 'disallowedTools: Write, Edit']); // a file that could not write: the name wins
  for (const type of WRITER_TYPES) assert.equal(isWritingAgent(type, env), true, `${type}, read-only file`);
});

test('an omitted or empty type is general-purpose, a writer; a type that is no string counts as omitted', () => {
  const { env } = setup();
  for (const type of [undefined, null, '', 42, {}]) assert.equal(isWritingAgent(type, env), true, String(type));
});

test('another type writes only when its agent file allows it: a writing tool, or no tools line (all tools)', () => {
  const { env, agent } = setup();
  const cases = [
    ['names-write', ['tools: Read, Write'], true],
    ['names-edit', ['tools: Read, Edit'], true],
    ['names-multiedit', ['tools: Read, MultiEdit'], true],
    ['names-notebook', ['tools: Read, NotebookEdit'], true],
    ['reads-only', ['tools: Read, Grep, Glob'], false],
    ['near-miss-names', ['tools: Read, Editor, WriteNote'], false],
    ['all-tools', [], true],
  ];
  for (const [type, lines, writes] of cases) {
    agent(type, lines);
    assert.equal(isWritingAgent(type, env), writes, type);
    assert.equal(agentFileWrites(type, env), writes, `${type} (agentFileWrites)`);
  }
});

test('a disallowedTools line naming both Write and Edit makes a file no writer, even with no tools line; naming one of them does not', () => {
  const { env, agent } = setup();
  agent('no-both', ['disallowedTools: Edit, Write, NotebookEdit']);
  agent('no-both-with-tools', ['tools: Read, Write, Edit', 'disallowedTools: Write, Edit']);
  agent('no-write-only', ['disallowedTools: Write']);
  agent('no-edit-only', ['tools: Read, Edit', 'disallowedTools: Edit']);
  assert.equal(isWritingAgent('no-both', env), false);
  assert.equal(isWritingAgent('no-both-with-tools', env), false);
  assert.equal(isWritingAgent('no-write-only', env), true, 'no tools line means all tools; only Write is denied');
  assert.equal(isWritingAgent('no-edit-only', env), true, 'the tools line still names Edit');
});

test('a type with no agent file, a fork and a plugin agent are no writers', () => {
  const { env } = setup();
  for (const type of ['no-such-agent', 'fork', 'some-plugin:helper']) {
    assert.equal(isWritingAgent(type, env), false, type);
    assert.equal(agentFileWrites(type, env), undefined, `${type} (agentFileWrites)`);
  }
});

test('a type that is no file name is never looked up: no answer, even with a file at that path', () => {
  const { env, home, agent } = setup();
  agent('escape-target', ['tools: Write'], join(home, 'elsewhere'));
  for (const type of ['../elsewhere/.claude/agents/escape-target', 'a/b', '', 'x'.repeat(65), 'with space', 7]) {
    assert.equal(agentFileWrites(type, env), undefined, String(type));
  }
});

test('the project agent file wins over the user\'s', () => {
  const { env, agent, project } = setup();
  agent('both-places', ['tools: Read, Write'], env.HOME);
  agent('both-places', ['tools: Read'], project);
  agent('other-way', ['tools: Read'], env.HOME);
  agent('other-way', ['tools: Read, Edit'], project);
  assert.equal(isWritingAgent('both-places', env), false, 'the project file reads only');
  assert.equal(isWritingAgent('other-way', env), true, 'the project file writes');
});

test('without a project folder the user\'s agent file is used; USERPROFILE stands in for HOME', () => {
  const { home, agent } = setup();
  agent('user-only', ['tools: Read, Write']);
  assert.equal(isWritingAgent('user-only', { HOME: home }), true, 'HOME');
  assert.equal(isWritingAgent('user-only', { USERPROFILE: home }), true, 'USERPROFILE');
});

test('only the first 64 KB of an agent file are read: a tools line after them is not seen', () => {
  const { env, home, folderOf } = setup();
  const filler = `# ${'x'.repeat(100)}\n`.repeat(Math.ceil(AGENT_FILE_BYTES / 100));
  writeFileSync(join(folderOf(home), 'late-tools.md'), `---\nname: late-tools\ndescription: test agent\n${filler}tools: Read\n---\n`);
  assert.equal(isWritingAgent('late-tools', env), true, 'the late `tools: Read` is cut off, so the file names no tools: all of them');
});

test('an agent file reached through a link is read', posix, () => {
  const { env, home, agent, folderOf } = setup();
  // The target writes: an unread link gives no answer (undefined, not a writer), so only a followed link can answer true.
  const real = agent('real-copy', ['tools: Read, Write'], makeTempDir('writer-agents-linked-'));
  symlinkSync(real, join(folderOf(home), 'linked.md'));
  assert.equal(agentFileWrites('linked', env), true, 'the link\'s target names Write');
  assert.equal(isWritingAgent('linked', env), true);
});

test('a FIFO at the agent file is no answer and is never waited on', posix, () => {
  const { env, folderOf, home } = setup();
  const fifo = join(folderOf(home), 'fifo-agent.md');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  const script = `import { agentFileWrites, isWritingAgent } from ${JSON.stringify(WRITER_MODULE)};
const env = JSON.parse(process.argv[1]);
console.log(JSON.stringify({ file: agentFileWrites('fifo-agent', env) ?? null, writing: isWritingAgent('fifo-agent', env) }));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(env)], { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, env: cleanEnv({}) });
  assert.deepEqual([run.status, run.signal], [0, null], run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { file: null, writing: false });
});
