// Tests for the timed ask (home/hooks/lib/timed-ask.mjs, lib/guard-log.mjs) and how the guard and Artifact hooks use it.
// The dialog tool is faked: a script named like the platform's dialog executable (osascript / powershell / zenity) sits first
// on PATH, records what it was asked to show and answers allow / deny / timeout / fail. No test ever opens a real dialog.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GUARD_LOG_FILE, guardLogPath, logDecision } from '../home/hooks/lib/guard-log.mjs';
import { answerAsk, askTimeoutSeconds, decisionOutput, dialogExecutable, dialogInvocation, guiAvailable, parseDialogResult } from '../home/hooks/lib/timed-ask.mjs';
import { decide } from '../home/hooks/pre-bash-guard.mjs';
import { tempLogPath } from './hook-env.mjs';

const GUARD = fileURLToPath(new URL('../home/hooks/pre-bash-guard.mjs', import.meta.url));
const ARTIFACT = fileURLToPath(new URL('../home/hooks/artifact-ask.mjs', import.meta.url));
const PROJECT = resolve('/work/proj');
const ctx = { cwd: PROJECT, project: PROJECT };
// Built from parts so this file never holds a string that looks like a real credential.
const SECRET = ['sk', 'ant', 'api03', 'Zx9Qw', '3Er5T', 'y7Ui1'].join('-');
const FAKE_SCRIPT = `
const { writeFileSync } = require('node:fs');
const result = process.env.FAKE_DIALOG_RESULT;
writeFileSync(process.env.FAKE_DIALOG_OUT, JSON.stringify({ args: process.argv.slice(2), text: process.env.CLAUDE_ASK_DIALOG_TEXT }));
const out = {
  darwin: { allow: 'button returned:Allow, gave up:false', deny: 'button returned:Deny, gave up:false', timeout: 'button returned:, gave up:true' },
  win32: { allow: '6', deny: '7', timeout: '-1' },
  linux: { allow: '', deny: '', timeout: '' },
}[process.platform];
if (result === 'fail') { process.stderr.write('dialog tool exploded'); process.exit(3); }
process.stdout.write(out[result]);
process.exit(process.platform === 'linux' ? { allow: 0, deny: 1, timeout: 5 }[result] : 0);
`;

/** A directory holding a fake dialog tool, plus the env that makes the hooks use it. */
function fakeDialog(result, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-dialog-'));
  const script = join(dir, 'fake.cjs');
  writeFileSync(script, FAKE_SCRIPT);
  const bin = join(dir, dialogExecutable(process.platform) + (process.platform === 'win32' ? '.cmd' : ''));
  writeFileSync(bin, process.platform === 'win32' ? `@node "${script}" %*\r\n` : `#!/bin/sh\nexec node "${script}" "$@"\n`);
  chmodSync(bin, 0o755);
  const out = join(dir, 'asked.json');
  const env = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, DISPLAY: ':0', FAKE_DIALOG_RESULT: result, FAKE_DIALOG_OUT: out, CLAUDE_GUARD_LOG: tempLogPath(), ...extra };
  for (const name of ['NODE_TEST_CONTEXT', 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'CI']) delete env[name];
  return {
    env,
    shown: () => JSON.parse(readFileSync(out, 'utf8')),
    log: () => readFileSync(env.CLAUDE_GUARD_LOG, 'utf8').trim().split('\n').map((line) => JSON.parse(line)),
  };
}

const shownText = (dialog) => {
  const { args, text } = dialog.shown();
  return [...args, text ?? ''].join('\n');
};

const request = { hook: 'pre-bash-guard', tool: 'Bash', reason: 'git push goes to a remote', command: 'git push origin main', cwd: PROJECT, sessionId: 'session-12345678', agentId: 'agent-87654321' };

test('askTimeoutSeconds: 180 by default, CLAUDE_ASK_TIMEOUT_S when it is a positive number', () => {
  assert.equal(askTimeoutSeconds({}), 180);
  assert.equal(askTimeoutSeconds({ CLAUDE_ASK_TIMEOUT_S: '7' }), 7);
  for (const bad of ['0', '-3', 'abc', '', 'NaN']) assert.equal(askTimeoutSeconds({ CLAUDE_ASK_TIMEOUT_S: bad }), 180, bad);
});

test('guiAvailable: no GUI over ssh, in CI, in a node test run, or on Linux without a display', () => {
  assert.equal(guiAvailable({}, 'darwin'), true);
  assert.equal(guiAvailable({}, 'win32'), true);
  assert.equal(guiAvailable({ DISPLAY: ':0' }, 'linux'), true);
  assert.equal(guiAvailable({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux'), true);
  assert.equal(guiAvailable({}, 'linux'), false);
  assert.equal(guiAvailable({}, 'freebsd'), false);
  for (const name of ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'CI', 'NODE_TEST_CONTEXT']) assert.equal(guiAvailable({ [name]: '1', DISPLAY: ':0' }, 'darwin'), false, name);
});

test('dialogInvocation: Allow is the default button and the timeout is passed on, on every platform', () => {
  const mac = dialogInvocation('darwin', 'body "quoted"', 'Title', 180);
  assert.equal(mac.command, 'osascript');
  const script = mac.args.filter((_, i) => mac.args[i - 1] === '-e').join('\n');
  assert.match(script, /default button "Allow"/);
  assert.match(script, /giving up after/);
  assert.deepEqual(mac.args.slice(-3), ['body "quoted"', 'Title', '180']); // text travels as an argument, never inside the script
  assert.ok(!script.includes('body'));
  const win = dialogInvocation('win32', 'body', 'Title', 180);
  assert.equal(win.command, 'powershell');
  assert.match(win.args.join(' '), /Popup/);
  assert.equal(win.args.at(-1), '180');
  assert.equal(win.env.CLAUDE_ASK_DIALOG_TEXT, 'body');
  const linux = dialogInvocation('linux', 'a < b & c', 'Title', 180);
  assert.equal(linux.command, 'zenity');
  for (const flag of ['--question', '--ok-label=Allow', '--cancel-label=Deny', '--timeout=180', '--text=a &lt; b &amp; c']) assert.ok(linux.args.includes(flag), flag);
  assert.equal(dialogInvocation('freebsd', 'b', 't', 1), undefined);
});

test('parseDialogResult: allow, deny, timeout, and anything unreadable is "unavailable"', () => {
  const r = (status, stdout = '', stderr = '') => ({ status, stdout, stderr });
  assert.equal(parseDialogResult('darwin', r(0, 'button returned:Allow, gave up:false')), 'allow');
  assert.equal(parseDialogResult('darwin', r(0, 'button returned:Deny, gave up:false')), 'deny');
  assert.equal(parseDialogResult('darwin', r(0, 'button returned:, gave up:true')), 'timeout');
  assert.equal(parseDialogResult('darwin', r(1, '', 'execution error: User canceled. (-128)')), 'deny');
  assert.equal(parseDialogResult('darwin', r(1, '', 'no window server')), 'unavailable');
  assert.equal(parseDialogResult('win32', r(0, '6')), 'allow');
  assert.equal(parseDialogResult('win32', r(0, '7')), 'deny');
  assert.equal(parseDialogResult('win32', r(0, '-1')), 'timeout');
  assert.equal(parseDialogResult('win32', r(1, '', 'boom')), 'unavailable');
  assert.equal(parseDialogResult('linux', r(0)), 'allow');
  assert.equal(parseDialogResult('linux', r(1)), 'deny');
  assert.equal(parseDialogResult('linux', r(5)), 'timeout');
  assert.equal(parseDialogResult('linux', r(1, '', 'Gtk-WARNING: cannot open display: ')), 'unavailable');
  assert.equal(parseDialogResult('linux', r(255)), 'unavailable');
  assert.equal(parseDialogResult('darwin', { status: null, error: new Error('ENOENT') }), 'unavailable');
});

test('answerAsk: Allow allows, Deny denies, a timeout auto-allows and says so', () => {
  const allow = answerAsk(request, fakeDialog('allow').env);
  assert.deepEqual([allow.decision, allow.outcome], ['allow', 'allow']);
  const deny = answerAsk(request, fakeDialog('deny').env);
  assert.deepEqual([deny.decision, deny.outcome], ['deny', 'deny']);
  assert.match(deny.reason, /denied by the owner/);
  const late = answerAsk(request, fakeDialog('timeout').env);
  assert.deepEqual([late.decision, late.outcome], ['allow', 'timeout']);
  assert.match(late.reason, /auto-allowed after 3 min/);
  assert.match(answerAsk(request, fakeDialog('timeout', { CLAUDE_ASK_TIMEOUT_S: '45' }).env).reason, /auto-allowed after 45 s/);
});

test('answerAsk: a failing or missing dialog tool and a missing GUI fall back to the native ask', () => {
  const failed = answerAsk(request, fakeDialog('fail').env);
  assert.deepEqual([failed.decision, failed.outcome], ['ask', 'dialog-failed']);
  const missing = answerAsk(request, { ...fakeDialog('allow').env, PATH: '' });
  assert.deepEqual([missing.decision, missing.outcome], ['ask', 'dialog-failed']);
  const ssh = answerAsk(request, { ...fakeDialog('allow').env, SSH_CONNECTION: '1 2 3 4' });
  assert.deepEqual([ssh.decision, ssh.outcome], ['ask', 'no-gui']);
});

test('the dialog shows tool, short command, directory and session; it never shows a secret', () => {
  const dialog = fakeDialog('allow');
  answerAsk({ ...request, reason: `contains ${SECRET}`, command: `echo ${SECRET} ${'x'.repeat(400)}` }, dialog.env);
  const shown = shownText(dialog);
  assert.ok(!shown.includes(SECRET));
  for (const part of ['Tool: Bash', '[masked]', `Directory: ${PROJECT}`, 'session session-', 'agent agent-87', 'Allow is the default', '3 min']) assert.ok(shown.includes(part), part);
  assert.ok(!shown.includes('x'.repeat(250)), 'the command is cut');
});

test('decisionOutput: the PreToolUse JSON for allow, deny and ask', () => {
  for (const decision of ['allow', 'deny', 'ask']) {
    const out = JSON.parse(decisionOutput({ decision, reason: 'why' })).hookSpecificOutput;
    assert.deepEqual(out, { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: 'why' });
  }
});

const runGuard = (command, env) => spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ cwd: PROJECT, session_id: 'sess-1', tool_input: { command } }), encoding: 'utf8', env: { ...env, CLAUDE_PROJECT_DIR: PROJECT } });
const decisionOf = (r) => JSON.parse(r.stdout).hookSpecificOutput;

test('guard hook: Allow, Deny and timeout come back as allow / deny / allow and are logged without the secret', () => {
  for (const [result, decision] of [['allow', 'allow'], ['deny', 'deny'], ['timeout', 'allow']]) {
    const dialog = fakeDialog(result);
    const r = runGuard(`git push origin main # ${SECRET}`, dialog.env);
    assert.equal(r.status, 0, result);
    assert.equal(decisionOf(r).permissionDecision, decision, result);
    const [entry] = dialog.log();
    assert.equal(entry.outcome, result);
    assert.equal(entry.decision, decision);
    assert.equal(entry.hook, 'pre-bash-guard');
    assert.ok(!readFileSync(dialog.env.CLAUDE_GUARD_LOG, 'utf8').includes(SECRET));
    assert.ok(!r.stdout.includes(SECRET) && !shownText(dialog).includes(SECRET));
  }
  assert.match(decisionOf(runGuard('git push', fakeDialog('timeout').env)).permissionDecisionReason, /auto-allowed after 3 min/);
});

test('guard hook: a destructive hit says DESTRUCTIVE in the dialog; a failed dialog falls back to ask; a clean command never asks', () => {
  const dialog = fakeDialog('allow');
  runGuard('rm -rf /', dialog.env);
  assert.match(shownText(dialog), /DESTRUCTIVE: rm -r outside the project/);
  assert.equal(decisionOf(runGuard('git push -f', fakeDialog('fail').env)).permissionDecision, 'ask');
  const clean = fakeDialog('deny');
  assert.equal(runGuard('pnpm test', clean.env).stdout, '');
  assert.throws(() => clean.shown(), /ENOENT/);
});

test('Artifact hook: publish goes through the timed dialog; read never asks', () => {
  const run = (input, env) => spawnSync(process.execPath, [ARTIFACT], { input: JSON.stringify(input), encoding: 'utf8', env });
  const dialog = fakeDialog('deny');
  assert.equal(decisionOf(run({ session_id: 's', tool_input: { action: 'delete', url: 'https://x/a/1' } }, dialog.env)).permissionDecision, 'deny');
  assert.equal(dialog.log()[0].hook, 'artifact-ask');
  assert.equal(decisionOf(run({ tool_input: { action: 'publish' } }, fakeDialog('timeout').env)).permissionDecision, 'allow');
  assert.equal(run({ tool_input: { action: 'read' } }, fakeDialog('deny').env).stdout, '');
});

test('guard-log: one masked, truncated JSON line per decision; the path is overridable; a write failure is silent', () => {
  const path = tempLogPath();
  logDecision({ hook: 'h', tool: 'Bash', decision: 'allow', outcome: 'timeout', reason: `r ${SECRET}`, command: `${SECRET} ${'y'.repeat(500)}`, cwd: '/c', session: 's' }, { CLAUDE_GUARD_LOG: path });
  const line = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(!JSON.stringify(line).includes(SECRET));
  assert.ok(line.command.length <= 200);
  assert.match(line.ts, /^\d{4}-\d\d-\d\dT/);
  assert.equal(guardLogPath({ CLAUDE_GUARD_LOG: path }), path);
  assert.equal(guardLogPath({}), GUARD_LOG_FILE);
  const blocker = join(mkdtempSync(join(tmpdir(), 'blocker-')), 'file');
  writeFileSync(blocker, 'x');
  assert.doesNotThrow(() => logDecision({ hook: 'h' }, { CLAUDE_GUARD_LOG: join(blocker, 'sub', 'g.jsonl') }));
});

test('disk wipes ask as DESTRUCTIVE; ordinary dd, device reads and file formatting do not', () => {
  for (const command of ['dd if=/dev/zero of=/dev/sda bs=1M', 'sudo mkfs.ext4 /dev/sdb1', 'mkfs /dev/sdb', 'wipefs -a /dev/nvme0n1', 'shred -n 3 /dev/sda', 'blkdiscard /dev/sdc', 'bash -c "dd if=x of=/dev/disk2"']) {
    const r = decide(command, ctx);
    assert.equal(r.ask, true, command);
    assert.match(r.reason, /^DESTRUCTIVE: .*wipe/, command);
  }
  for (const command of ['dd if=/dev/zero of=./image.img bs=1M count=1', 'dd if=/dev/sda of=backup.img', 'dd if=a of=/dev/null', 'cat /dev/urandom | head -c 8', 'shred secret.txt', 'echo mkfs']) {
    assert.deepEqual(decide(command, ctx), { allow: true }, command);
  }
});
