// Tests for home/hooks/permission-timed-allow.mjs (PermissionRequest) and lib/answered-commands.mjs: a built-in permission prompt
// in bypassPermissions mode gets the timed dialog with a 30 s default; no answer -> allow, Deny -> deny, no GUI -> no output.
// The dialog is injected (permissionReply's third argument) or, for the guard hand-over test, a fake dialog tool sits first on
// PATH. No test opens a real dialog.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { rememberAnswered, takeAnswered } from '../home/hooks/lib/answered-commands.mjs';
import { dialogExecutable, MAX_ASK_TIMEOUT_S, permissionTimeoutSeconds } from '../home/hooks/lib/timed-ask.mjs';
import { PERMISSION_TOOLS, permissionReply } from '../home/hooks/permission-timed-allow.mjs';
import { hookEnv, tempLogPath } from './hook-env.mjs';
import { warmExec } from './warm-exec.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/permission-timed-allow.mjs', import.meta.url));
const GUARD = fileURLToPath(new URL('../home/hooks/pre-bash-guard.mjs', import.meta.url));
const BASE_SETTINGS = fileURLToPath(new URL('../settings/base.json', import.meta.url));
const PROJECT = resolve('/work/proj');
const RM_COMMAND = 'rm -rf "$DIR"/build';

/** A private HOME and decision log, so the answered-commands store and the log never touch the real ~/.claude. */
const privateEnv = (extra = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'perm-home-'));
  return { HOME: home, USERPROFILE: home, CLAUDE_GUARD_LOG: tempLogPath(), ...extra };
};

const promptInput = (extra = {}) => ({
  session_id: 'session-perm-1',
  cwd: PROJECT,
  permission_mode: 'bypassPermissions',
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: RM_COMMAND, description: 'Remove the build folder' },
  ...extra,
});

/** A dialog stand-in that records each request and env and answers with `decision` / `outcome`. */
function fakeAnswer(decision, outcome) {
  const calls = [];
  const answer = (request, env) => {
    calls.push({ request, env });
    return { decision, outcome, reason: `fake ${outcome}` };
  };
  return { answer, calls };
}

const decisionOf = (stdout) => {
  const out = JSON.parse(stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PermissionRequest');
  return out.decision;
};

test('permissionTimeoutSeconds: 30 by default, CLAUDE_PERMISSION_TIMEOUT_S when positive, capped at 190, bad values fall back', () => {
  assert.equal(permissionTimeoutSeconds({}), 30);
  assert.equal(permissionTimeoutSeconds({ CLAUDE_PERMISSION_TIMEOUT_S: '12' }), 12);
  assert.equal(permissionTimeoutSeconds({ CLAUDE_PERMISSION_TIMEOUT_S: '9999' }), MAX_ASK_TIMEOUT_S);
  assert.equal(permissionTimeoutSeconds({ CLAUDE_ASK_TIMEOUT_S: '180' }), 30); // the guard's timeout does not change this one
  for (const bad of ['0', '-5', 'abc', '', 'NaN']) assert.equal(permissionTimeoutSeconds({ CLAUDE_PERMISSION_TIMEOUT_S: bad }), 30, bad);
});

test('no answer in time: the prompt is allowed, the dialog waited the permission timeout and named the tool and command', () => {
  const { answer, calls } = fakeAnswer('allow', 'timeout');
  const decision = decisionOf(permissionReply(promptInput(), privateEnv(), answer));
  assert.deepEqual(decision, { behavior: 'allow' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].env.CLAUDE_ASK_TIMEOUT_S, '30');
  assert.equal(calls[0].request.tool, 'Bash');
  assert.equal(calls[0].request.command, RM_COMMAND);
  assert.match(calls[0].request.reason, /permission prompt/i);
  const custom = fakeAnswer('allow', 'timeout');
  permissionReply(promptInput(), privateEnv({ CLAUDE_PERMISSION_TIMEOUT_S: '45' }), custom.answer);
  assert.equal(custom.calls[0].env.CLAUDE_ASK_TIMEOUT_S, '45');
});

test('a click on Allow allows; a click on Deny denies with a message for Claude', () => {
  assert.deepEqual(decisionOf(permissionReply(promptInput(), privateEnv(), fakeAnswer('allow', 'allow').answer)), { behavior: 'allow' });
  const denied = decisionOf(permissionReply(promptInput(), privateEnv(), fakeAnswer('deny', 'deny').answer));
  assert.equal(denied.behavior, 'deny');
  assert.equal(denied.message, 'fake deny'); // the dialog's reason reaches Claude
});

test('no GUI or a failed dialog: no output, so Claude Code shows its own prompt', () => {
  assert.equal(permissionReply(promptInput(), privateEnv(), fakeAnswer('ask', 'no-gui').answer), '');
  assert.equal(permissionReply(promptInput(), privateEnv(), fakeAnswer('ask', 'dialog-failed').answer), '');
  assert.equal(permissionReply(promptInput(), hookEnv()), ''); // the real dialog code under an ssh marker
});

test('only tool permission prompts in bypassPermissions mode get the dialog', () => {
  for (const tool of ['AskUserQuestion', 'ExitPlanMode', 'mcp__github__create_issue', 'Agent', '', undefined]) {
    const { answer, calls } = fakeAnswer('allow', 'timeout');
    assert.equal(permissionReply(promptInput({ tool_name: tool }), privateEnv(), answer), '', String(tool));
    assert.equal(calls.length, 0, String(tool));
  }
  for (const mode of ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', undefined]) {
    const { answer, calls } = fakeAnswer('allow', 'timeout');
    assert.equal(permissionReply(promptInput({ permission_mode: mode }), privateEnv(), answer), '', String(mode));
    assert.equal(calls.length, 0, String(mode));
  }
  const edit = fakeAnswer('allow', 'timeout');
  permissionReply(promptInput({ tool_name: 'Write', tool_input: { file_path: '/work/proj/.git/config', content: 'x' } }), privateEnv(), edit.answer);
  assert.equal(edit.calls[0].request.command, '/work/proj/.git/config');
});

test('settings/base.json registers the hook for exactly PERMISSION_TOOLS, with a timeout above the longest dialog', () => {
  const entries = JSON.parse(readFileSync(BASE_SETTINGS, 'utf8')).hooks.PermissionRequest;
  const ours = entries.filter((entry) => entry.hooks.some((hook) => hook.command.includes('permission-timed-allow.mjs')));
  assert.equal(ours.length, 1);
  assert.deepEqual(ours[0].matcher.split('|'), PERMISSION_TOOLS);
  assert.ok(ours[0].hooks[0].timeout > MAX_ASK_TIMEOUT_S);
});

test('a Bash command the guard already asked about is allowed once without a second dialog', () => {
  const env = privateEnv();
  rememberAnswered('session-perm-1', RM_COMMAND, env);
  const first = fakeAnswer('deny', 'deny');
  assert.deepEqual(decisionOf(permissionReply(promptInput(), env, first.answer)), { behavior: 'allow' });
  assert.equal(first.calls.length, 0);
  const second = fakeAnswer('deny', 'deny');
  assert.equal(decisionOf(permissionReply(promptInput(), env, second.answer)).behavior, 'deny'); // used up: asks again
  assert.equal(second.calls.length, 1);
  rememberAnswered('session-perm-1', RM_COMMAND, env);
  const other = fakeAnswer('deny', 'deny');
  permissionReply(promptInput({ session_id: 'session-perm-2' }), env, other.answer); // another session never matches
  permissionReply(promptInput({ tool_input: { command: `${RM_COMMAND} x` } }), env, other.answer); // nor another command
  assert.equal(other.calls.length, 2);
});

test('answered-commands: an answer older than the time limit and a bad session id are never taken', () => {
  const env = privateEnv();
  rememberAnswered('session-old', 'git push', env, () => 0);
  assert.equal(takeAnswered('session-old', 'git push', env, () => 10 * 60 * 1000), false);
  assert.equal(rememberAnswered('../escape', 'git push', env), undefined);
  assert.equal(takeAnswered('../escape', 'git push', env), false);
  assert.equal(takeAnswered(undefined, 'git push', env), false);
});

/** A fake dialog tool on PATH that always answers Allow (the guard spawns it as a separate process). */
function allowingDialogEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'perm-dialog-'));
  const script = join(dir, 'fake.cjs');
  const out = { darwin: 'button returned:Allow, gave up:false', win32: '6', linux: '' }[process.platform];
  writeFileSync(script, `process.stdout.write(${JSON.stringify(out)});`);
  const bin = join(dir, dialogExecutable(process.platform) + (process.platform === 'win32' ? '.cmd' : ''));
  writeFileSync(bin, process.platform === 'win32' ? `@node "${script}" %*\r\n` : `#!/bin/sh\n[ -n "$FAKE_WARM" ] && exit 0\nexec node "${script}" "$@"\n`);
  chmodSync(bin, 0o755);
  if (process.platform !== 'win32') warmExec(bin);
  const env = { ...process.env, ...privateEnv(), PATH: `${dir}${delimiter}${process.env.PATH}`, DISPLAY: ':0' };
  for (const name of ['NODE_TEST_CONTEXT', 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'CI']) delete env[name];
  return env;
}

test('hand-over: after the guard dialog allowed a command, the built-in prompt for it opens no second dialog', () => {
  const env = allowingDialogEnv();
  const input = promptInput({ tool_input: { command: 'git push origin main' } });
  const guard = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ ...input, hook_event_name: 'PreToolUse' }), encoding: 'utf8', env });
  assert.equal(guard.status, 0);
  assert.equal(guard.stdout, ''); // allowed in the dialog: no decision, the normal permission flow follows
  const { answer, calls } = fakeAnswer('deny', 'deny');
  assert.deepEqual(decisionOf(permissionReply(input, env, answer)), { behavior: 'allow' });
  assert.equal(calls.length, 0);
});

test('hook contract: no GUI prints nothing and exits 0; bad JSON is silent', () => {
  const run = (text) => spawnSync(process.execPath, [HOOK], { input: text, encoding: 'utf8', env: hookEnv(privateEnv()) });
  for (const text of [JSON.stringify(promptInput()), 'not json', '']) {
    const result = run(text);
    assert.equal(result.status, 0, text);
    assert.equal(result.stdout, '', text);
  }
});
