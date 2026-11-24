// Shared fixtures of the git-tidy-gate tests: a private HOME with the real hook process, an in-process gate and an old lane.
// Invariants: every gate gets its own temp HOME, and CLEAN_ENV carries no CLAUDE_CODE_SESSION_ID or CLAUDE_SESSION_ID, so the gate never
// reads the real session's state.
// Exports: SESSION, HOUR_MS, CHECK_TIMEOUT_FOR_TESTS_MS, gateSession, inProcessGate, oldLane.
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contextFor } from '../home/hooks/git-tidy-gate.mjs';
import { CLEAN_ENV, git } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

export const HOOK = fileURLToPath(new URL('../home/hooks/git-tidy-gate.mjs', import.meta.url));
export const SESSION = 'sess-1';
export const HOUR_MS = 60 * 60 * 1000;
export const CHECK_TIMEOUT_FOR_TESTS_MS = 60_000; // the suite runs test files in parallel; a check must not time out because the machine is busy

/** A private HOME and `start(project)`: the SessionStart context the real hook process prints for that project, null for none. */
export function gateSession() {
  const home = makeTempDir('git-tidy-gate-home-');
  const run = (input, project) => {
    const env = { ...CLEAN_ENV, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: project, GIT_TIDY_GATE_CHECK_TIMEOUT_MS: String(CHECK_TIMEOUT_FOR_TESTS_MS) };
    return spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8', env });
  };
  const start = (project, extra = {}) => {
    const result = run({ hook_event_name: 'SessionStart', source: 'startup', session_id: SESSION, cwd: project, ...extra }, project);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    if (result.stdout === '') return null;
    const out = JSON.parse(result.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
    return out.hookSpecificOutput.additionalContext;
  };
  return { home, run, start };
}

/** The gate in process for `dir`: `start(deps)` gives contextFor's text for a SessionStart there. */
export function inProcessGate(dir) {
  const home = makeTempDir('git-tidy-gate-home-');
  const env = { ...CLEAN_ENV, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: dir, GIT_TIDY_GATE_CHECK_TIMEOUT_MS: String(CHECK_TIMEOUT_FOR_TESTS_MS) };
  return { home, env, start: (deps = {}) => contextFor({ hook_event_name: 'SessionStart', session_id: SESSION, cwd: dir }, env, deps) };
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
