// Shared fixtures of the git-tidy-gate tests: a private HOME with the real hook process, the repo shapes the gate judges, and an in-process gate.
// Exports: SESSION, HOUR_MS, CHECK_TIMEOUT_FOR_TESTS_MS, gateSession, billAndGinShape, inProcessGate, oldLane, linkStatus.
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide } from '../home/hooks/git-tidy-gate.mjs';
import { runStatus } from '../home/tools/status/status.mjs';
import { CLEAN_ENV, commit, git, makeRepo } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/git-tidy-gate.mjs', import.meta.url));
export const SESSION = 'sess-1';
export const HOUR_MS = 60 * 60 * 1000;
export const CHECK_TIMEOUT_FOR_TESTS_MS = 60_000; // the suite runs test files in parallel; a check must not time out because the machine is busy

/** A private HOME and a way to send events of the lead (`stop`, `compact`) and of a subagent (`agentStop`) to the real hook process. */
export function gateSession() {
  const home = makeTempDir('git-tidy-gate-home-');
  const run = (input, project) => {
    const env = { ...CLEAN_ENV, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: project, GIT_TIDY_GATE_CHECK_TIMEOUT_MS: String(CHECK_TIMEOUT_FOR_TESTS_MS) };
    return spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8', env });
  };
  const verdict = (result) => {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    if (result.stdout === '') return null;
    const out = JSON.parse(result.stdout);
    assert.equal(out.decision, 'block');
    return out.reason;
  };
  const stop = (project, extra = {}) => verdict(run({ hook_event_name: 'Stop', session_id: SESSION, cwd: project, stop_hook_active: false, ...extra }, project));
  const compact = (project) => {
    const result = run({ hook_event_name: 'PreCompact', session_id: SESSION, cwd: project, trigger: 'auto' }, project);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.split('\n').filter((line) => line !== '');
  };
  const agentStop = (start, extra = {}) => {
    const transcript = join(makeTempDir('git-tidy-gate-agent-'), 'agent.jsonl');
    writeFileSync(transcript, `${JSON.stringify({ type: 'user', cwd: start })}\n`);
    const input = { hook_event_name: 'SubagentStop', session_id: SESSION, agent_id: 'a1', agent_type: 'implementer', cwd: start, agent_transcript_path: transcript, stop_hook_active: false, ...extra };
    return verdict(run(input, makeTempDir('git-tidy-gate-lead-')));
  };
  return { home, run, stop, compact, agentStop };
}

/** main plus lane/x and its re-do lane/x-2 (x is an ancestor of x-2, so x is a superseded copy) and two agent leftovers at the base tip. */
export function billAndGinShape() {
  const dir = makeRepo();
  git(dir, 'checkout', '-q', '-b', 'lane/x');
  commit(dir, 'a.txt');
  git(dir, 'checkout', '-q', '-b', 'lane/x-2');
  commit(dir, 'b.txt');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'branch', 'worktree-agent-aaa', 'main');
  git(dir, 'branch', 'worktree-agent-bbb', 'main');
  return dir;
}

export function inProcessGate(dir) {
  const home = makeTempDir('git-tidy-gate-home-');
  const env = { ...CLEAN_ENV, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: dir, GIT_TIDY_GATE_CHECK_TIMEOUT_MS: String(CHECK_TIMEOUT_FOR_TESTS_MS) };
  return { home, env, stop: (extra, deps) => decide({ hook_event_name: 'Stop', session_id: SESSION, cwd: dir, ...extra }, env, deps) };
}

const THREE_HOURS_AGO = new Date(Date.now() - 3 * HOUR_MS).toISOString();

/** A lane with one commit dated three hours ago, so `check` lists it as an `unlanded-lane?` hint. */
export function oldLane(dir, branch) {
  git(dir, 'checkout', '-q', '-b', branch);
  writeFileSync(join(dir, `${branch.replaceAll('/', '-')}.txt`), 'x');
  git(dir, 'add', '-A');
  const result = spawnSync('git', ['commit', '-q', '-m', `work on ${branch}`], { cwd: dir, env: { ...CLEAN_ENV, GIT_COMMITTER_DATE: THREE_HOURS_AGO, GIT_AUTHOR_DATE: THREE_HOURS_AGO } });
  assert.equal(result.status, 0, result.stderr.toString());
  git(dir, 'checkout', '-q', 'main');
}

/** A STATUS.md the session linked through a status edit, as in real use; `rows` are `[id, item, done?]`. */
export function linkStatus(gate, project, rows) {
  const file = join(project, 'STATUS.md');
  writeFileSync(file, '# status\n');
  const stateDir = join(gate.home, '.claude', 'state', 'estimate');
  mkdirSync(stateDir, { recursive: true });
  for (const [id, item, done] of rows) {
    assert.equal(runStatus(['--file', file, 'add', id, item, 'S'], { cwd: project, sessionId: SESSION, stateDir }).code, 0);
    if (done) assert.equal(runStatus(['--file', file, 'done', id, 'evidence'], { cwd: project, sessionId: SESSION, stateDir }).code, 0);
  }
}

