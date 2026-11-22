// Contract tests for home/tools/done-check/lib/scope.mjs (design section 3.1 and 6, road newchk step 2, lane dc-tests-git). Written from the
// spec, apart from the code: they are red until lane dc-scope lands the module.
// Covers: ownChange(input, env) -> Scope[] for a subagent (base = HEAD at its first tool call, committed + uncommitted + untracked changes),
// for the lead (only the files it recorded, one Scope per worktree, never an agent's lane worktree), for a plain folder (no Scope) and
// for an agent whose folder is not git (its edits in a git worktree, compared with HEAD when no base was recorded there; one Scope per
// worktree, not per repository); rangeChange(top, base) ->
// Scope; changedLines(top, base, file) -> [start, end][] (1-based, both ends inclusive, sorted); the change key (same change before and
// after its commit = one key, moved base = another); hostile file names; an empty change; no git call beyond the first status.
// Decisions this test fixes where the design is silent (the writer of scope.mjs follows them): a Scope.files / wide entry uses `/` and is
//   repo-relative; code files are ts tsx js jsx mjs cjs mts cts vue; `wide` lists package.json, lockfiles, tsconfig*.json and the
//   vitest, jest and eslint config files; a change with no code file and no wide file gives no Scope; changedLines ranges are inclusive.
// Not covered here (needs a Windows drive or a case-insensitive disk, probed in the proof step): `C:\a b\x.ts` paths, APFS case folding.
// Invariants: every project is a fixture project in a temp folder with its own HOME (tests/done-check-fixture.mjs); the test process's own
//   HOME is pinned to a temp folder too, so nothing under the real ~/.claude is read or written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, join } from 'node:path';
import { makeDoneCheckRepo } from './done-check-fixture.mjs';
import { git } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { saveBaseline } from '../home/hooks/lib/dirty-baseline.mjs';
import { recordEditedFile } from '../home/hooks/lib/own-edits.mjs';

const PINNED_HOME = makeTempDir('done-check-scope-home-');
process.env.HOME = PINNED_HOME;
process.env.USERPROFILE = PINNED_HOME;

const SCOPE_MODULE = new URL('../home/tools/done-check/lib/scope.mjs', import.meta.url).href;
const loadScope = () => import(SCOPE_MODULE);

const SESSION = 'session-1';
const AGENT = 'agent-1';
const KEY_PATTERN = /^[0-9a-f]{64}$/;
const BASE_FILES = { 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 1;\n' };

const sorted = (list) => [...list].sort();
const withRepo = (t, options) => {
  const repo = makeDoneCheckRepo(options);
  t.after(() => repo.cleanup());
  return repo;
};
const envOf = (repo) => ({ ...repo.env, CLAUDE_PROJECT_DIR: repo.dir });

/** The Stop input of a subagent that works in `repo`, with its baseline taken at the commit the repo is at now. */
function startAgent(repo) {
  const transcript = join(dirname(repo.dir), 'agent-transcript.jsonl');
  writeFileSync(transcript, `${JSON.stringify({ cwd: repo.dir })}\n`);
  assert.equal(saveBaseline(repo.env, SESSION, AGENT, repo.dir, [], repo.head()), true, 'the baseline could not be stored');
  return { session_id: SESSION, agent_id: AGENT, agent_type: 'general-purpose', agent_transcript_path: transcript, stop_hook_active: false };
}

/** The Stop input of the lead (main session), with its baseline taken at the commit the repo is at now. */
function startLead(repo) {
  assert.equal(saveBaseline(repo.env, SESSION, '', repo.dir, [], repo.head()), true, 'the baseline could not be stored');
  return { session_id: SESSION, stop_hook_active: false };
}

/** Records Edit/Write calls of the lead on `files` (absolute or repo-relative) the way the PostToolUse hook does. */
function recordLeadEdits(repo, ...files) {
  for (const file of files) {
    const filePath = file.startsWith('/') || /^[A-Za-z]:/.test(file) ? file : join(repo.dir, file);
    assert.equal(recordEditedFile({ session_id: SESSION, tool_input: { file_path: filePath } }, repo.env), true, `could not record ${file}`);
  }
}

test('a subagent scope holds committed, uncommitted and untracked changes since its first tool call', async (t) => {
  const repo = withRepo(t, { files: BASE_FILES });
  const input = startAgent(repo);
  repo.write('src/a.ts', 'export const a = 2;\n');
  repo.commit('agent commit');
  repo.write('src/b.ts', 'export const b = 2;\n');
  repo.write('src/c.ts', 'export const c = 1;\n');
  const { ownChange } = await loadScope();
  const scopes = await ownChange(input, envOf(repo));
  assert.equal(scopes.length, 1);
  assert.deepEqual(sorted(scopes[0].files), ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  assert.equal(scopes[0].git, true);
  assert.equal(scopes[0].top, repo.dir);
  assert.equal(scopes[0].base, repo.baseSha);
  assert.match(scopes[0].key, KEY_PATTERN);
});

test('only code files count: ts tsx js jsx mjs cjs mts cts vue', async (t) => {
  const repo = withRepo(t);
  const input = startAgent(repo);
  const code = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'vue'].map((extension) => `src/code.${extension}`);
  const other = ['docs/readme.md', 'data/list.json', 'src/style.css', 'tool.py', 'run.sh', 'logo.png'];
  for (const file of [...code, ...other]) repo.write(file, 'x\n');
  const { ownChange } = await loadScope();
  const [scope] = await ownChange(input, envOf(repo));
  assert.deepEqual(sorted(scope.files), sorted(code));
  assert.deepEqual(scope.wide, []);
});

test('package.json, lockfiles, tsconfig and test or lint config are listed as wide changes', async (t) => {
  const repo = withRepo(t);
  const input = startAgent(repo);
  const wide = ['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'tsconfig.json', 'tsconfig.build.json',
    'vitest.config.ts', 'jest.config.js', 'eslint.config.js', '.eslintrc.json'];
  for (const file of wide) repo.write(file, '{}\n');
  repo.write('src/a.ts', 'export const a = 1;\n');
  const { ownChange } = await loadScope();
  const [scope] = await ownChange(input, envOf(repo));
  assert.deepEqual(sorted(scope.wide), sorted(wide));
  assert.ok(scope.files.includes('src/a.ts'));
  for (const file of ['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'tsconfig.json', '.eslintrc.json']) {
    assert.ok(!scope.files.includes(file), `${file} is not a code file`);
  }
});

test('a changed package.json alone still makes a scope', async (t) => {
  const repo = withRepo(t, { packageJson: { name: 'p', scripts: { test: 'vitest' } } });
  const input = startAgent(repo);
  repo.write('package.json', `${JSON.stringify({ name: 'p', scripts: { test: 'echo' } })}\n`);
  const { ownChange } = await loadScope();
  const scopes = await ownChange(input, envOf(repo));
  assert.equal(scopes.length, 1);
  assert.deepEqual(scopes[0].files, []);
  assert.deepEqual(scopes[0].wide, ['package.json']);
});

test('nothing changed gives no scope', async (t) => {
  const repo = withRepo(t, { files: BASE_FILES });
  const input = startAgent(repo);
  const { ownChange } = await loadScope();
  assert.deepEqual(await ownChange(input, envOf(repo)), []);
});

test('a docs-only change gives no scope', async (t) => {
  const repo = withRepo(t, { files: BASE_FILES });
  const input = startAgent(repo);
  repo.write('README.md', 'hello\n');
  repo.write('notes.txt', 'notes\n');
  const { ownChange } = await loadScope();
  assert.deepEqual(await ownChange(input, envOf(repo)), []);
});

test('a file changed and then put back to its base content is not a change', async (t) => {
  const repo = withRepo(t, { files: BASE_FILES });
  const input = startAgent(repo);
  repo.write('src/a.ts', 'export const a = 99;\n');
  repo.write('src/a.ts', BASE_FILES['src/a.ts']);
  const { ownChange } = await loadScope();
  assert.deepEqual(await ownChange(input, envOf(repo)), []);
});

test('file names with a space, a quote, a leading dash, a new line or non-ASCII letters come back exactly', async (t) => {
  const repo = withRepo(t);
  const input = startAgent(repo);
  const names = ['src/-dash.ts', 'src/a b.ts', "src/it's.ts", 'src/ünï-ß.ts'];
  if (process.platform !== 'win32') names.push('src/new\nline.ts', 'src/"quoted".ts');
  for (const name of names) repo.write(name, 'export {};\n');
  const { ownChange } = await loadScope();
  const [scope] = await ownChange(input, envOf(repo));
  assert.deepEqual(sorted(scope.files), sorted(names));
});

test('paths use forward slashes and are relative to the git top, also from a deep folder', async (t) => {
  const repo = withRepo(t);
  const input = startAgent(repo);
  repo.write('packages/app/src/deep/x.ts', 'export {};\n');
  const { ownChange } = await loadScope();
  const [scope] = await ownChange(input, envOf(repo));
  assert.deepEqual(scope.files, ['packages/app/src/deep/x.ts']);
});

test('the lead scope keeps to the files the lead recorded, not a landed lane or another untracked file', async (t) => {
  const repo = withRepo(t, { files: BASE_FILES });
  const input = startLead(repo);
  repo.write('src/a.ts', 'export const a = 2;\n'); // a landed lane: committed on main, never recorded by the lead
  repo.commit('landed lane');
  repo.write('src/b.ts', 'export const b = 2;\n'); // edited by the lead
  recordLeadEdits(repo, 'src/b.ts');
  repo.write('src/c.ts', 'export const c = 1;\n'); // untracked, nobody recorded it
  const { ownChange } = await loadScope();
  const scopes = await ownChange(input, envOf(repo));
  assert.equal(scopes.length, 1);
  assert.deepEqual(scopes[0].files, ['src/b.ts']);
  assert.equal(scopes[0].base, repo.baseSha);
});

test('a lead file edited through a link to the folder is still found', async (t) => {
  const repo = withRepo(t, { files: BASE_FILES });
  const input = startLead(repo);
  const link = join(dirname(repo.dir), 'link-to-project');
  symlinkSync(repo.dir, link, 'junction');
  repo.write('src/a.ts', 'export const a = 2;\n');
  recordLeadEdits(repo, join(link, 'src/a.ts'));
  const { ownChange } = await loadScope();
  const scopes = await ownChange(input, envOf(repo));
  assert.equal(scopes.length, 1);
  assert.deepEqual(scopes[0].files, ['src/a.ts']);
});

test('a lead started outside any repo gets one scope per worktree it edited in', async (t) => {
  const first = withRepo(t, { files: BASE_FILES });
  const second = withRepo(t, { files: BASE_FILES });
  const env = { ...first.env, CLAUDE_PROJECT_DIR: first.home }; // the lead started in a folder that is not a repo
  assert.equal(saveBaseline(first.env, SESSION, '', null, [], null), true);
  first.write('src/a.ts', 'export const a = 2;\n');
  second.write('src/b.ts', 'export const b = 2;\n');
  recordLeadEdits(first, 'src/a.ts');
  recordLeadEdits(first, join(second.dir, 'src/b.ts'));
  const { ownChange } = await loadScope();
  const scopes = (await ownChange({ session_id: SESSION, stop_hook_active: false }, env)).sort((left, right) => left.top.localeCompare(right.top));
  const expected = [[first.dir, ['src/a.ts']], [second.dir, ['src/b.ts']]].sort(([left], [right]) => left.localeCompare(right));
  assert.deepEqual(scopes.map((scope) => [scope.top, scope.files]), expected);
});

test('a lead whose folder is not git gets no scope for its edits there (no git base, nothing to judge)', async (t) => {
  const repo = withRepo(t, { plain: true, files: BASE_FILES });
  const input = { session_id: SESSION, stop_hook_active: false };
  recordLeadEdits(repo, 'src/a.ts');
  const { ownChange } = await loadScope();
  assert.deepEqual(await ownChange(input, envOf(repo)), []);
});

test('a folder that is not git with no recorded file gives no scope', async (t) => {
  const repo = withRepo(t, { plain: true, files: BASE_FILES });
  const { ownChange } = await loadScope();
  assert.deepEqual(await ownChange({ session_id: SESSION, stop_hook_active: false }, envOf(repo)), []);
});

/** Records Edit/Write calls of subagent `agent` on absolute `files`, the way the PostToolUse hook does. */
function recordAgentEdits(env, agent, ...files) {
  for (const file of files) {
    assert.equal(recordEditedFile({ session_id: SESSION, agent_id: agent, tool_input: { file_path: file } }, env), true, `could not record ${file}`);
  }
}

/** A linked worktree of `repo` on a new branch, under `.claude/worktrees/<name>` (git-excluded, as lane worktrees are). */
function addLaneWorktree(repo, name) {
  writeFileSync(join(repo.dir, '.git', 'info', 'exclude'), '.claude/worktrees/\n');
  const lane = join(repo.dir, '.claude', 'worktrees', name);
  git(repo.dir, 'worktree', 'add', '-q', '-b', `lane-${name}`, lane);
  return lane;
}

test('a lead outside any repo is not given the files an agent edited in its lane worktree', async (t) => {
  const repo = withRepo(t, { files: BASE_FILES });
  const lane = addLaneWorktree(repo, 'lane-a');
  const env = { ...repo.env, CLAUDE_PROJECT_DIR: repo.home }; // the lead started in a folder that is not a repo
  assert.equal(saveBaseline(repo.env, SESSION, '', null, [], null), true);
  writeFileSync(join(lane, 'src', 'a.ts'), 'export const a = 2;\n'); // half-finished lane work
  recordAgentEdits(repo.env, AGENT, join(lane, 'src', 'a.ts'));
  const { ownChange } = await loadScope();
  assert.deepEqual(await ownChange({ session_id: SESSION, stop_hook_active: false }, env), []);
});

test('a lead outside any repo keeps its own edit and leaves out an agent edit in another worktree of the same repo', async (t) => {
  const repo = withRepo(t, { files: BASE_FILES });
  const lane = addLaneWorktree(repo, 'lane-b');
  const env = { ...repo.env, CLAUDE_PROJECT_DIR: repo.home };
  assert.equal(saveBaseline(repo.env, SESSION, '', null, [], null), true);
  repo.write('src/b.ts', 'export const b = 2;\n');
  recordLeadEdits(repo, 'src/b.ts');
  writeFileSync(join(lane, 'src', 'a.ts'), 'export const a = 2;\n');
  recordAgentEdits(repo.env, AGENT, join(lane, 'src', 'a.ts')); // the newest edit of the session is the agent's
  const { ownChange } = await loadScope();
  const scopes = await ownChange({ session_id: SESSION, stop_hook_active: false }, env);
  assert.deepEqual(scopes.map((scope) => [scope.top, scope.files, scope.base]), [[repo.dir, ['src/b.ts'], repo.head()]]);
});

test('a lead in a main checkout with nothing changed is not given an agent lane worktree with changes', async (t) => {
  const repo = withRepo(t, { files: BASE_FILES });
  const lane = addLaneWorktree(repo, 'lane-c');
  const input = startLead(repo);
  writeFileSync(join(lane, 'src', 'a.ts'), 'export const a = 2;\n');
  writeFileSync(join(lane, 'src', 'c.ts'), 'export const c = 1;\n');
  recordAgentEdits(repo.env, AGENT, join(lane, 'src', 'a.ts'), join(lane, 'src', 'c.ts'));
  const { ownChange } = await loadScope();
  assert.deepEqual(await ownChange(input, envOf(repo)), []);
});

test('an agent whose folder is not git still gets its edits in a git worktree checked, against that worktree\'s HEAD', async (t) => {
  const repo = withRepo(t, { files: BASE_FILES });
  const plainFolder = join(dirname(repo.dir), 'reports');
  mkdirSync(plainFolder);
  const transcript = join(dirname(repo.dir), 'agent-transcript.jsonl');
  writeFileSync(transcript, `${JSON.stringify({ cwd: plainFolder })}\n`);
  assert.equal(saveBaseline(repo.env, SESSION, AGENT, null, [], null), true);
  writeFileSync(join(plainFolder, 'notes.mjs'), 'export {};\n');
  repo.write('src/a.ts', 'export const a = 2;\n');
  recordAgentEdits(repo.env, AGENT, join(plainFolder, 'notes.mjs'), join(repo.dir, 'src', 'a.ts'));
  const input = { session_id: SESSION, agent_id: AGENT, agent_type: 'general-purpose', agent_transcript_path: transcript, stop_hook_active: false };
  const { ownChange } = await loadScope();
  const scopes = await ownChange(input, repo.env);
  assert.deepEqual(scopes.map((scope) => [scope.top, scope.git, scope.files, scope.base]), [[repo.dir, true, ['src/a.ts'], repo.head()]]);
});

test('an unreadable edit log: a subagent change since its baseline is still checked', async (t) => {
  const repo = withRepo(t, { files: BASE_FILES });
  const input = startAgent(repo);
  repo.write('src/a.ts', 'export const a = 2;\n');
  repo.commit('agent commit');
  const editsFolder = join(repo.home, '.claude', 'state', 'commit-gate', 'edits');
  mkdirSync(editsFolder, { recursive: true });
  writeFileSync(join(editsFolder, `${SESSION}.json`), '{ this is not json');
  const { ownChange } = await loadScope();
  const scopes = await ownChange(input, envOf(repo));
  assert.deepEqual(scopes.map((scope) => [scope.files, scope.base]), [[['src/a.ts'], repo.baseSha]]);
});

test('a baseline without a head: the change since it is compared with HEAD, no error', async (t) => {
  const repo = withRepo(t, { files: BASE_FILES });
  const input = startAgent(repo);
  assert.equal(saveBaseline(repo.env, SESSION, 'old-agent', repo.dir, [], null), true); // a baseline written before round 9 has no head
  repo.write('src/a.ts', 'export const a = 2;\n');
  const { ownChange } = await loadScope();
  const scopes = await ownChange({ ...input, agent_id: 'old-agent' }, envOf(repo));
  assert.deepEqual(scopes.map((scope) => [scope.files, scope.base]), [[['src/a.ts'], repo.head()]]);
});

test('a baseline whose commit is gone: the uncommitted change is compared with HEAD', async (t) => {
  const repo = withRepo(t, { files: BASE_FILES });
  const input = startAgent(repo);
  assert.equal(saveBaseline(repo.env, SESSION, 'gone-agent', repo.dir, [], 'f'.repeat(40)), true); // a commit this repo never had
  repo.write('src/a.ts', 'export const a = 2;\n');
  recordAgentEdits(repo.env, 'gone-agent', join(repo.dir, 'src', 'a.ts'));
  const { ownChange } = await loadScope();
  const scopes = await ownChange({ ...input, agent_id: 'gone-agent' }, envOf(repo));
  assert.deepEqual(scopes.map((scope) => [scope.files, scope.base]), [[['src/a.ts'], repo.head()]]);
});

/** The Stop input of an agent that started in a plain folder beside `repo` (no baseline worktree, so no recorded base). */
function startAgentInPlainFolder(repo) {
  const plainFolder = join(dirname(repo.dir), 'plain-start');
  mkdirSync(plainFolder, { recursive: true });
  const transcript = join(dirname(repo.dir), 'plain-agent-transcript.jsonl');
  writeFileSync(transcript, `${JSON.stringify({ cwd: plainFolder })}\n`);
  assert.equal(saveBaseline(repo.env, SESSION, AGENT, null, [], null), true);
  return { session_id: SESSION, agent_id: AGENT, agent_type: 'general-purpose', agent_transcript_path: transcript, stop_hook_active: false };
}

for (const [order, laneFirst] of [['checkout edit first', false], ['lane edit first', true]]) {
  test(`an agent whose folder is not git gets one scope per worktree of one repo it edited in (${order})`, async (t) => {
    const repo = withRepo(t, { files: BASE_FILES });
    const lane = addLaneWorktree(repo, 'lane-two');
    const input = startAgentInPlainFolder(repo);
    const edits = [join(repo.dir, 'src', 'a.ts'), join(lane, 'src', 'b.ts')];
    for (const file of edits) writeFileSync(file, 'export const changed = 2;\n');
    recordAgentEdits(repo.env, AGENT, ...(laneFirst ? edits.reverse() : edits));
    const { ownChange } = await loadScope();
    const scopes = (await ownChange(input, repo.env)).map((scope) => [scope.top, scope.files, scope.base]).sort(([left], [right]) => left.localeCompare(right));
    assert.deepEqual(scopes, [[repo.dir, ['src/a.ts'], repo.head()], [lane, ['src/b.ts'], repo.head()]]);
  });
}

test('an agent in a git worktree that also edits another repo gets that repo checked on its own edit there', async (t) => {
  const repo = withRepo(t, { files: BASE_FILES });
  const other = withRepo(t, { files: BASE_FILES });
  const input = startAgent(repo);
  repo.write('src/a.ts', 'export const a = 2;\n');
  other.write('src/b.ts', 'export const b = 2;\n');
  other.write('src/a.ts', 'export const a = 3;\n'); // changed in the other repo, but not by this agent
  recordAgentEdits(repo.env, AGENT, join(repo.dir, 'src', 'a.ts'), join(other.dir, 'src', 'b.ts'));
  const { ownChange } = await loadScope();
  const scopes = (await ownChange(input, envOf(repo))).map((scope) => [scope.top, scope.files, scope.base]);
  assert.deepEqual(scopes, [[repo.dir, ['src/a.ts'], repo.baseSha], [other.dir, ['src/b.ts'], other.head()]]);
});

test('an unreadable baseline file gives base none and no error', async (t) => {
  const repo = withRepo(t, { files: BASE_FILES });
  const input = startAgent(repo);
  const baselineFile = join(repo.home, '.claude', 'state', 'commit-gate', 'baseline', `${SESSION}--${AGENT}.json`);
  writeFileSync(baselineFile, '{ this is not json');
  repo.write('src/a.ts', 'export const a = 2;\n');
  const { ownChange } = await loadScope();
  const scopes = await ownChange(input, envOf(repo));
  assert.ok(Array.isArray(scopes));
  for (const scope of scopes) assert.equal(scope.base, null);
});

test('an agent with no baseline at all gives base none and no error', async (t) => {
  const repo = withRepo(t, { files: BASE_FILES });
  const input = startAgent(repo);
  repo.write('src/a.ts', 'export const a = 2;\n');
  const { ownChange } = await loadScope();
  const scopes = await ownChange({ ...input, agent_id: 'never-started' }, envOf(repo));
  assert.ok(Array.isArray(scopes));
  for (const scope of scopes) assert.equal(scope.base, null);
});

test('rangeChange holds committed, uncommitted and untracked changes since the base', async (t) => {
  const repo = withRepo(t, { files: BASE_FILES });
  repo.write('src/a.ts', 'export const a = 2;\n');
  repo.commit('lane commit');
  repo.write('src/b.ts', 'export const b = 2;\n');
  repo.write('src/c.ts', 'export const c = 1;\n');
  repo.write('notes.md', 'not code\n');
  const { rangeChange } = await loadScope();
  const scope = await rangeChange(repo.dir, repo.baseSha);
  assert.deepEqual(sorted(scope.files), ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  assert.equal(scope.base, repo.baseSha);
  assert.equal(scope.git, true);
  assert.equal(scope.top, repo.dir);
});

test('the same change before and after its commit has one key', async (t) => {
  const repo = withRepo(t, { files: BASE_FILES });
  repo.write('src/a.ts', 'export const a = 2;\n');
  repo.write('src/c.ts', 'export const c = 1;\n');
  const { rangeChange } = await loadScope();
  const before = await rangeChange(repo.dir, repo.baseSha);
  repo.commit('the lane commit');
  const after = await rangeChange(repo.dir, repo.baseSha);
  assert.match(before.key, KEY_PATTERN);
  assert.equal(after.key, before.key);
});

test('a subagent change has the same key before and after the agent commits it', async (t) => {
  const repo = withRepo(t, { files: BASE_FILES });
  const input = startAgent(repo);
  repo.write('src/a.ts', 'export const a = 2;\n');
  const { ownChange } = await loadScope();
  const [before] = await ownChange(input, envOf(repo));
  repo.commit('agent commit');
  const [after] = await ownChange(input, envOf(repo));
  assert.equal(after.key, before.key);
});

test('a lead change has the same key before and after the lead commits it', async (t) => {
  const repo = withRepo(t, { files: BASE_FILES });
  const input = startLead(repo);
  repo.write('src/a.ts', 'export const a = 2;\n');
  recordLeadEdits(repo, 'src/a.ts');
  const { ownChange } = await loadScope();
  const [before] = await ownChange(input, envOf(repo));
  repo.commit('lead commit');
  const [after] = await ownChange(input, envOf(repo));
  assert.equal(after.key, before.key);
});

test('a different file content gives another key', async (t) => {
  const repo = withRepo(t, { files: BASE_FILES });
  const { rangeChange } = await loadScope();
  repo.write('src/a.ts', 'export const a = 2;\n');
  const first = await rangeChange(repo.dir, repo.baseSha);
  repo.write('src/a.ts', 'export const a = 3;\n');
  const second = await rangeChange(repo.dir, repo.baseSha);
  assert.notEqual(second.key, first.key);
});

test('a moved base gives another key for the same files', async (t) => {
  const repo = withRepo(t, { files: BASE_FILES });
  repo.write('src/a.ts', 'export const a = 2;\n');
  const { rangeChange } = await loadScope();
  const atOldBase = await rangeChange(repo.dir, repo.baseSha);
  // main moves on: a new commit that no lane file touches, then the lane is compared with it
  repo.write('other.txt', 'moved\n');
  git(repo.dir, 'add', 'other.txt'); // only this file: the lane's src/a.ts stays uncommitted
  git(repo.dir, 'commit', '-q', '-m', 'base moved');
  const movedBase = repo.head();
  assert.notEqual(movedBase, repo.baseSha);
  const atNewBase = await rangeChange(repo.dir, movedBase);
  assert.deepEqual(atNewBase.files, atOldBase.files);
  assert.notEqual(atNewBase.key, atOldBase.key);
});

test('the key does not depend on the order files were written', async (t) => {
  const first = withRepo(t, { files: BASE_FILES });
  const second = withRepo(t, { files: BASE_FILES });
  first.write('src/x.ts', 'export const x = 1;\n');
  first.write('src/y.ts', 'export const y = 1;\n');
  second.write('src/y.ts', 'export const y = 1;\n');
  second.write('src/x.ts', 'export const x = 1;\n');
  const { rangeChange } = await loadScope();
  const left = await rangeChange(first.dir, first.baseSha);
  const right = await rangeChange(second.dir, second.baseSha);
  assert.deepEqual(left.files, right.files);
  assert.equal(left.key === right.key, first.baseSha === second.baseSha);
});

/** Puts a `git` ahead of the real one on PATH that logs each call's arguments, for the rest of the test. */
function logGitCalls(t, repo) {
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const shimFolder = join(dirname(repo.dir), 'git-shim');
  const log = join(dirname(repo.dir), 'git-calls.log');
  mkdirSync(shimFolder);
  writeFileSync(log, '');
  writeFileSync(join(shimFolder, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shimFolder}${delimiter}${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  return () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
}

const NEEDS_SH_SHIM = { skip: process.platform === 'win32' ? 'the git call log is a sh script' : false };

test('a change with no code file asks git for status once and nothing after it', NEEDS_SH_SHIM, async (t) => {
  const repo = withRepo(t, { files: BASE_FILES });
  const input = startAgent(repo);
  repo.write('README.md', 'docs only\n');
  const calls = logGitCalls(t, repo);
  const { ownChange } = await loadScope();
  assert.deepEqual(await ownChange(input, envOf(repo)), []);
  const firstStatus = calls().findIndex((line) => /\bstatus\b/.test(line));
  assert.ok(firstStatus >= 0, `no git status call in: ${calls().join(' | ')}`);
  assert.deepEqual(calls().slice(firstStatus + 1), []);
});

test('an unchanged tree asks git for status once and nothing after it', NEEDS_SH_SHIM, async (t) => {
  const repo = withRepo(t, { files: BASE_FILES });
  const input = startAgent(repo);
  const calls = logGitCalls(t, repo);
  const { ownChange } = await loadScope();
  assert.deepEqual(await ownChange(input, envOf(repo)), []);
  const firstStatus = calls().findIndex((line) => /\bstatus\b/.test(line));
  assert.ok(firstStatus >= 0, `no git status call in: ${calls().join(' | ')}`);
  assert.deepEqual(calls().slice(firstStatus + 1), []);
});

const FIVE_LINES = 'one\ntwo\nthree\nfour\nfive\n';
const TWELVE_LINES = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';

test('changedLines gives the one line that was edited, 1-based and inclusive', async (t) => {
  const repo = withRepo(t, { files: { 'src/a.ts': FIVE_LINES } });
  repo.write('src/a.ts', 'one\ntwo\nTHREE\nfour\nfive\n');
  const { changedLines } = await loadScope();
  assert.deepEqual(await changedLines(repo.dir, repo.baseSha, 'src/a.ts'), [[3, 3]]);
});

test('changedLines gives the added lines as one range', async (t) => {
  const repo = withRepo(t, { files: { 'src/a.ts': FIVE_LINES } });
  repo.write('src/a.ts', 'one\nnew a\nnew b\ntwo\nthree\nfour\nfive\n');
  const { changedLines } = await loadScope();
  assert.deepEqual(await changedLines(repo.dir, repo.baseSha, 'src/a.ts'), [[2, 3]]);
});

test('changedLines gives two ranges, in order, for two separate edits', async (t) => {
  const repo = withRepo(t, { files: { 'src/a.ts': TWELVE_LINES } });
  repo.write('src/a.ts', TWELVE_LINES.replace('line 10', 'LINE TEN').replace('line 2\n', 'LINE TWO\n'));
  const { changedLines } = await loadScope();
  assert.deepEqual(await changedLines(repo.dir, repo.baseSha, 'src/a.ts'), [[2, 2], [10, 10]]);
});

test('changedLines gives no line for a pure deletion', async (t) => {
  const repo = withRepo(t, { files: { 'src/a.ts': FIVE_LINES } });
  repo.write('src/a.ts', 'one\ntwo\nfour\nfive\n');
  const { changedLines } = await loadScope();
  assert.deepEqual(await changedLines(repo.dir, repo.baseSha, 'src/a.ts'), []);
});

test('changedLines counts every line of an untracked new file', async (t) => {
  const repo = withRepo(t);
  repo.write('src/new.ts', 'a\nb\nc\n');
  const { changedLines } = await loadScope();
  assert.deepEqual(await changedLines(repo.dir, repo.baseSha, 'src/new.ts'), [[1, 3]]);
});

test('changedLines sees a change that is already committed since the base', async (t) => {
  const repo = withRepo(t, { files: { 'src/a.ts': FIVE_LINES } });
  repo.write('src/a.ts', 'one\ntwo\nthree\nfour\nFIVE\n');
  repo.commit('lane commit');
  const { changedLines } = await loadScope();
  assert.deepEqual(await changedLines(repo.dir, repo.baseSha, 'src/a.ts'), [[5, 5]]);
});

test('changedLines gives no line for an unchanged file', async (t) => {
  const repo = withRepo(t, { files: { 'src/a.ts': FIVE_LINES } });
  const { changedLines } = await loadScope();
  assert.deepEqual(await changedLines(repo.dir, repo.baseSha, 'src/a.ts'), []);
});

test('changedLines works for a file name with a space and a quote', async (t) => {
  const repo = withRepo(t, { files: { "src/my file's.ts": FIVE_LINES } });
  repo.write("src/my file's.ts", 'one\ntwo\nthree\nFOUR\nfive\n');
  const { changedLines } = await loadScope();
  assert.deepEqual(await changedLines(repo.dir, repo.baseSha, "src/my file's.ts"), [[4, 4]]);
});

// ---- non-code files a test names, and .githooks scripts (proof misses R2a, R2e, S12) ----

const NAMING_TEST = "import { readFileSync } from 'node:fs';\nconst text = readFileSync('docs/rules.md', 'utf8');\n";

test('a .githooks script without an extension is a code file', async (t) => {
  const repo = withRepo(t, { files: BASE_FILES });
  const input = startAgent(repo);
  repo.write('.githooks/pre-commit', '#!/bin/sh\nexit 0\n');
  repo.write('other/.githooks-notes', 'not a hook\n');
  const { ownChange } = await loadScope();
  const [scope] = await ownChange(input, envOf(repo));
  assert.deepEqual(scope.files, ['.githooks/pre-commit']);
});

test('a markdown file that a test file names is listed as named; a markdown file no test names gives no scope', async (t) => {
  const repo = withRepo(t, { files: { ...BASE_FILES, 'tests/rules.test.mjs': NAMING_TEST, 'docs/rules.md': 'old\n', 'docs/other.md': 'old\n' } });
  const input = startAgent(repo);
  repo.write('docs/other.md', 'new\n');
  const { ownChange } = await loadScope();
  assert.deepEqual(await ownChange(input, envOf(repo)), []);
  repo.write('docs/rules.md', 'new\n');
  const [scope] = await ownChange(input, envOf(repo));
  assert.deepEqual(scope.named, ['docs/rules.md']);
  assert.deepEqual(scope.files, []);
  assert.match(scope.key, KEY_PATTERN);
});

test('the key of a change moves with the content of a named file', async (t) => {
  const repo = withRepo(t, { files: { ...BASE_FILES, 'tests/rules.test.mjs': NAMING_TEST, 'docs/rules.md': 'old\n' } });
  const { rangeChange } = await loadScope();
  repo.write('docs/rules.md', 'new\n');
  const first = (await rangeChange(repo.dir, repo.baseSha)).key;
  repo.write('docs/rules.md', 'newer\n');
  assert.notEqual((await rangeChange(repo.dir, repo.baseSha)).key, first);
});

test('rangeChange lists a named markdown file and leaves out one no test names', async (t) => {
  const repo = withRepo(t, { files: { ...BASE_FILES, 'tests/rules.test.mjs': NAMING_TEST } });
  repo.write('docs/rules.md', 'new\n');
  repo.write('docs/unread.md', 'new\n');
  const { rangeChange } = await loadScope();
  const scope = await rangeChange(repo.dir, repo.baseSha);
  assert.deepEqual(scope.named, ['docs/rules.md']);
  assert.deepEqual(scope.files, []);
});
