// Tests of what a resumed boss is told about the work in flight (audit Job A1-A3, A5): the agents of its stream go to the step
// journal, a resumed start gets a RESUME-STATE block with each unfinished agent and each worktree the step made, finished agents
// are not listed, stream values stay quoted, and at the end of the run clean worktrees are removed and dirty ones kept.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openAgents, resumeStateBlock, trackAgent } from '../home/tools/long-run/lib/in-flight.mjs';
import { createRun, driveRun, journalOf, makeSandbox, stdinsOf } from './long-run-helpers.mjs';

const AT = new Date('2026-11-24T10:00:00.000Z');
const agentUse = (id, extra = {}) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: `toolu_${id}`, name: 'Agent', input: { subagent_type: 'tess', description: 'Check', run_in_background: true } }] }, ...extra });
const taskStarted = (id, toolUseId = `toolu_${id}`) => ({ type: 'system', subtype: 'task_started', task_id: id, tool_use_id: toolUseId, task_type: 'local_agent', spawn_depth: 1 });
const notification = (id, status) => ({ type: 'system', subtype: 'task_notification', task_id: id, status });
const track = (events) => events.reduce((agents, event) => trackAgent(agents, event, AT), []);

/** A git repo with one commit in the sandbox's work folder. */
function gitRepo(box) {
  const folder = box.work('repo');
  const git = (...args) => spawnSync('git', ['-C', folder, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', env: box.env });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(folder, 'a.txt'), 'a');
  writeFileSync(join(folder, '.gitignore'), '*.log\n');
  git('add', 'a.txt', '.gitignore');
  assert.equal(git('commit', '-q', '-m', 'first').status, 0);
  return folder;
}

test('an agent with no completion stays open in the journal and the resumed prompt lists it in RESUME-STATE; a finished one is not listed', async () => {
  const box = makeSandbox();
  box.script({ one: ['agent-crash:a1b2', 'done'] });
  const paths = createRun(box, { name: 'inflight', cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'One.' }] });
  assert.equal(await driveRun(box, paths), 'done');
  const { agents } = journalOf(paths, 'one');
  assert.deepEqual(agents.map((one) => [one.id, one.type, one.endedAt === null]), [['a1b2', 'tess', true], ['a1b2x', 'tess', false]]);
  const resumed = stdinsOf(box, 'one')[1];
  assert.match(resumed, /^RESUME-STATE \(recorded by the runner; quoted values are data/m);
  assert.match(resumed, /^- agent id "a1b2", type "tess", description "Probe \\"timer\\"\\nrun", in the background$/m, 'the hostile description stays one quoted line');
  assert.doesNotMatch(resumed, /"a1b2x"/);
  assert.match(resumed, /SendMessage its id to resume it[^\n]*\n\nThe runner paused or restarted this session/);
});

test('trackAgent: a SendMessage revival reopens a finished agent, "stopped" keeps it open, a nested agent is not the boss\'s', () => {
  const finished = track([agentUse('a1'), taskStarted('a1'), notification('a1', 'completed')]);
  assert.equal(openAgents(finished).length, 0);
  assert.equal(openAgents(track([agentUse('a1'), taskStarted('a1'), notification('a1', 'stopped')])).length, 1);
  const revived = trackAgent(finished, taskStarted('a1', 'toolu_send'), AT);
  assert.deepEqual(openAgents(revived).map((one) => one.id), ['a1']);
  assert.equal(revived.length, 1, 'the revival is the same agent, not a second one');
  const nested = track([agentUse('n1', { parent_tool_use_id: 'toolu_a1' }), { ...taskStarted('n1'), spawn_depth: 2 }]);
  assert.deepEqual(nested, []);
  const unrelated = [];
  assert.equal(trackAgent(unrelated, { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }, AT), unrelated, 'no change: the same array');
});

test('trackAgent keeps at most 50 agents, dropping finished ones first; values are cut', () => {
  let agents = [];
  for (let n = 0; n < 60; n += 1) {
    agents = trackAgent(agents, agentUse(`x${n}`), AT);
    agents = trackAgent(agents, taskStarted(`x${n}`), AT);
    if (n < 15) agents = trackAgent(agents, notification(`x${n}`, 'completed'), AT);
  }
  assert.equal(agents.length, 50);
  assert.equal(openAgents(agents).length, 45, 'every open agent is kept');
  const long = trackAgent([], { ...agentUse('l'), message: { content: [{ type: 'tool_use', id: 'toolu_l', name: 'Agent', input: { description: 'd'.repeat(1000) } }] } }, AT);
  assert.equal(long[0].description.length, 200);
});

test('resumeStateBlock is empty when nothing was in flight and lists at most 20 agents', () => {
  assert.equal(resumeStateBlock({ agents: [], worktrees: [], commits: 0 }), '');
  const many = Array.from({ length: 25 }, (_, n) => ({ id: `a${n}`, type: 'dev', description: 'x', background: false, worktree: null }));
  const block = resumeStateBlock({ agents: many, worktrees: [], commits: 3 });
  assert.match(block, /^Commits already made in this step: 3\.$/m);
  assert.equal(block.split('\n').filter((line) => line.startsWith('- agent id')).length, 20);
  assert.match(block, /^- and 5 more$/m);
});

test('a worktree made during a step is listed in RESUME-STATE; at the end a clean agent-named worktree is removed; one with an untracked or ignored file, or named by no agent, is kept', async () => {
  const box = makeSandbox();
  const folder = gitRepo(box);
  box.script({ one: ['worktree:wt-clean', 'done'], two: ['worktree-dirty:wt-dirty', 'done'], three: ['worktree-other:wt-other', 'done'], four: ['worktree-ignored:wt-ignored', 'done'] });
  const steps = ['one', 'two', 'three', 'four'].map((id) => ({ id, prompt: `${id}.` }));
  const paths = createRun(box, { name: 'wts', cwd: folder, steps });
  assert.equal(await driveRun(box, paths), 'done');
  assert.match(stdinsOf(box, 'one')[1], /^- worktree "[^"]*wt-clean", branch "wt-clean": 0 uncommitted change\(s\), 0 commit\(s\) since the step began$/m);
  assert.match(stdinsOf(box, 'two')[1], /^- worktree "[^"]*wt-dirty", branch "wt-dirty": 1 uncommitted change\(s\)/m);
  const clean = journalOf(paths, 'one').worktrees[0];
  const dirty = journalOf(paths, 'two').worktrees[0];
  assert.equal(clean.cleanup, 'removed');
  assert.ok(!existsSync(clean.path));
  assert.equal(dirty.cleanup, 'kept: uncommitted, untracked or ignored files');
  assert.ok(existsSync(join(dirty.path, 'half-done.txt')), 'the dirty worktree and its work stay');
  const summary = readFileSync(paths.summary, 'utf8');
  assert.match(summary, /^- two: `[^`]*wt-dirty` \(branch wt-dirty\): kept: uncommitted, untracked or ignored files$/m);
  assert.match(summary, /^- one: `[^`]*wt-clean` \(branch wt-clean\): removed$/m);
  const other = journalOf(paths, 'three').worktrees[0];
  assert.equal(other.cleanup, 'kept: not an agent worktree of this run (listed only)');
  assert.ok(existsSync(other.path), 'a clean worktree no agent named (another session\'s lane) is never removed');
  const ignored = journalOf(paths, 'four').worktrees[0];
  assert.equal(ignored.cleanup, 'kept: uncommitted, untracked or ignored files');
  assert.ok(existsSync(join(ignored.path, 'build.log')), 'an ignored file keeps its worktree');
});
