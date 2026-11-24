// Tests for home/hooks/permission-timed-allow.mjs (PermissionRequest) and lib/answered-commands.mjs: every Claude Code permission
// prompt (any tool, any mode, interactive or -p; AskUserQuestion is in permission-question.test.mjs) gets the timed dialog with a 2 min default; no answer -> allow,
// Deny -> deny, no GUI -> no output. The dialog is injected (permissionReply's third argument) or, for the guard hand-over test, a
// fake dialog tool sits first on PATH. No test opens a real dialog.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { answeredCommandsDir, rememberAnswered, takeAnswered } from '../home/hooks/lib/answered-commands.mjs';
import { dialogExecutable, MAX_ASK_TIMEOUT_S, permissionTimeoutSeconds } from '../home/hooks/lib/timed-ask.mjs';
import { permissionReply } from '../home/hooks/permission-timed-allow.mjs';
import { hookEnv, tempLogPath } from './hook-env.mjs';
import { warmExec } from './warm-exec.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { cleanEnv } from './clean-env.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/permission-timed-allow.mjs', import.meta.url));
const GUARD = fileURLToPath(new URL('../home/hooks/pre-bash-guard.mjs', import.meta.url));
const BASE_SETTINGS = fileURLToPath(new URL('../settings/base.json', import.meta.url));
const PROJECT = resolve('/work/proj');
const RM_COMMAND = 'rm -rf "$DIR"/build';
const SESSION = 'session-perm-1';
const ANSWER_WINDOW_MS = 10_000; // the brief: a guard answer is handed over for at most 10 s

/** A private HOME and decision log, so the answered-commands store and the log never touch the real ~/.claude. */
const privateEnv = (extra = {}) => {
  const home = makeTempDir('perm-home-');
  return { HOME: home, USERPROFILE: home, CLAUDE_GUARD_LOG: tempLogPath(), ...extra };
};

const promptInput = (extra = {}) => ({
  session_id: SESSION,
  cwd: PROJECT,
  permission_mode: 'bypassPermissions',
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: RM_COMMAND, description: 'Remove the build folder' },
  ...extra,
});

/** The hand-over key of a prompt: session, agent, directory and command. */
const callOf = (input = promptInput()) => ({ session: input.session_id, agentId: input.agent_id, cwd: input.cwd, command: input.tool_input.command });

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

test('permissionTimeoutSeconds: 120 by default, CLAUDE_PERMISSION_TIMEOUT_S when positive, capped at 190, bad values fall back', () => {
  assert.equal(permissionTimeoutSeconds({}), 120);
  assert.equal(permissionTimeoutSeconds({ CLAUDE_PERMISSION_TIMEOUT_S: '12' }), 12);
  assert.equal(permissionTimeoutSeconds({ CLAUDE_PERMISSION_TIMEOUT_S: '9999' }), MAX_ASK_TIMEOUT_S);
  assert.equal(permissionTimeoutSeconds({ CLAUDE_ASK_TIMEOUT_S: '180' }), 120); // the guard's timeout does not change this one
  for (const bad of ['0', '-5', 'abc', '', 'NaN']) assert.equal(permissionTimeoutSeconds({ CLAUDE_PERMISSION_TIMEOUT_S: bad }), 120, bad);
});

test('no answer in time: allowed; the timeout travels as an argument (2 min, or CLAUDE_PERMISSION_TIMEOUT_S), the env is passed unchanged', () => {
  const { answer, calls } = fakeAnswer('allow', 'timeout');
  const env = privateEnv();
  assert.deepEqual(decisionOf(permissionReply(promptInput(), env, answer)), { behavior: 'allow' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.timeoutS, 120);
  assert.equal(calls[0].env, env, 'no env copy with an overridden CLAUDE_ASK_TIMEOUT_S');
  assert.equal(calls[0].request.tool, 'Bash');
  assert.equal(calls[0].request.command, RM_COMMAND);
  assert.equal(calls[0].request.targetLabel, 'Command');
  const custom = fakeAnswer('allow', 'timeout');
  permissionReply(promptInput(), privateEnv({ CLAUDE_PERMISSION_TIMEOUT_S: '45' }), custom.answer);
  assert.equal(custom.calls[0].request.timeoutS, 45);
});

test('a click on Allow allows; a click on Deny denies with a message for Claude', () => {
  assert.deepEqual(decisionOf(permissionReply(promptInput(), privateEnv(), fakeAnswer('allow', 'allow').answer)), { behavior: 'allow' });
  const denied = decisionOf(permissionReply(promptInput(), privateEnv(), fakeAnswer('deny', 'deny').answer));
  assert.equal(denied.behavior, 'deny');
  assert.equal(denied.message, 'fake deny'); // the dialog's reason reaches Claude
});

test('no GUI or a failed dialog: no output, so Claude Code shows its own prompt (or denies a call that cannot prompt)', () => {
  assert.equal(permissionReply(promptInput(), privateEnv(), fakeAnswer('ask', 'no-gui').answer), '');
  assert.equal(permissionReply(promptInput(), privateEnv(), fakeAnswer('ask', 'dialog-failed').answer), '');
  assert.equal(permissionReply(promptInput(), hookEnv()), ''); // the real dialog code under an ssh marker
});

test('every tool in every mode gets the dialog: MCP tools, Agent, protected files, non-bypass modes', () => {
  for (const tool of ['mcp__github__create_issue', 'Agent', 'Task', 'Write', 'Read', 'WebFetch', 'SomeFutureTool']) {
    const { answer, calls } = fakeAnswer('allow', 'timeout');
    assert.deepEqual(decisionOf(permissionReply(promptInput({ tool_name: tool, tool_input: { x: 1 } }), privateEnv(), answer)), { behavior: 'allow' }, tool);
    assert.equal(calls.length, 1, tool);
  }
  for (const mode of ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions', undefined]) {
    const { answer, calls } = fakeAnswer('allow', 'timeout');
    assert.deepEqual(decisionOf(permissionReply(promptInput({ permission_mode: mode }), privateEnv(), answer)), { behavior: 'allow' }, String(mode));
    assert.match(calls[0].request.reason, new RegExp(String(mode ?? 'unknown')), 'the dialog names the mode');
  }
  const protectedWrite = fakeAnswer('allow', 'timeout');
  permissionReply(promptInput({ tool_name: 'Write', tool_input: { file_path: '/work/proj/.git/config', content: 'x' } }), privateEnv(), protectedWrite.answer);
  assert.equal(protectedWrite.calls[0].request.command, '/work/proj/.git/config');
});

test('a -p run (CLAUDE_CODE_ENTRYPOINT=sdk-cli) and a background agent get the dialog too', () => {
  const headless = fakeAnswer('allow', 'timeout');
  assert.deepEqual(decisionOf(permissionReply(promptInput(), privateEnv({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }), headless.answer)), { behavior: 'allow' });
  assert.equal(headless.calls.length, 1);
  const agent = fakeAnswer('allow', 'timeout');
  permissionReply(promptInput({ agent_id: 'agent-bg-1' }), privateEnv(), agent.answer);
  assert.equal(agent.calls[0].request.agentId, 'agent-bg-1');
});

test('ExitPlanMode: an allow carries updatedInput (the docs require it), the dialog shows the plan', () => {
  const planInput = { plan: '## Refactor auth\n1. Extract the token check', planFilePath: '/tmp/plans/auth.md' };
  const { answer, calls } = fakeAnswer('allow', 'timeout');
  const decision = decisionOf(permissionReply(promptInput({ tool_name: 'ExitPlanMode', permission_mode: 'plan', tool_input: planInput }), privateEnv(), answer));
  assert.deepEqual(decision, { behavior: 'allow', updatedInput: planInput });
  assert.equal(calls[0].request.targetLabel, 'Plan');
  assert.match(calls[0].request.reason, /plan/i);
});

test('a prompt with no tool name is never answered, no dialog', () => {
  for (const tool of ['', undefined]) {
    const { answer, calls } = fakeAnswer('allow', 'timeout');
    assert.equal(permissionReply(promptInput({ tool_name: tool, tool_input: { questions: [] } }), privateEnv(), answer), '', String(tool));
    assert.equal(calls.length, 0, String(tool));
  }
});

test('S3: each tool gets its own label and reason; no generic "Why"', () => {
  const cases = [
    ['Bash', { command: 'ls' }, 'Command', 'ls', /run this command/],
    ['Write', { file_path: '/p/.zshrc', content: 'x' }, 'File', '/p/.zshrc', /write this file/],
    ['NotebookEdit', { notebook_path: '/p/n.ipynb' }, 'File', '/p/n.ipynb', /notebook/],
    ['Grep', { pattern: 'x', path: '/etc' }, 'Path', '/etc', /search/],
    ['WebFetch', { url: 'https://example.org', prompt: 'p' }, 'URL', 'https://example.org', /fetch this URL/],
    ['WebSearch', { query: 'node 22' }, 'Query', 'node 22', /search the web/],
    ['mcp__github__create_issue', { title: 't', body: 'b' }, 'Input', '{"title":"t","body":"b"}', /MCP tool mcp__github__create_issue/],
  ];
  for (const [tool, toolInput, label, target, reason] of cases) {
    const { answer, calls } = fakeAnswer('allow', 'timeout');
    permissionReply(promptInput({ tool_name: tool, tool_input: toolInput, permission_mode: 'default' }), privateEnv(), answer);
    assert.equal(calls[0].request.targetLabel, label, tool);
    assert.equal(calls[0].request.command, target, tool);
    assert.match(calls[0].request.reason, reason, tool);
    assert.match(calls[0].request.reason, /gives hooks no reason/, tool);
  }
});

test('S2: a Bash prompt for a command the guard asks about shows the guard\'s real reason, not a generic one', () => {
  const { answer, calls } = fakeAnswer('allow', 'timeout');
  permissionReply(promptInput({ tool_input: { command: 'git push origin main' } }), privateEnv(), answer);
  assert.match(calls[0].request.reason, /^Bash guard: .*push/);
  const quiet = fakeAnswer('allow', 'timeout');
  permissionReply(promptInput({ tool_input: { command: 'ls -la' } }), privateEnv(), quiet.answer);
  assert.doesNotMatch(quiet.calls[0].request.reason, /Bash guard/);
});

const MAX_QUESTIONS = 4; // AskUserQuestion takes 1 to 4 questions, each with its own popup of at most MAX_ASK_TIMEOUT_S

test('settings/base.json registers the hook for every tool, with a timeout above four popups in a row', () => {
  const entries = JSON.parse(readFileSync(BASE_SETTINGS, 'utf8')).hooks.PermissionRequest;
  const ours = entries.filter((entry) => entry.hooks.some((hook) => hook.command.includes('permission-timed-allow.mjs')));
  assert.equal(ours.length, 1);
  assert.equal(ours[0].matcher, '*');
  assert.ok(ours[0].hooks[0].timeout > MAX_QUESTIONS * MAX_ASK_TIMEOUT_S, 'one popup per question: the hook must outlive all of them');
});

test('settings/base.json registers the PostToolUse hook that marks a terminal answer, for AskUserQuestion only', () => {
  const entries = JSON.parse(readFileSync(BASE_SETTINGS, 'utf8')).hooks.PostToolUse;
  const ours = entries.filter((entry) => entry.hooks.some((hook) => hook.command.includes('question-answered.mjs')));
  assert.equal(ours.length, 1);
  assert.equal(ours[0].matcher, 'AskUserQuestion');
});

test('a Bash command the guard already asked about is allowed once without a second dialog', () => {
  const env = privateEnv();
  const input = promptInput({ tool_input: { command: 'git push origin main' } }); // the guard asks, but not as DESTRUCTIVE
  rememberAnswered(callOf(input), env);
  const first = fakeAnswer('deny', 'deny');
  assert.deepEqual(decisionOf(permissionReply(input, env, first.answer)), { behavior: 'allow' });
  assert.equal(first.calls.length, 0);
  const second = fakeAnswer('deny', 'deny');
  assert.equal(decisionOf(permissionReply(input, env, second.answer)).behavior, 'deny'); // used up: asks again
  assert.equal(second.calls.length, 1);
});

test('re-audit 4: a command the guard classes as DESTRUCTIVE always gets the dialog, even with a (forged) answered record', () => {
  for (const command of ['git push --force origin main', RM_COMMAND]) {
    const env = privateEnv();
    const input = promptInput({ tool_input: { command } });
    rememberAnswered(callOf(input), env);
    const { answer, calls } = fakeAnswer('deny', 'deny');
    assert.equal(decisionOf(permissionReply(input, env, answer)).behavior, 'deny', command);
    assert.equal(calls.length, 1, command);
    assert.match(calls[0].request.reason, /^Bash guard: DESTRUCTIVE: /, command);
  }
});

// Built from parts so this file never holds a string that looks like a real credential.
const PASSWORD = ['Hq7', 'Lm2', 'Vx9', 'Rt4'].join('');
const TOKEN = ['Tk5', 'Pz8', 'Wd3', 'Ny6'].join('');

test('re-audit 2: secret-named fields of any tool input (nested, any case) are masked in the dialog and in the guard log', () => {
  const toolInput = {
    host: 'db.internal',
    password: PASSWORD,
    options: { headers: { 'X-Api-Key': TOKEN, Authorization: `Basic ${TOKEN}`, Cookie: `sid=${TOKEN}` }, list: [{ access_token: TOKEN }] },
    apiKey: TOKEN, clientSecret: TOKEN, api_key: TOKEN, credentials: TOKEN, db_pass: PASSWORD,
    max_tokens: 5, keyboard: 'us', passport: 'id', note: `export DB_PASSWORD=${PASSWORD}`,
  };
  const env = privateEnv();
  const { answer, calls } = fakeAnswer('allow', 'timeout');
  permissionReply(promptInput({ tool_name: 'mcp__db__connect', tool_input: toolInput }), env, answer);
  const shown = calls[0].request.command;
  const logged = readFileSync(env.CLAUDE_GUARD_LOG, 'utf8');
  for (const text of [shown, logged]) {
    assert.ok(!text.includes(PASSWORD), text);
    assert.ok(!text.includes(TOKEN), text);
  }
  assert.ok(shown.includes('"host":"db.internal"') && shown.includes('"password":"[masked]"'), shown);
  for (const plain of ['"max_tokens":5', '"keyboard":"us"', '"passport":"id"']) assert.ok(shown.includes(plain), plain);
});

test('re-audit 3: an Artifact prompt (its own dialog failed) names the real action, as the Artifact hook does', () => {
  const cases = [[{ action: 'delete', url: 'https://claude.ai/artifact/abc' }, /^Artifact hook: Artifact delete permanently removes/], [{ file_path: '/p/a.html' }, /^Artifact hook: Artifact publish creates/]];
  for (const [toolInput, reason] of cases) {
    const { answer, calls } = fakeAnswer('allow', 'timeout');
    permissionReply(promptInput({ tool_name: 'Artifact', tool_input: toolInput }), privateEnv(), answer);
    assert.match(calls[0].request.reason, reason);
  }
  const read = fakeAnswer('allow', 'timeout');
  permissionReply(promptInput({ tool_name: 'Artifact', tool_input: { action: 'read', url: 'https://claude.ai/artifact/abc' } }), privateEnv(), read.answer);
  assert.doesNotMatch(read.calls[0].request.reason, /Artifact hook/);
});

test('S4/M1: the hand-over is keyed on session, agent, directory and the exact command', () => {
  const env = privateEnv();
  const others = [
    promptInput({ session_id: 'session-perm-2' }),
    promptInput({ agent_id: 'agent-other' }),
    promptInput({ cwd: resolve('/work/other') }),
    promptInput({ tool_input: { command: `${RM_COMMAND} x` } }),
  ];
  for (const other of others) {
    rememberAnswered(callOf(), env);
    const { answer, calls } = fakeAnswer('deny', 'deny');
    permissionReply(other, env, answer);
    assert.equal(calls.length, 1, JSON.stringify(other));
    assert.equal(takeAnswered(callOf(), env), true, 'the real record is still there');
  }
});

test('S4: an answer is good for at most 10 s, a future or replayed record is never taken, a bad session id stores nothing', () => {
  const env = privateEnv();
  rememberAnswered(callOf(), env, () => 0);
  assert.equal(takeAnswered(callOf(), env, () => ANSWER_WINDOW_MS + 1), false);
  rememberAnswered(callOf(), env, () => 0);
  assert.equal(takeAnswered(callOf(), env, () => ANSWER_WINDOW_MS), true);
  assert.equal(takeAnswered(callOf(), env, () => ANSWER_WINDOW_MS), false, 'used once');
  rememberAnswered(callOf(), env, () => 5000);
  assert.equal(takeAnswered(callOf(), env, () => 0), false, 'dated in the future');
  assert.equal(rememberAnswered({ ...callOf(), session: '../escape' }, env), undefined);
  assert.equal(takeAnswered({ ...callOf(), session: '../escape' }, env), false);
  assert.equal(takeAnswered({ ...callOf(), session: undefined }, env), false);
});

test('S4: a record in the old form (sha256 of the command alone) is not taken', async () => {
  const env = privateEnv();
  rememberAnswered(callOf(), env); // creates the folder
  const { createHash } = await import('node:crypto');
  const oldKey = createHash('sha256').update(RM_COMMAND).digest('hex');
  writeFileSync(join(answeredCommandsDir(env), `${SESSION}.json`), JSON.stringify({ answers: { [oldKey]: Date.now() } }));
  assert.equal(takeAnswered(callOf(), env), false);
});

test('S4: the store is private (0700 folder, 0600 file) and a symlinked record is refused', { skip: process.platform === 'win32' && 'POSIX modes' }, () => {
  const env = privateEnv();
  rememberAnswered(callOf(), env);
  const dir = answeredCommandsDir(env);
  assert.equal(lstatSync(dir).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(dir, `${SESSION}.json`)).mode & 0o777, 0o600);
  const elsewhere = join(makeTempDir('perm-link-'), 'real.json');
  renameSync(join(dir, `${SESSION}.json`), elsewhere);
  symlinkSync(elsewhere, join(dir, `${SESSION}.json`));
  assert.equal(takeAnswered(callOf(), env), false);
});

test('M3: a store that turns read-only during the take: the record is not taken and stays on disk', { skip: process.platform === 'win32' && 'POSIX modes' }, () => {
  const env = privateEnv();
  rememberAnswered(callOf(), env);
  const dir = answeredCommandsDir(env);
  // the clock is read inside the lock: the folder turns read-only only then, so the read works and the removal fails (a failed
  // write alone, such as a full disk, takes the same `return writeSessionFile(...)` path but cannot be staged here)
  const lockedThenReadOnly = () => {
    chmodSync(dir, 0o500);
    return Date.now();
  };
  try {
    assert.equal(takeAnswered(callOf(), env, lockedThenReadOnly), false);
  } finally {
    chmodSync(dir, 0o700);
  }
  assert.ok(readdirSync(dir).includes(`${SESSION}.json`));
});

/** A fake dialog tool on PATH that always answers Allow (the guard spawns it as a separate process). */
function allowingDialogEnv() {
  const dir = makeTempDir('perm-dialog-');
  const script = join(dir, 'fake.cjs');
  const out = { darwin: 'button returned:Allow, gave up:false', win32: '6', linux: '' }[process.platform];
  writeFileSync(script, `process.stdout.write(${JSON.stringify(out)});`);
  const bin = join(dir, dialogExecutable(process.platform) + (process.platform === 'win32' ? '.cmd' : ''));
  writeFileSync(bin, process.platform === 'win32' ? `@node "${script}" %*\r\n` : `#!/bin/sh\n[ -n "$FAKE_WARM" ] && exit 0\nexec node "${script}" "$@"\n`);
  chmodSync(bin, 0o755);
  if (process.platform !== 'win32') warmExec(bin);
  const env = cleanEnv({ ...privateEnv(), PATH: `${dir}${delimiter}${process.env.PATH}`, DISPLAY: ':0' });
  for (const name of ['NODE_TEST_CONTEXT', 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'CI']) delete env[name];
  return env;
}

test('hand-over: after the guard dialog allowed a command, the built-in prompt for it opens no second dialog', () => {
  const env = allowingDialogEnv();
  const input = promptInput({ agent_id: 'agent-hand-1', tool_input: { command: 'git push origin main' } });
  const guard = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ ...input, hook_event_name: 'PreToolUse' }), encoding: 'utf8', env });
  assert.equal(guard.status, 0);
  assert.equal(guard.stdout, ''); // allowed in the dialog: no decision, the normal permission flow follows
  const { answer, calls } = fakeAnswer('deny', 'deny');
  assert.deepEqual(decisionOf(permissionReply(input, env, answer)), { behavior: 'allow' });
  assert.equal(calls.length, 0);
});

test('hook contract: no GUI prints nothing and exits 0; bad JSON is silent', () => {
  const run = (text) => spawnSync(process.execPath, [HOOK], { input: text, encoding: 'utf8', env: hookEnv(privateEnv()) });
  for (const text of [JSON.stringify(promptInput()), JSON.stringify(promptInput({ tool_name: 'mcp__x__y', permission_mode: 'default' })), 'not json', '']) {
    const result = run(text);
    assert.equal(result.status, 0, text);
    assert.equal(result.stdout, '', text);
  }
});
