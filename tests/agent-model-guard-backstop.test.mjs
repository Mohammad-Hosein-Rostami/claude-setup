// Tests for the workflow backstop and the copy-branch brief gate wired into home/hooks/agent-model-guard.mjs (round 4, lane W1):
// a plain Agent call from the lead is denied once with the name of the wf-* skill; the identical call sent again runs; a call from inside an
// agent (agent_id), with workflows disabled, a fork, or with the skill not installed passes. Each test has a private HOME.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, makeRepo } from './git-tidy-helpers.mjs';
import { hookEnv } from './hook-env.mjs';
import { skillFor, workflowBackstop } from '../home/hooks/lib/workflow-backstop.mjs';

const GUARD = fileURLToPath(new URL('../home/hooks/agent-model-guard.mjs', import.meta.url));
const SKILLS = ['wf-build', 'wf-review', 'wf-bugfix', 'wf-research', 'wf-step', 'quick'];
let counter = 0;

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

test('skillFor maps each agent type to its skill; a research question goes to wf-research; a fork has none', () => {
  const cases = [
    ['implementer', 'wf-build'], ['ui-implementer', 'wf-build'], ['test-writer', 'wf-build'], ['reviewer', 'wf-review'], ['security-auditor', 'wf-review'],
    ['deep-debugger', 'wf-bugfix'], ['scout', 'quick'], ['Explore', 'quick'], ['architect', 'wf-step'], ['visual-qa', 'wf-step'], ['runner', 'wf-step'],
    ['some-plugin:agent', 'wf-step'],
  ];
  for (const [type, skill] of cases) assert.equal(skillFor(type, 'x'), skill, type);
  assert.equal(skillFor('general-purpose', 'research the best queue for this'), 'wf-research');
  assert.equal(skillFor(undefined, 'compare two libraries'), 'wf-research');
  assert.equal(skillFor('general-purpose', 'rename the file'), 'wf-step');
  assert.equal(skillFor('fork', 'anything'), null);
});

test('a plain lead Agent call is denied once naming the skill; the identical call sent again runs', () => {
  const s = session();
  const first = s.send(call('reviewer'));
  assert.ok(denied(first));
  assert.match(first.permissionDecisionReason, /\/wf-review/);
  assert.match(first.permissionDecisionReason, /send the same call again/);
  assert.equal(denied(s.send(call('reviewer'))), false, 'the resend runs');
  assert.ok(denied(s.send(call('reviewer', 'another job'))), 'a different call is advised again');
  const rows = s.log().filter((row) => row.class === 'plain agent call');
  assert.deepEqual(rows.map((row) => row.outcome), ['advice', 'advice-retry', 'advice']);
  assert.ok(rows.every((row) => !JSON.stringify(row).includes('another job')), 'the log holds no prompt text');
});

test('scout maps to /quick, a research question to /wf-research, anything else to /wf-step', () => {
  const s = session();
  assert.match(s.send(call('scout')).permissionDecisionReason, /`\/quick`/);
  assert.match(s.send(call('general-purpose', 'research queue options')).permissionDecisionReason, /`\/wf-research`/);
  assert.match(s.send(call('architect', 'design it')).permissionDecisionReason, /`\/wf-step`/);
});

test('agent_id (a call from inside an agent or workflow) passes', () => {
  const s = session();
  assert.equal(denied(s.send(call('reviewer'), { agent_id: 'agent-1', agent_type: 'implementer' })), false);
});

test('workflows disabled by the environment or by settings.json pass; so does a missing skill and a fork', () => {
  assert.equal(denied(session({ envExtra: { CLAUDE_CODE_DISABLE_WORKFLOWS: '1' } }).send(call('reviewer'))), false);
  assert.ok(denied(session({ envExtra: { CLAUDE_CODE_DISABLE_WORKFLOWS: '0' } }).send(call('reviewer'))), '0 means not disabled');
  assert.equal(denied(session({ settings: { disableWorkflows: true } }).send(call('reviewer'))), false);
  assert.ok(denied(session({ settings: { disableWorkflows: false } }).send(call('reviewer'))));
  assert.equal(denied(session({ skills: [] }).send(call('reviewer'))), false, 'skill not installed: no advice that leads nowhere');
  assert.equal(denied(session().send(call('fork'))), false);
});

test('workflowBackstop never throws on odd input', () => {
  for (const bad of [undefined, null, 5, {}, { tool_input: 7 }, { tool_input: { subagent_type: {} } }]) {
    assert.equal(typeof workflowBackstop(bad, {}).deny, 'boolean');
  }
});

// The copy-branch gate through the hook: a real temp repo holds the lane branch; the agent's cwd is that repo.
function repoSession(options) {
  const s = session(options);
  const repo = makeRepo();
  git(repo, 'branch', 'lane/x');
  return { ...s, send: (toolInput) => s.send(toolInput, { cwd: repo }) };
}

test('a writer brief that creates a copy of an existing lane branch is denied once with the same-branch steps; the resend runs', () => {
  const s = repoSession({ envExtra: { CLAUDE_CODE_DISABLE_WORKFLOWS: '1' } });
  const brief = call('implementer', 'Fix the findings.\ngit checkout -b lane/x-2\nthen test');
  const first = s.send(brief);
  assert.ok(denied(first));
  assert.match(first.permissionDecisionReason, /continues the same branch/);
  assert.equal(denied(s.send(brief)), false, 'the identical call runs');
  assert.equal(denied(s.send(call('implementer', 'git checkout -b lane/x'))), false, 'the lane itself');
  assert.equal(denied(s.send(call('reviewer', 'git checkout -b lane/x-2'))), false, 'a read-only agent');
  assert.ok(s.log().some((row) => row.class === 'copy branch brief' && row.outcome === 'advice'));
});

test('with workflows on, the backstop and the copy-branch gate each deny once, in that order, then the call runs', () => {
  const s = repoSession();
  const brief = call('implementer', 'git checkout -b lane/x-fix');
  assert.match(s.send(brief).permissionDecisionReason, /\/wf-build/);
  assert.match(s.send(brief).permissionDecisionReason, /continues the same branch/);
  assert.equal(denied(s.send(brief)), false);
});
