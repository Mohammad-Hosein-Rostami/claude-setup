// Repro tests for home/hooks/agent-model-guard.mjs when a module it imports statically fails to load (a half-synced or broken
// install): the import fails before the hook's own try/catch exists, so node exits 1 with empty stdout. Claude Code blocks a
// PreToolUse call only on exit 2 or a deny decision, so exit 1 lets the Agent call run (fail-open) past the no-Fable gate.
// Each test breaks lib/agent-brief.mjs in a temp copy of home/hooks and runs that copy with a private HOME.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentHomeEnv } from './agent-home-helpers.mjs';
import { FROM_BOSS } from './agent-call-origin.mjs';
import { hookEnv } from './hook-env.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const HOOKS = fileURLToPath(new URL('../home/hooks', import.meta.url));
const BROKEN_LIB = join('lib', 'agent-brief.mjs'); // imported by the hook and by agent-budget.mjs, writer-agents.mjs, ui-brief-gate.mjs
const HOOK_TIMEOUT_MS = 20_000;
const BLOCKING_EXIT = 2; // Claude Code's blocking exit code for a hook
let counter = 0;

/**
 * A copy of home/hooks with lib/agent-brief.mjs broken by `breakLib(path)`.
 * @returns {string} the absolute path of the copy's agent-model-guard.mjs (the hook runs only when started by its own path)
 */
function hooksWithBrokenLib(breakLib) {
  const hooks = join(makeTempDir('guard-loadfail-hooks-'), 'hooks');
  cpSync(HOOKS, hooks, { recursive: true });
  breakLib(join(hooks, BROKEN_LIB));
  return join(hooks, 'agent-model-guard.mjs');
}

/** Runs `hook` once with a plain dev call from the boss (the call the gates would let run). */
function sendDevCall(hook) {
  const home = makeTempDir('guard-loadfail-home-');
  const project = makeTempDir('guard-loadfail-project-');
  const env = hookEnv({ HOME: home, USERPROFILE: home, TMPDIR: makeTempDir('guard-loadfail-tmp-'), CLAUDE_PROJECT_DIR: project, ...agentHomeEnv(home) });
  const input = {
    hook_event_name: 'PreToolUse', session_id: `guard-loadfail-${process.pid}-${counter++}`, cwd: project, tool_name: 'Agent',
    tool_input: { description: 'job', prompt: 'do the job', subagent_type: 'dev' }, ...FROM_BOSS,
  };
  return spawnSync(process.execPath, [hook], { input: JSON.stringify(input), encoding: 'utf8', env, cwd: project, timeout: HOOK_TIMEOUT_MS });
}

/** Fails unless the run blocks the call the way Claude Code honours: exit 2, or exit 0 with a deny decision on stdout. */
function assertBlocks(run) {
  const decision = run.stdout === '' ? null : JSON.parse(run.stdout).hookSpecificOutput?.permissionDecision;
  const blocks = run.status === BLOCKING_EXIT || (run.status === 0 && decision === 'deny');
  const stderrHead = run.stderr.split('\n').filter(Boolean).slice(0, 2).join(' | ');
  assert.ok(blocks, `fail-open: exit ${run.status}, stdout ${JSON.stringify(run.stdout)}, stderr: ${stderrHead}`);
}

test('REPRO: a lib that throws while it loads blocks the Agent call (exit 2 or a deny), not exit 1', () => {
  assertBlocks(sendDevCall(hooksWithBrokenLib((lib) => appendFileSync(lib, "\nthrow new Error('agent-brief broke at load');\n"))));
});

test('REPRO: a lib with a syntax error blocks the Agent call (exit 2 or a deny), not exit 1', () => {
  assertBlocks(sendDevCall(hooksWithBrokenLib((lib) => writeFileSync(lib, 'export function quotedValue( {\n'))));
});

test('REPRO: a missing lib blocks the Agent call (exit 2 or a deny), not exit 1', () => {
  assertBlocks(sendDevCall(hooksWithBrokenLib((lib) => rmSync(lib))));
});
