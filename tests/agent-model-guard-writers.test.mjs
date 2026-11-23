// Tests for the writer isolation gate of home/hooks/agent-model-guard.mjs and the finish record agent-budget.mjs keeps on SubagentStop
// (lib/writer-agents.mjs): a writing agent launched while another writing agent of the session still runs must carry
// `isolation: "worktree"` or name its own lane worktree on a `worktree:` brief line (checked with git), else it is denied once with
// advice and the identical call sent again runs. Read-only agents are exempt.
// Each test gets a private HOME (launch record, advice store, agent files) and its own session id.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hookEnv } from './hook-env.mjs';
import { IDLE_MS, MAX_RUNNING_AGENTS, PENDING_MS } from '../home/hooks/lib/agent-launches.mjs';
import { callCounterPath, worktreeValues } from '../home/hooks/lib/writer-agents.mjs';
import { fastestMs } from './timing.mjs';
import { git, makeRepo } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const GUARD = fileURLToPath(new URL('../home/hooks/agent-model-guard.mjs', import.meta.url));
const BUDGET = fileURLToPath(new URL('../home/hooks/agent-budget.mjs', import.meta.url));
const HOOK_TIMEOUT_MS = 5000;
const PARALLEL_LAUNCHES = 6;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
// The spans lib/writer-agents.mjs searches for a `worktree:` line (MAX_SCAN_CHARS, BRIEF_FILE_BYTES) and the room left for the line itself
const PROMPT_SCAN_CHARS = 32 * 1024;
const BRIEF_FILE_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 4096;
let counter = 0;

/**
 * A private HOME; launch(toolInput) sends one Agent call and returns its hookSpecificOutput (null when silent); stop(...) ends one.
 * @param {{cwd?: string, env?: Record<string, string>}} [options] the lead's folder (default: a new plain folder) and extra variables
 */
function writerSession({ cwd, env: extraEnv = {} } = {}) {
  const home = makeTempDir('writer-gate-home-');
  const project = cwd ?? makeTempDir('writer-gate-project-');
  const session = `writers-${process.pid}-${counter++}`;
  const env = hookEnv({ HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: project, ...extraEnv });
  const input = (toolInput) => JSON.stringify({ hook_event_name: 'PreToolUse', session_id: session, cwd: project, tool_name: 'Agent', tool_input: toolInput });
  const parse = ({ status, stdout, stderr }) => {
    assert.equal(status, 0, stderr);
    return stdout === '' ? null : JSON.parse(stdout).hookSpecificOutput;
  };
  return {
    home,
    session,
    launch: (toolInput) => parse(spawnSync(process.execPath, [GUARD], { input: input(toolInput), encoding: 'utf8', env, timeout: HOOK_TIMEOUT_MS })),
    launchAsync: (toolInput) => new Promise((resolve) => {
      const child = spawn(process.execPath, [GUARD], { env });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.on('close', (status) => resolve(parse({ status, stdout, stderr: '' })));
      child.stdin.end(input(toolInput));
    }),
    start: (agentId, agentType) => {
      const startInput = { hook_event_name: 'SubagentStart', session_id: session, agent_id: agentId, agent_type: agentType };
      const { status, stderr } = spawnSync(process.execPath, [BUDGET], { input: JSON.stringify(startInput), encoding: 'utf8', env });
      assert.equal(status, 0, stderr);
    },
    store: (record) => {
      const dir = join(home, '.claude', 'state', 'agent-writers');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, `${session}.json`), JSON.stringify(record), { mode: 0o600 });
    },
    stop: (agentId, agentType) => {
      const stopInput = { hook_event_name: 'SubagentStop', session_id: session, agent_id: agentId, agent_type: agentType, last_assistant_message: 'done', stop_hook_active: false };
      const { status, stderr } = spawnSync(process.execPath, [BUDGET], { input: JSON.stringify(stopInput), encoding: 'utf8', env });
      assert.equal(status, 0, stderr);
    },
  };
}

const denied = (out) => out?.permissionDecision === 'deny';
const writer = (type, extra = {}) => ({ description: 'build', prompt: `do the ${type} job`, subagent_type: type, ...extra });

test('a second writer without isolation while a writer runs is denied once with the worktree advice; the identical retry runs', () => {
  const s = writerSession();
  assert.ok(!denied(s.launch(writer('general-purpose'))), 'the first writer runs');
  const second = s.launch(writer('implementer'));
  assert.ok(denied(second), 'a second writer in the shared folder');
  assert.match(second.permissionDecisionReason, /isolation: "worktree"/);
  assert.match(second.permissionDecisionReason, /another writing agent .* still running/i);
  assert.ok(!denied(s.launch(writer('implementer'))), 'the identical call sent again runs');
  assert.ok(denied(s.launch(writer('ui-implementer'))), 'two writers run now: a third one is denied too');
});

test('a writer with isolation "worktree" runs next to running writers, and does not stop a writer without isolation', () => {
  const s = writerSession();
  assert.equal(s.launch(writer('ui-implementer', { isolation: 'worktree', prompt: 'MATRIX: none: one-file tweak, no Figma frame' })), null);
  assert.ok(!denied(s.launch(writer('implementer'))), 'an isolated writer does not stop a non-isolated one');
  assert.equal(s.launch(writer('implementer', { isolation: 'worktree', prompt: 'other job' })), null);
});

test('read-only agents are exempt and never count as running writers; an omitted type is general-purpose (a writer)', () => {
  const readOnlyTypes = ['scout', 'runner', 'Explore', 'Plan', 'architect'];
  for (const type of readOnlyTypes) {
    const s = writerSession(); // one session per type: the agent cap (5 running at once) counts read-only agents too
    mkdirSync(join(s.home, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(s.home, '.claude', 'agents', 'architect.md'), '---\nname: architect\ntools: Read, Grep, Write\n---\n');
    assert.ok(!denied(s.launch(writer(type))), `${type} alone`);
    assert.ok(!denied(s.launch(writer(type, { prompt: 'second' }))), `${type} next to ${type}`);
    assert.ok(!denied(s.launch({ description: 'x', prompt: 'no type' })), `the first writer runs although ${type} ran`);
    assert.ok(!denied(s.launch(writer(type, { prompt: 'while a writer runs' }))), `${type} while a writer runs`);
    assert.ok(denied(s.launch({ description: 'y', prompt: 'no type again' })), `a second writer next to the running one (${type} did not count)`);
  }
});

test('an agent file whose tools include Write or Edit is a writer; one without, a fork and a plugin agent are not', () => {
  const s = writerSession();
  mkdirSync(join(s.home, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(s.home, '.claude', 'agents', 'doc-writer.md'), '---\nname: doc-writer\ntools: Read, Edit\n---\n');
  writeFileSync(join(s.home, '.claude', 'agents', 'lister.md'), '---\nname: lister\ntools: Read, Grep\n---\n');
  assert.ok(!denied(s.launch(writer('doc-writer'))));
  for (const type of ['lister', 'fork', 'some-plugin:helper']) assert.ok(!denied(s.launch(writer(type))), type);
  assert.ok(denied(s.launch(writer('doc-writer', { prompt: 'second doc job' }))), 'two doc-writers');
});

test('a writer that stopped (SubagentStop) no longer counts; a repeated stop of the same agent ends only one launch', () => {
  const s = writerSession();
  s.launch(writer('implementer', { prompt: 'one' }));
  s.launch(writer('implementer', { prompt: 'two' })); // denied once
  s.launch(writer('implementer', { prompt: 'two' })); // the identical retry runs: two plain writers are recorded
  s.stop('agent-1', 'implementer');
  s.stop('agent-1', 'implementer'); // a stop blocked by another gate comes again
  assert.ok(denied(s.launch(writer('implementer', { prompt: 'three' }))), 'one implementer still runs');
  s.stop('agent-2', 'implementer');
  assert.ok(!denied(s.launch(writer('implementer', { prompt: 'four' }))), 'all writers stopped');
  s.stop('agent-3', 'scout');
  assert.ok(denied(s.launch(writer('general-purpose'))), 'a read-only stop ends no writer');
});

test('writers launched in parallel in one message: exactly one runs without isolation', async () => {
  const s = writerSession();
  const outs = await Promise.all(Array.from({ length: PARALLEL_LAUNCHES }, (_, i) => s.launchAsync(writer('implementer', { prompt: `lane ${i}` }))));
  assert.equal(outs.filter((out) => !denied(out)).length, 1, JSON.stringify(outs));
});

test('a launch older than the stale limit no longer counts (an agent that ended without SubagentStop)', () => {
  const s = writerSession();
  const dir = join(s.home, '.claude', 'state', 'agent-writers');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `${s.session}.json`), JSON.stringify({ launches: [{ type: 'implementer', at: Date.now() - FIVE_HOURS_MS }], stopped: [] }), { mode: 0o600 });
  assert.ok(!denied(s.launch(writer('implementer'))));
});

// Audit of db40977 (S3): a launch the owner denied, a sibling hook denied or Esc cut before it started has no SubagentStart and never a
// SubagentStop; it stayed "running" for 4 h and every later writer was denied once with a phantom "wait until it has finished".
const MINUTE_MS = 60 * 1000;

test('a launch with no SubagentStart counts only for PENDING_MS (a denied or never-started launch is no running writer after that)', () => {
  const s = writerSession();
  s.store({ launches: [{ type: 'implementer', at: Date.now() - PENDING_MS - 1000 }], stopped: [] });
  assert.ok(!denied(s.launch(writer('implementer'))), 'the never-started launch has expired');
  s.store({ launches: [{ type: 'implementer', at: Date.now() - PENDING_MS + 30_000 }], stopped: [] });
  assert.ok(denied(s.launch(writer('implementer', { prompt: 'just launched next to it' }))), 'a launch of a moment ago may still be starting');
});

test('a started writer (SubagentStart) counts while it works and stops counting after IDLE_MS without a tool call', () => {
  const s = writerSession();
  s.launch(writer('implementer', { prompt: 'one' }));
  s.start('agent-started-1', 'implementer');
  const record = JSON.parse(readFileSync(join(s.home, '.claude', 'state', 'agent-writers', `${s.session}.json`), 'utf8'));
  assert.equal(record.launches[0].agent, 'agent-started-1');
  s.store({ launches: [{ ...record.launches[0], at: Date.now() - PENDING_MS - MINUTE_MS }], stopped: [] });
  assert.ok(denied(s.launch(writer('implementer', { prompt: 'two' }))), 'started 3 min ago: still running');
  s.store({ launches: [{ ...record.launches[0], at: Date.now() - IDLE_MS - MINUTE_MS }], stopped: [] });
  assert.ok(!denied(s.launch(writer('implementer', { prompt: 'three' }))), 'no tool call for over IDLE_MS: no longer running');
});

test('a tool call of the started writer (its call counter) keeps it running past IDLE_MS from its start', () => {
  const s = writerSession();
  const agent = `agent-busy-${process.pid}-${counter++}`;
  s.store({ launches: [{ type: 'implementer', at: Date.now() - IDLE_MS - MINUTE_MS, agent }], stopped: [] });
  const counterFile = callCounterPath(s.session, agent);
  mkdirSync(dirname(counterFile), { recursive: true });
  writeFileSync(counterFile, '...');
  assert.ok(denied(s.launch(writer('implementer', { prompt: 'next to a busy one' }))));
  rmSync(counterFile, { force: true });
});

test('a launch dated ahead of the clock never counts (clock step back, a planted record)', () => {
  const s = writerSession();
  s.store({ launches: [{ type: 'implementer', at: Date.now() + 10 * MINUTE_MS }], stopped: [] });
  assert.ok(!denied(s.launch(writer('implementer'))));
});

test('a stop ends the launch of its own agent id first', () => {
  const s = writerSession();
  s.launch(writer('implementer', { prompt: 'one' }));
  s.launch(writer('implementer', { prompt: 'two', isolation: 'worktree' }));
  s.start('agent-a', 'implementer');
  s.start('agent-b', 'implementer');
  s.stop('agent-b', 'implementer');
  const { launches } = JSON.parse(readFileSync(join(s.home, '.claude', 'state', 'agent-writers', `${s.session}.json`), 'utf8'));
  assert.deepEqual(launches.map((launch) => launch.agent), ['agent-a']);
});

// Writer-guard lane (road solid, friction finding 1): 253 launches in 7 days were refused although 109 of 190 lead briefs named the
// agent's own worktree; the identical resend then ran. A `worktree:` line now counts as isolation, but only for a folder git lists.
const NO_SH_GIT = process.platform === 'win32' && 'the fake git is a shell script';

/** A repo with linked lane worktrees under .claude/worktrees/, as the lead makes them before the launch; `worktree` is the first; real paths. */
function repoWithLaneWorktree(lanes = ['lane-a']) {
  const repo = makeRepo();
  const worktrees = lanes.map((lane) => {
    const path = join(repo, '.claude', 'worktrees', lane);
    git(repo, 'worktree', 'add', '-q', '-b', `fix/${lane}`, path);
    return realpathSync(path);
  });
  return { repo, worktree: worktrees[0], worktrees };
}

const recordOf = (s) => JSON.parse(readFileSync(join(s.home, '.claude', 'state', 'agent-writers', `${s.session}.json`), 'utf8'));
const laneBrief = (path) => `Build lane two.\nworktree: ${path}\nBASE: 0000000`;

test('a writer whose brief names its own lane worktree runs next to a running writer, recorded isolated with that folder', () => {
  const { repo, worktrees: [worktree, other] } = repoWithLaneWorktree(['lane-a', 'lane-b']);
  const s = writerSession({ cwd: repo });
  assert.ok(!denied(s.launch(writer('implementer', { prompt: 'lane one' }))), 'the first writer runs');
  assert.ok(!denied(s.launch(writer('implementer', { prompt: laneBrief(worktree) }))), 'the lane worktree writer is not refused');
  assert.ok(!denied(s.launch(writer('implementer', { prompt: `Lane three.\n  worktree: \`${other}\`` }))), 'a quoted value counts too');
  const { launches, open } = recordOf(s);
  assert.deepEqual(launches.map((launch) => launch.isolated === true), [false, true, true]);
  assert.equal(open[1].cwd, worktree, 'the resume notice looks at the lane worktree');
  assert.ok(denied(s.launch(writer('implementer', { prompt: 'lane four, no worktree line' }))), 'a plain writer still gets the advice');
});

test('a `worktree:` line in a brief file the prompt names counts; a brief file naming no worktree does not', () => {
  const { repo, worktree } = repoWithLaneWorktree();
  const folder = makeTempDir('writer-gate-brief-');
  writeFileSync(join(folder, 'lane.md'), `Objective: lane two.\nworktree: ${worktree}\n`);
  writeFileSync(join(folder, 'other.md'), `Objective: lane three.\nworktree: ${join(repo, '.claude', 'worktrees', 'lane-b')}\n`);
  const s = writerSession({ cwd: repo });
  s.launch(writer('implementer', { prompt: 'lane one' }));
  assert.ok(!denied(s.launch(writer('implementer', { prompt: `Read ${join(folder, 'lane.md')} and follow it with LANE = lane-a.` }))));
  assert.ok(denied(s.launch(writer('implementer', { prompt: `Read \`${join(folder, 'other.md')}\` and follow it.` }))), 'lane-b was never made');
});

test('a lane worktree a running writer already holds is no isolation: denied once, the retry runs as a plain writer', () => {
  const { repo, worktree } = repoWithLaneWorktree();
  const s = writerSession({ cwd: repo });
  assert.ok(!denied(s.launch(writer('implementer', { prompt: laneBrief(worktree) }))), 'the first writer of the worktree runs');
  const second = s.launch(writer('implementer', { prompt: `Lane two.\nworktree: ${worktree}` }));
  assert.ok(denied(second), 'a second writer naming the same worktree gets the advice');
  assert.match(second.permissionDecisionReason, /`worktree: <absolute path>`/);
  assert.ok(!denied(s.launch(writer('implementer', { prompt: `Lane two.\nworktree: ${worktree}` }))), 'the identical resend runs');
  assert.deepEqual(recordOf(s).launches.map((launch) => launch.isolated === true), [true, false], 'the resend is recorded plain');
  assert.ok(denied(s.launch(writer('implementer', { prompt: 'lane three' }))), 'a plain writer runs now, so a third one bounces');
});

test('a held worktree is free again once its writer stops; a read-only brief naming it is never held', () => {
  const { repo, worktree } = repoWithLaneWorktree();
  const s = writerSession({ cwd: repo });
  s.launch(writer('implementer', { prompt: laneBrief(worktree) }));
  s.start('agent-1', 'implementer');
  assert.ok(!denied(s.launch(writer('implementer', { prompt: `read-only: check lane one\nworktree: ${worktree}` }))), 'read-only is exempt');
  s.stop('agent-1', 'implementer');
  assert.ok(!denied(s.launch(writer('implementer', { prompt: `Lane one again.\nworktree: ${worktree}` }))), 'the folder is free again');
});

test('writers launched in parallel naming one lane worktree: exactly one runs', async () => {
  const { repo, worktree } = repoWithLaneWorktree();
  const s = writerSession({ cwd: repo });
  const briefs = Array.from({ length: MAX_RUNNING_AGENTS - 1 }, (_, i) => writer('implementer', { prompt: `Lane ${i}.\nworktree: ${worktree}` }));
  const outs = await Promise.all(briefs.map((brief) => s.launchAsync(brief)));
  assert.equal(outs.filter((out) => !denied(out)).length, 1, JSON.stringify(outs));
});

test('the search span: a prompt\'s first 32K characters, all of a brief file\'s first 64 KB', () => {
  const { repo, worktrees: [first, second] } = repoWithLaneWorktree(['lane-a', 'lane-b']);
  const folder = makeTempDir('writer-gate-span-');
  const filler = `${'pasted material line\n'.repeat(Math.ceil(PROMPT_SCAN_CHARS / 21))}`; // just past the prompt span
  writeFileSync(join(folder, 'long.md'), `${filler}worktree: ${first}\n`);
  assert.ok(Buffer.byteLength(filler) > PROMPT_SCAN_CHARS && Buffer.byteLength(filler) < BRIEF_FILE_BYTES - MAX_PATH_BYTES);
  const s = writerSession({ cwd: repo });
  s.launch(writer('implementer', { prompt: 'lane one' }));
  assert.ok(!denied(s.launch(writer('implementer', { prompt: `Read ${join(folder, 'long.md')} and follow it.` }))), 'a brief file line past 32K counts');
  assert.ok(denied(s.launch(writer('implementer', { prompt: `${filler}worktree: ${second}` }))), 'a prompt line past 32K is pasted material');
});

test('a made-up path, the lead\'s folder, a relative path, a Windows drive path and a plain folder still get the advice, which names roles', () => {
  const { repo, worktree } = repoWithLaneWorktree();
  const cases = [
    ['a made-up path', repo, join(repo, '.claude', 'worktrees', 'no-such-lane')],
    ['the lead\'s folder (the main checkout)', repo, repo],
    ['the lead\'s folder (the lead works in the lane worktree)', worktree, worktree],
    ['a relative path', repo, '.claude/worktrees/lane-a'],
    ['a Windows drive path', repo, 'C:\\Users\\me\\repo\\.claude\\worktrees\\lane-a'],
    ['a folder that is no worktree', repo, realpathSync(makeTempDir('writer-gate-plain-'))],
  ];
  for (const [name, cwd, path] of cases) {
    const s = writerSession({ cwd });
    s.launch(writer('implementer', { prompt: 'lane one' }));
    const second = s.launch({ description: 'build', prompt: laneBrief(path), subagent_type: 'general-purpose' });
    assert.ok(denied(second), name);
    assert.match(second.permissionDecisionReason, /`worktree: <absolute path>`/, name);
    assert.match(second.permissionDecisionReason, /`implementer`.*`scout`, `runner` or `reviewer`/, `${name}: the advice names the roles`);
    assert.doesNotMatch(second.permissionDecisionReason, /general-purpose/, `${name}: the advice never sends the job to general-purpose`);
    assert.ok(!denied(s.launch({ description: 'build', prompt: laneBrief(path), subagent_type: 'general-purpose' })), `${name}: the identical resend runs`);
  }
});

test('a git that hangs or fails is no isolation: the advice comes, within the hook timeout', { skip: NO_SH_GIT }, () => {
  const { repo, worktree } = repoWithLaneWorktree();
  for (const body of ['exec sleep 30', 'exit 128']) {
    const bin = makeTempDir('writer-gate-fake-git-');
    writeFileSync(join(bin, 'git'), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, 'git'), 0o755);
    const s = writerSession({ cwd: repo, env: { PATH: `${bin}${delimiter}${process.env.PATH}` } });
    s.launch(writer('implementer', { prompt: 'lane one' }));
    assert.ok(denied(s.launch(writer('implementer', { prompt: laneBrief(worktree) }))), body); // launch fails past HOOK_TIMEOUT_MS
  }
});

// Writer-line lane (real run R22, X6): 56 of 105 briefs wrote the header on one line (`BASE: … · BRANCH: … · worktree: …`) and the PC
// lead wrote it as a list item (`- worktree: …`); neither was read, so every such lane writer was sent back once.
const SHA = '0'.repeat(40);
const QUOTED_LINE_CHARS = 160; // the most of a near-miss line the advice quotes
/** The line as the advice quotes it: whole, or its first 159 characters and "…" (temp paths make the header lines long). */
const quoteOf = (line) => (line.length > QUOTED_LINE_CHARS ? `${line.slice(0, QUOTED_LINE_CHARS - 1)}…` : line);

test('a `worktree:` field after a header separator or as a list item is read: isolated, no advice on the first send', () => {
  const { repo, worktrees } = repoWithLaneWorktree(['lane-a', 'lane-b', 'lane-c', 'lane-d', 'lane-e', 'lane-f']);
  const briefs = [
    (path) => `Build it.\nBASE: ${SHA} · BRANCH: lane/x · worktree: ${path}\nGo.`,
    (path) => `BASE: ${SHA} | BRANCH: lane/x | worktree: ${path} | REPORTS: /tmp/r`,
    (path) => `BASE: ${SHA}; worktree: ${path}; BRANCH: lane/x`,
    (path) => `BASE: ${SHA}, BRANCH: lane/x, worktree: \`${path}\``,
    (path) => `Lane:\n- worktree: ${path}\n- BRANCH: lane/x`,
    (path) => `Lane:\n  * worktree: ${path}`,
  ];
  briefs.forEach((brief, index) => {
    const s = writerSession({ cwd: repo });
    assert.ok(!denied(s.launch(writer('implementer', { prompt: 'lane one' }))), 'the first writer runs');
    assert.equal(s.launch(writer('implementer', { prompt: brief(worktrees[index]) })), null, brief('<path>'));
    assert.deepEqual(recordOf(s).launches.map((launch) => launch.isolated === true), [false, true], brief('<path>'));
    assert.equal(recordOf(s).open[1].cwd, worktrees[index], 'the open record holds the lane worktree');
  });
});

test('prose naming a worktree with no separator before it is not read; the advice quotes that line', () => {
  const { repo, worktree } = repoWithLaneWorktree();
  const s = writerSession({ cwd: repo });
  s.launch(writer('implementer', { prompt: 'lane one' }));
  const prose = `Then check the worktree: ${worktree} for the files.`;
  const second = s.launch(writer('implementer', { prompt: `Lane two.\n${prose}` }));
  assert.ok(denied(second), 'prose is no brief line');
  assert.ok(second.permissionDecisionReason.includes(`\`${quoteOf(prose)}\` was not read`), second.permissionDecisionReason);
});

test('a header line naming the lead\'s folder or a held worktree gets the advice, quoting the line', () => {
  const { repo, worktree } = repoWithLaneWorktree();
  const lead = writerSession({ cwd: repo });
  lead.launch(writer('implementer', { prompt: 'lane one' }));
  const own = `BASE: ${SHA} · BRANCH: lane/x · worktree: ${repo}`;
  const leadFolder = lead.launch(writer('implementer', { prompt: own }));
  assert.ok(denied(leadFolder), 'the lead\'s folder is no lane');
  assert.ok(leadFolder.permissionDecisionReason.includes(`\`${quoteOf(own)}\` names no worktree`), leadFolder.permissionDecisionReason);
  const s = writerSession({ cwd: repo });
  const header = `BASE: ${SHA} · BRANCH: lane/x · worktree: ${worktree}`;
  assert.equal(s.launch(writer('implementer', { prompt: header })), null, 'the first writer of the worktree runs');
  const held = s.launch(writer('implementer', { prompt: `Second.\n${header}` }));
  assert.ok(denied(held), 'a second writer naming the same worktree gets the advice');
  assert.ok(held.permissionDecisionReason.includes(`\`${quoteOf(header)}\` names no worktree`), held.permissionDecisionReason);
  assert.ok(!denied(s.launch(writer('implementer', { prompt: `Second.\n${header}` }))), 'the identical resend runs');
  assert.deepEqual(recordOf(s).launches.map((launch) => launch.isolated === true), [true, false], 'the resend is recorded plain');
});

test('the quoted near-miss line loses control characters and is cut; a 1 MB prompt is read only within its first 32K', () => {
  const { repo, worktree } = repoWithLaneWorktree();
  const s = writerSession({ cwd: repo });
  s.launch(writer('implementer', { prompt: 'lane one' }));
  const hostile = `See worktree:\u0007\u202e ${'x'.repeat(300)}`;
  const out = s.launch(writer('implementer', { prompt: `Lane two.\n${hostile}` }));
  const quotedLine = out.permissionDecisionReason.match(/`([^`]*)` was not read/)?.[1];
  assert.ok(quotedLine !== undefined, out.permissionDecisionReason);
  assert.ok(quotedLine.length <= QUOTED_LINE_CHARS, `${quotedLine.length} characters`);
  assert.doesNotMatch(quotedLine, /[\u0007\u202e]/);
  assert.ok(quotedLine.startsWith('See worktree: xxx'));
  const filler = 'pasted material line\n'.repeat(50_000); // about 1 MB
  const started = performance.now();
  const huge = s.launch(writer('implementer', { prompt: `${filler}BASE: ${SHA} · worktree: ${worktree}` }));
  assert.ok(performance.now() - started < HOOK_TIMEOUT_MS);
  assert.ok(denied(huge), 'a line past the first 32K is pasted material');
  assert.doesNotMatch(huge.permissionDecisionReason, /was not read|names no worktree/, 'nothing past the span is quoted');
});

test('worktreeValues: the value of each field, Windows paths whole; prose, other keys and other case are not read', () => {
  assert.deepEqual(worktreeValues(`BASE: ${SHA} · worktree: C:\\x\\lane-1 · BRANCH: y`), ['C:\\x\\lane-1']);
  assert.deepEqual(worktreeValues('BASE: a;worktree: C:\\Users\\me\\lane 2; BRANCH: b'), ['C:\\Users\\me\\lane 2']);
  assert.deepEqual(worktreeValues('worktree: /a/b;c,d\n- worktree: "/e f"\n+ worktree: /g, then go'), ['/a/b;c,d', '/e f', '/g']);
  assert.deepEqual(worktreeValues('the worktree: /x\nWorktree: /y\nmy-worktree: /z\n-worktree: /w\nBRANCH: worktree:/v'), []);
  const hostile = `${',worktree:'.repeat(4000)}\n${' '.repeat(30_000)}·worktree: /p`;
  assert.ok(fastestMs(() => worktreeValues(hostile)) < 200, 'linear in the text');
});
