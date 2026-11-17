// Tests for the copy-branch brief gate wired into home/hooks/agent-model-guard.mjs (round 4, lane W1) and the rule that no hook sends a plain
// Agent call to a workflow any more (round 6: inline, one agent or a workflow is the lead's choice by the job). The private HOME holds the wf-*
// skills on purpose: the removed backstop advised exactly when they were installed. Each test has a private HOME.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, makeRepo } from './git-tidy-helpers.mjs';
import { hookEnv } from './hook-env.mjs';

const GUARD = fileURLToPath(new URL('../home/hooks/agent-model-guard.mjs', import.meta.url));
const SKILLS = ['wf-build', 'wf-review', 'wf-bugfix', 'wf-research', 'wf-step', 'quick'];
let counter = 0;
const GIT_TIMEOUT_FOR_TESTS_MS = 60_000; // the suite runs beside other work; the hook's 1 s default would silently skip the advice

/** A private HOME holding the named skills; send(toolInput, extra) runs the hook once and returns the parsed hookSpecificOutput or null. */
function session({ skills = SKILLS, envExtra = {}, settings } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'backstop-home-'));
  const project = mkdtempSync(join(tmpdir(), 'backstop-project-'));
  for (const name of skills) {
    mkdirSync(join(home, '.claude', 'skills', name), { recursive: true });
    writeFileSync(join(home, '.claude', 'skills', name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
  }
  if (settings !== undefined) writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(settings));
  const env = hookEnv({ HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: project, ...envExtra });
  const sessionId = `backstop-${process.pid}-${counter++}`;
  const log = () => readFileSync(env.CLAUDE_GUARD_LOG, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const send = (toolInput, extra = {}) => {
    const input = { hook_event_name: 'PreToolUse', session_id: sessionId, cwd: project, tool_name: 'Agent', tool_input: toolInput, ...extra };
    const { status, stdout, stderr } = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(input), encoding: 'utf8', env });
    assert.equal(status, 0, stderr);
    return stdout === '' ? null : JSON.parse(stdout).hookSpecificOutput;
  };
  return { home, project, send, log };
}
const denied = (out) => out?.permissionDecision === 'deny';
// isolation: "worktree" keeps the writer isolation gate (another gate of the same hook) out of these tests
const call = (type, prompt = 'do the job', extra = {}) => ({ description: 'job', prompt, subagent_type: type, model: 'sonnet', isolation: 'worktree', ...extra });

test('a plain lead Agent call is never sent back for a workflow: every agent type runs at once (routing is by the job, not by a hook)', () => {
  const s = session();
  const types = ['implementer', 'ui-implementer', 'test-writer', 'reviewer', 'security-auditor', 'deep-debugger', 'scout', 'Explore', 'architect', 'runner', 'general-purpose'];
  const brief = 'do the job\nMATRIX: none: not a screen, a hook test'; // the MATRIX line keeps the UI gate quiet
  for (const type of types) assert.equal(denied(s.send(call(type, brief))), false, type);
  assert.equal(denied(s.send(call('general-purpose', 'research the best queue for this'))), false, 'a research question too');
});

// The copy-branch gate through the hook: a real temp repo holds the lane branch; the agent's cwd is that repo.
function repoSession({ envExtra, ...options } = {}) {
  const s = session({ ...options, envExtra: { COPY_BRANCH_GIT_TIMEOUT_MS: String(GIT_TIMEOUT_FOR_TESTS_MS), COPY_BRANCH_DEADLINE_MS: String(GIT_TIMEOUT_FOR_TESTS_MS), ...envExtra } });
  const repo = makeRepo();
  git(repo, 'branch', 'lane/x');
  return { ...s, send: (toolInput) => s.send(toolInput, { cwd: repo }) };
}

test('a writer brief that creates a copy of an existing lane branch is denied once with the same-branch steps; the resend runs', () => {
  const s = repoSession();
  const brief = call('implementer', 'Fix the findings.\ngit checkout -b lane/x-2\nthen test');
  const first = s.send(brief);
  assert.ok(denied(first));
  assert.match(first.permissionDecisionReason, /continues the same branch/);
  assert.equal(denied(s.send(brief)), false, 'the identical call runs');
  assert.equal(denied(s.send(call('implementer', 'git checkout -b lane/x'))), false, 'the lane itself');
  assert.equal(denied(s.send(call('reviewer', 'git checkout -b lane/x-2'))), false, 'a read-only agent');
  assert.ok(s.log().some((row) => row.class === 'copy branch brief' && row.outcome === 'advice'));
});
