// Tests for the hook wiring of settings/base.json that the agent gates depend on: the Bash guard runs alone on Bash, the model
// guard also runs on SendMessage (the resume cap), the subagent call counter is async, SessionStart covers a fork, the dialog
// hooks have the 230 s timeout, and the retired stop-hook cap is gone from env. Read-only on the repo.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BASE_SETTINGS = fileURLToPath(new URL('../settings/base.json', import.meta.url));
const settings = JSON.parse(readFileSync(BASE_SETTINGS, 'utf8'));
const DIALOG_TIMEOUT_S = 230; // a timed ask waits up to 190 s plus 5 s grace, so 200 s was too close on a slow start
const SESSION_START_MATCHER = 'startup|resume|clear|compact|fork';

const entriesOf = (event) => settings.hooks[event];
const runs = (hook, script) => hook.command.includes(`/hooks/${script}"`);
const entryRunning = (event, script, matcher) => entriesOf(event)
  .filter((entry) => entry.matcher === matcher)
  .find((entry) => entry.hooks.some((hook) => runs(hook, script)));

test('the first PreToolUse entry (Bash) runs only the Bash guard, with the dialog timeout', () => {
  const [bash] = entriesOf('PreToolUse');
  assert.equal(bash.matcher, 'Bash|PowerShell');
  assert.equal(bash.hooks.length, 1, 'agent-budget acts on no PreToolUse event, so it no longer starts on every Bash call');
  assert.ok(runs(bash.hooks[0], 'pre-bash-guard.mjs'), bash.hooks[0].command);
  assert.equal(bash.hooks[0].timeout, DIALOG_TIMEOUT_S);
});

test('a PreToolUse entry with matcher SendMessage runs agent-model-guard.mjs (the resume cap)', () => {
  const entry = entryRunning('PreToolUse', 'agent-model-guard.mjs', 'SendMessage');
  assert.ok(entry, JSON.stringify(entriesOf('PreToolUse').map(({ matcher }) => matcher)));
  assert.equal(entry.hooks[0].onFailure, 'block', 'a guard that fails to start blocks the send, like the Agent entry');
});

test('env no longer sets CLAUDE_CODE_STOP_HOOK_BLOCK_CAP', () => {
  assert.equal(Object.hasOwn(settings.env, 'CLAUDE_CODE_STOP_HOOK_BLOCK_CAP'), false);
});

test('the PostToolUse entry with no matcher runs agent-budget.mjs async (a call counter never delays a tool call)', () => {
  const entry = entryRunning('PostToolUse', 'agent-budget.mjs', undefined);
  assert.ok(entry, 'a no-matcher PostToolUse entry runs agent-budget.mjs');
  const hook = entry.hooks.find((candidate) => runs(candidate, 'agent-budget.mjs'));
  assert.equal(hook.async, true);
});

test(`a SessionStart entry has the matcher ${SESSION_START_MATCHER}`, () => {
  const matchers = entriesOf('SessionStart').map(({ matcher }) => matcher);
  assert.ok(matchers.includes(SESSION_START_MATCHER), JSON.stringify(matchers));
});

test('the artifact-ask hook has the dialog timeout', () => {
  const entry = entryRunning('PreToolUse', 'artifact-ask.mjs', 'Artifact');
  assert.ok(entry, 'a PreToolUse entry with matcher Artifact runs artifact-ask.mjs');
  assert.equal(entry.hooks[0].timeout, DIALOG_TIMEOUT_S);
});
