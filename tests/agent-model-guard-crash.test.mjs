// Tests for the outer catch of home/hooks/agent-model-guard.mjs: a guard that throws while its gates decide denies the Agent call
// (the no-Fable gate fails closed). No plain hook input reaches that catch (every gate catches its own errors), so each test runs a
// copy of home/hooks in a temp folder whose agent-budget.mjs throws in claimMainSlot. Each test has a private HOME and hooks copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentHomeEnv } from './agent-home-helpers.mjs';
import { FROM_BOSS } from './agent-call-origin.mjs';
import { hookEnv } from './hook-env.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const HOOKS = fileURLToPath(new URL('../home/hooks', import.meta.url));
const HOOK_TIMEOUT_MS = 20_000;
const REAL_BUDGET = 'agent-budget-real.mjs';
let counter = 0;

/**
 * A copy of home/hooks whose claimMainSlot throws `message`; every other export of agent-budget.mjs is the real one, so the hook loads.
 * @returns {string} the absolute path of the copy's agent-model-guard.mjs (the hook runs only when started by its own path)
 */
function hooksWithThrowingSlot(message) {
  const hooks = join(makeTempDir('guard-crash-hooks-'), 'hooks');
  cpSync(HOOKS, hooks, { recursive: true });
  renameSync(join(hooks, 'agent-budget.mjs'), join(hooks, REAL_BUDGET));
  writeFileSync(join(hooks, 'agent-budget.mjs'), [
    `export * from './${REAL_BUDGET}';`, // a local export below wins over the star export of the same name
    `export function claimMainSlot() { throw new Error(${JSON.stringify(message)}); }`,
    '',
  ].join('\n'));
  return join(hooks, 'agent-model-guard.mjs');
}

/** Runs `hook` once with a dev call from the boss (it passes the route, no-Fable, copy-branch and UI gates before claimMainSlot). */
function sendDevCall(hook) {
  const home = makeTempDir('guard-crash-home-');
  const project = makeTempDir('guard-crash-project-');
  const env = hookEnv({ HOME: home, USERPROFILE: home, TMPDIR: makeTempDir('guard-crash-tmp-'), CLAUDE_PROJECT_DIR: project, ...agentHomeEnv(home) });
  const input = {
    hook_event_name: 'PreToolUse', session_id: `guard-crash-${process.pid}-${counter++}`, cwd: project, tool_name: 'Agent',
    tool_input: { description: 'job', prompt: 'do the job', subagent_type: 'dev' }, ...FROM_BOSS,
  };
  return spawnSync(process.execPath, [hook], { input: JSON.stringify(input), encoding: 'utf8', env, cwd: project, timeout: HOOK_TIMEOUT_MS });
}

const crashReason = (message) => `agent-model-guard failed (${message}), so the call is denied; send it again, or fix the hook`;

test('hook: a throw inside the gates denies the call (exit 0, one deny JSON line) and names the error on stderr', () => {
  const message = 'slot store exploded';
  const r = sendDevCall(hooksWithThrowingSlot(message));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, `agent-model-guard: ${message}\n`);
  assert.equal(r.stdout.split('\n').length, 2, `one line and its newline: ${r.stdout}`);
  assert.deepEqual(JSON.parse(r.stdout), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: crashReason(message) },
  });
});

test('hook: a multi-line error message is folded to one line on stderr and in the deny reason', () => {
  const r = sendDevCall(hooksWithThrowingSlot('slot store\n  exploded\tbadly'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, 'agent-model-guard: slot store exploded badly\n');
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny');
  assert.equal(out.permissionDecisionReason, crashReason('slot store exploded badly'));
});
