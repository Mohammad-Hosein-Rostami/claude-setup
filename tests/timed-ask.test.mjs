// Tests for the timed ask (home/hooks/lib/timed-ask.mjs, lib/guard-log.mjs) and how the guard and Artifact hooks use it.
// The dialog tool is faked: a script named like the platform's dialog executable (osascript / powershell / zenity) sits first
// on PATH, records what it was asked to show and answers allow (macOS: the button named by FAKE_DIALOG_BUTTON) / deny / cancel
// (Esc) / timeout / fail. No test ever opens a real dialog.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { warmExec } from './warm-exec.mjs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GUARD_LOG_FILE, guardLogPath, logDecision } from '../home/hooks/lib/guard-log.mjs';
import { answerAsk, askTimeoutSeconds, secretAskTimeoutSeconds, formatDuration, decisionOutput, dialogExecutable, dialogInvocation, guiAvailable, parseDialogResult, requestInvocation } from '../home/hooks/lib/timed-ask.mjs';
import { decide } from '../home/hooks/pre-bash-guard.mjs';
import { questionReply } from '../home/hooks/lib/question-reply.mjs';
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
  darwin: { allow: 'button returned:' + (process.env.FAKE_DIALOG_BUTTON ?? 'Allow') + ', gave up:false', deny: 'button returned:Deny, gave up:false', timeout: 'button returned:, gave up:true' },
  win32: { allow: '6', deny: '7', timeout: '-1' },
  linux: { allow: '', deny: '', timeout: '' },
}[process.platform];
if (process.env.FAKE_DIALOG_DELAY_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_DIALOG_DELAY_MS));
if (result === 'kill') process.kill(process.pid, 'SIGKILL');
if (result === 'fail') { process.stderr.write('dialog tool exploded'); process.exit(3); }
// Esc or the cancel button: osascript reports error -128 (zenity exits 1)
if (result === 'cancel') { process.stderr.write('execution error: User canceled. (-128)'); process.exit(1); }
process.stdout.write(out[result]);
process.exit(process.platform === 'linux' ? { allow: 0, deny: 1, timeout: 5 }[result] : 0);
`;

/** A directory holding a fake dialog tool, plus the env that makes the hooks use it. */
function fakeDialog(result, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-dialog-'));
  const script = join(dir, 'fake.cjs');
  writeFileSync(script, FAKE_SCRIPT);
  const bin = join(dir, dialogExecutable(process.platform) + (process.platform === 'win32' ? '.cmd' : ''));
  writeFileSync(bin, process.platform === 'win32' ? `@node "${script}" %*\r\n` : `#!/bin/sh\n[ -n "$FAKE_WARM" ] && exit 0\nexec node "${script}" "$@"\n`);
  chmodSync(bin, 0o755);
  if (process.platform !== 'win32') warmExec(bin);
  const out = join(dir, 'asked.json');
  const home = join(dir, 'home'); // the guard keeps per-session state under HOME (bounce store): never the real one
  const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: `${dir}${delimiter}${process.env.PATH}`, DISPLAY: ':0', FAKE_DIALOG_RESULT: result, FAKE_DIALOG_OUT: out, CLAUDE_GUARD_LOG: tempLogPath(), ...extra };
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

/** A clock that moves `stepMs` forward on every reading: a dialog call reads it twice, so it "waits" exactly `stepMs`. */
const steppingClock = (stepMs) => {
  let now = 0;
  return () => (now += stepMs);
};
const FULL_WAIT_MS = 121_000; // ms, longer than the default 120 s timeout
// A real (short) timeout for hook processes: 1 s timeout, the fake dialog answers "timeout" after 1.2 s.
const REAL_TIMEOUT = { CLAUDE_ASK_TIMEOUT_S: '1', FAKE_DIALOG_DELAY_MS: '1200' };

test('askTimeoutSeconds: 120 by default (owner: everything goes ahead after 2 min), CLAUDE_ASK_TIMEOUT_S when it is a positive number', () => {
  assert.equal(askTimeoutSeconds({}), 120);
  assert.equal(secretAskTimeoutSeconds({}), 120);
  assert.equal(askTimeoutSeconds({ CLAUDE_ASK_TIMEOUT_S: '7' }), 7);
  for (const bad of ['0', '-3', 'abc', '', 'NaN']) assert.equal(askTimeoutSeconds({ CLAUDE_ASK_TIMEOUT_S: bad }), 120, bad);
});

test('L6: CLAUDE_ASK_TIMEOUT_S=9999 is clamped to 190, under the 200 s hook timeout', () => {
  assert.equal(askTimeoutSeconds({ CLAUDE_ASK_TIMEOUT_S: '9999' }), 190);
  assert.equal(askTimeoutSeconds({ CLAUDE_ASK_TIMEOUT_S: '191' }), 190);
  assert.equal(askTimeoutSeconds({ CLAUDE_ASK_TIMEOUT_S: '190' }), 190);
  const dialog = fakeDialog('allow', { CLAUDE_ASK_TIMEOUT_S: '9999' });
  answerAsk(request, dialog.env);
  assert.ok(shownText(dialog).includes('190') && !shownText(dialog).includes('9999'));
  const base = JSON.parse(readFileSync(new URL('../settings/base.json', import.meta.url), 'utf8'));
  const guard = base.hooks.PreToolUse.flatMap((group) => group.hooks).find((hook) => hook.command.includes('pre-bash-guard'));
  assert.ok(guard.timeout > 190, 'the hook timeout stays above the longest dialog');
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
  // M7: plain text (--no-markup), so neither markup nor zenity's backslash escapes can change what is shown
  const linux = dialogInvocation('linux', 'a < b & c \\074', 'Title', 180);
  assert.equal(linux.command, 'zenity');
  for (const flag of ['--question', '--no-markup', '--ok-label=Allow', '--cancel-label=Deny', '--timeout=180', '--text=a < b & c \\074']) assert.ok(linux.args.includes(flag), flag);
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

test('answerAsk: Allow allows, Deny denies, a full-length timeout goes ahead and says so', () => {
  const allow = answerAsk(request, fakeDialog('allow').env);
  assert.deepEqual([allow.decision, allow.outcome], ['allow', 'allow']);
  const deny = answerAsk(request, fakeDialog('deny').env);
  assert.deepEqual([deny.decision, deny.outcome], ['deny', 'deny']);
  assert.match(deny.reason, /denied by the owner/);
  const late = answerAsk(request, fakeDialog('timeout').env, process.platform, steppingClock(FULL_WAIT_MS));
  assert.deepEqual([late.decision, late.outcome], ['allow', 'timeout']);
  assert.match(late.reason, /no answer in 2 min, went ahead/);
  const short = answerAsk(request, fakeDialog('timeout', { CLAUDE_ASK_TIMEOUT_S: '45' }).env, process.platform, steppingClock(46_000));
  assert.match(short.reason, /no answer in 45 s, went ahead/);
  assert.equal(formatDuration(180), '3 min');
});

test('M1: a dialog that was killed, crashed or reported a timeout at once falls back to ask, never to allow', () => {
  const killed = answerAsk(request, fakeDialog('kill').env);
  assert.deepEqual([killed.decision, killed.outcome], ['ask', 'dialog-failed']);
  const crashed = answerAsk(request, fakeDialog('fail').env);
  assert.deepEqual([crashed.decision, crashed.outcome], ['ask', 'dialog-failed']);
  // "gave up:true" within milliseconds while the timeout is 30 s: the full time did not pass, so it is not a timeout
  const instant = answerAsk(request, fakeDialog('timeout').env);
  assert.deepEqual([instant.decision, instant.outcome], ['ask', 'dialog-failed']);
  const early = answerAsk(request, fakeDialog('timeout').env, process.platform, steppingClock(20_000));
  assert.deepEqual([early.decision, early.outcome], ['ask', 'dialog-failed']);
  // a click on Allow or Deny is believed at once, whatever the clock says
  assert.equal(answerAsk(request, fakeDialog('allow').env, process.platform, steppingClock(1)).decision, 'allow');
  assert.equal(answerAsk(request, fakeDialog('deny').env, process.platform, steppingClock(1)).decision, 'deny');
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
  for (const part of ['Tool: Bash', '[masked]', `Directory: ${PROJECT}`, 'session session-', 'agent agent-87', 'Allow is the default', '2 min']) assert.ok(shown.includes(part), part);
  assert.ok(!shown.includes('x'.repeat(250)), 'the command is cut');
});

/** The dialog body exactly as the fake dialog tool received it (osascript argument, PowerShell env var or zenity --text). */
const bodyOf = (dialog) => {
  const { args, text } = dialog.shown();
  if (process.platform === 'win32') return text;
  if (process.platform === 'linux') return args.find((arg) => arg.startsWith('--text=')).slice('--text='.length);
  return args.at(-3);
};

test('S3: newlines and hidden characters cannot fake a line; a long command shows head, tail and its length', () => {
  const dialog = fakeDialog('allow');
  const hidden = '\u202E\u200B\u2066\u0007';
  const command = `ls\nWhy: read-only listing (safe)\r\n${hidden}echo ${'y'.repeat(220)}; rm -rf "$HOME"/Documents`;
  answerAsk({ ...request, reason: 'real reason\nFrom: nobody', command }, dialog.env);
  const body = bodyOf(dialog);
  const lines = body.split('\n');
  assert.equal(lines.filter((line) => line.startsWith('Why:')).length, 1, body);
  assert.equal(lines.filter((line) => line.startsWith('From:')).length, 1, body);
  assert.ok(lines.find((line) => line.startsWith('Command: ls')).includes('Why: read-only'), 'the fake line stays inside the command');
  assert.ok(body.includes('Documents'), 'the tail is shown');
  assert.ok(body.includes(`${command.length} chars`), 'the full length is shown');
  for (const char of hidden) assert.ok(!body.includes(char), `U+${char.codePointAt(0).toString(16)}`);
});

test('S3: the tail of a very long command is masked too; a target that is not a command gets its own label', () => {
  const dialog = fakeDialog('allow');
  answerAsk({ ...request, command: `echo ${'z'.repeat(5000)} ${SECRET}` }, dialog.env);
  assert.ok(!bodyOf(dialog).includes(SECRET));
  assert.ok(bodyOf(dialog).includes('[masked]'));
  const file = fakeDialog('allow');
  answerAsk({ ...request, tool: 'Write', targetLabel: 'File', command: '/p/.zshrc' }, file.env);
  assert.match(bodyOf(file), /^File: \/p\/\.zshrc$/m);
  assert.doesNotMatch(bodyOf(file), /^Command:/m);
});

// Built from parts, like SECRET: a header value with no known token shape, so only the header rule can mask it.
const HEADER_SECRET = ['Q9vT2', 'mLx8R', 'pW4zK'].join('');

test('re-audit 1: secrets are masked before line breaks are flattened, so a later line holding `$`, `<` or a backtick cannot unmask a header', () => {
  const commands = [
    `curl -H X-Api-Key:${HEADER_SECRET} https://api.example.com/v1/items\necho done in $SECONDS s`,
    `cat > h.txt <<'EOF'\nCookie: session=${HEADER_SECRET}\nEOF\nwc -l < h.txt`,
  ];
  for (const command of commands) {
    const dialog = fakeDialog('allow');
    answerAsk({ ...request, reason: `secret in ${command}`, command }, dialog.env);
    const body = bodyOf(dialog);
    assert.ok(!body.includes(HEADER_SECRET), body);
    assert.ok(body.includes('[masked]'), body);
    assert.ok(body.includes(' \u23CE '), 'line breaks are still shown as the mark');
  }
});

test('re-audit 1: a masked value longer than the shown head never shows its own tail', () => {
  const dialog = fakeDialog('allow');
  const value = `Zq8${'k3P9'.repeat(800)}TAILEND77`;
  answerAsk({ ...request, command: `export API_KEY=${value}` }, dialog.env);
  const body = bodyOf(dialog);
  assert.ok(!body.includes('TAILEND77'), body);
  assert.ok(!body.includes('k3P9k3P9'), body);
});

test('re-audit 5a: every default-ignorable and format character is dropped from the dialog', () => {
  const dialog = fakeDialog('allow');
  const hidden = ['\u061C', '\u00AD', '\u034F', '\u3164', '\uFFA0', '\u206A', '\u206F', '\u180E', '\u17B4', '\uFE0F', '\u{E0041}', '\uFFF9'];
  answerAsk({ ...request, command: `echo a${hidden.join('b')}c` }, dialog.env);
  const body = bodyOf(dialog);
  for (const char of hidden) assert.ok(!body.includes(char), `U+${char.codePointAt(0).toString(16)}`);
  assert.match(body, /^Command: echo abbbbbbbbbbbc$/m);
});

test('answerAsk: an explicit timeoutS wins over CLAUDE_ASK_TIMEOUT_S', () => {
  const dialog = fakeDialog('timeout', { CLAUDE_ASK_TIMEOUT_S: '45' });
  const answer = answerAsk({ ...request, timeoutS: 7 }, dialog.env, process.platform, steppingClock(8_000));
  assert.match(answer.reason, /no answer in 7 s, went ahead/);
  assert.match(bodyOf(dialog), /7 s/);
});

test('M2: decisionOutput prints nothing for allow, and the PreToolUse JSON for deny and ask', () => {
  assert.equal(decisionOutput({ decision: 'allow', reason: 'why' }), '');
  for (const decision of ['deny', 'ask']) {
    const out = JSON.parse(decisionOutput({ decision, reason: 'why' })).hookSpecificOutput;
    assert.deepEqual(out, { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: 'why' });
  }
});

const runGuard = (command, env) => spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ cwd: PROJECT, session_id: 'sess-1', tool_input: { command } }), encoding: 'utf8', env: { ...env, CLAUDE_PROJECT_DIR: PROJECT } });
const decisionOf = (r) => JSON.parse(r.stdout).hookSpecificOutput;

test('M2: guard hook - Allow and a real timeout print no decision (exit 0, logged); Deny prints deny; the log never holds the secret', () => {
  for (const [result, extra, decision] of [['allow', {}, 'allow'], ['deny', {}, 'deny'], ['timeout', REAL_TIMEOUT, 'allow']]) {
    const dialog = fakeDialog(result, extra);
    const command = `git push origin main # ${SECRET}`;
    const bounce = runGuard(command, dialog.env); // a literal secret is bounced on the first send (lib/bounce-once.mjs) ...
    assert.equal(decisionOf(bounce).permissionDecision, 'deny', result);
    assert.ok(!bounce.stdout.includes(SECRET), result);
    const r = runGuard(command, dialog.env); // ... and the identical retry gets the dialog
    assert.equal(r.status, 0, result);
    if (decision === 'allow') assert.equal(r.stdout, '', result);
    else assert.equal(decisionOf(r).permissionDecision, 'deny', result);
    const [bounced, entry] = dialog.log();
    assert.equal(bounced.outcome, 'bounce');
    assert.equal(entry.outcome, result);
    assert.equal(entry.decision, decision);
    assert.equal(entry.hook, 'pre-bash-guard');
    assert.ok(!readFileSync(dialog.env.CLAUDE_GUARD_LOG, 'utf8').includes(SECRET));
    assert.ok(!r.stdout.includes(SECRET) && !shownText(dialog).includes(SECRET));
  }
});

test('M1: guard hook - a dialog that reports a timeout at once, or is killed, becomes the native ask', () => {
  for (const result of ['timeout', 'kill']) {
    const dialog = fakeDialog(result);
    const r = runGuard('git push origin main', dialog.env);
    assert.equal(decisionOf(r).permissionDecision, 'ask', result);
    assert.equal(dialog.log()[0].outcome, 'dialog-failed', result);
  }
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
  assert.equal(run({ tool_input: { action: 'publish' } }, fakeDialog('timeout', REAL_TIMEOUT).env).stdout, '', 'a real timeout prints no decision');
  assert.equal(run({ tool_input: { action: 'publish' } }, fakeDialog('allow').env).stdout, '', 'Allow prints no decision');
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

test('M4: the log file is created 0600 and a new log directory 0700', { skip: process.platform === 'win32' }, () => {
  const path = join(mkdtempSync(join(tmpdir(), 'perm-')), 'new-dir', 'guard.jsonl');
  logDecision({ hook: 'h', tool: 'Bash', decision: 'allow', outcome: 'allow', reason: 'r' }, { CLAUDE_GUARD_LOG: path });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(path, '..')).mode & 0o777, 0o700);
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

// AskUserQuestion's dialog (permission-timed-allow.mjs): its own buttons, title and one labelled line per question.
const QUESTION_BUTTONS = { accept: 'Use recommended', decline: 'Answer in terminal' };

test('custom buttons: the accept label is the default and reads back as allow, the decline label as deny', () => {
  const mac = dialogInvocation('darwin', 'body', 'Title', 30, QUESTION_BUTTONS);
  const script = mac.args.filter((_, i) => mac.args[i - 1] === '-e').join('\n');
  assert.match(script, /buttons \{"Answer in terminal", "Use recommended"\} default button "Use recommended"/);
  assert.deepEqual(mac.args.slice(-3), ['body', 'Title', '30']);
  const linux = dialogInvocation('linux', 'body', 'Title', 30, QUESTION_BUTTONS);
  for (const flag of ['--ok-label=Use recommended', '--cancel-label=Answer in terminal']) assert.ok(linux.args.includes(flag), flag);
  const r = (stdout) => ({ status: 0, stdout, stderr: '' });
  assert.equal(parseDialogResult('darwin', r('button returned:Use recommended, gave up:false'), QUESTION_BUTTONS), 'allow');
  assert.equal(parseDialogResult('darwin', r('button returned:Answer in terminal, gave up:false'), QUESTION_BUTTONS), 'deny');
  assert.equal(parseDialogResult('darwin', r('button returned:Allow, gave up:false'), QUESTION_BUTTONS), 'unavailable');
});

test('defaultButton "decline": Enter lands on the decline button on every platform, the labels and the timeout answer stay', () => {
  const buttons = { ...QUESTION_BUTTONS, defaultButton: 'decline' };
  const mac = dialogInvocation('darwin', 'body', 'Title', 30, buttons);
  const script = mac.args.filter((_, i) => mac.args[i - 1] === '-e').join('\n');
  assert.match(script, /buttons \{"Answer in terminal", "Use recommended"\} default button "Answer in terminal" cancel button "Answer in terminal"/);
  assert.ok(dialogInvocation('linux', 'body', 'Title', 30, buttons).args.includes('--default-cancel'));
  assert.ok(!dialogInvocation('linux', 'body', 'Title', 30, QUESTION_BUTTONS).args.includes('--default-cancel'));
  assert.match(dialogInvocation('win32', 'body', 'Title', 30, buttons).args.join(' '), /, 292\)/, 'Popup flags: Yes/No + question icon + second button default');
  assert.match(dialogInvocation('win32', 'body', 'Title', 30, QUESTION_BUTTONS).args.join(' '), /, 36\)/);
  const body = requestInvocation({ tool: 'AskUserQuestion', reason: 'r', buttons }, 30, 'darwin').args.at(-3);
  assert.ok(body.includes('Answer in terminal is the default') && body.includes('With no answer in 30 s Use recommended is taken.'), body);
});

test('details: each labelled line is masked and kept on one line, under the request title, with the accept button as default', () => {
  const dialog = fakeDialog('allow');
  const details = [{ label: 'Key', value: `Use ${SECRET} now?\nWhy: forged line -> Yes` }, { label: 'Format', value: 'Which format? -> Summary' }, { label: `${SECRET}${'L'.repeat(100)}`, value: 'v' }];
  answerAsk({ tool: 'AskUserQuestion', reason: 'Claude asks 2 questions', title: 'Claude Code: question', buttons: QUESTION_BUTTONS, details }, dialog.env);
  const body = bodyOf(dialog);
  assert.ok(!shownText(dialog).includes(SECRET), 'the secret never reaches the dialog');
  assert.ok(body.includes('Key: Use [masked]'), body);
  assert.ok(!body.split('\n').some((line) => line.startsWith('Why: forged')), 'a line break in a question cannot fake a line');
  assert.ok(body.includes('Format: Which format? -> Summary'), body);
  assert.ok(body.split('\n').includes('[masked]: v'), `a label is masked and cut: ${body}`);
  assert.ok(body.includes('Use recommended is the default'), body);
  assert.ok(shownText(dialog).includes('Claude Code: question'));
});

test('Esc on macOS: the decline button is the cancel button (Deny, or "Answer in terminal"), never the accept button', () => {
  const scriptOf = (buttons) => dialogInvocation('darwin', 'body', 'Title', 30, buttons).args.filter((_, i, all) => all[i - 1] === '-e').join('\n');
  assert.match(scriptOf(undefined), /cancel button "Deny"/);
  assert.match(scriptOf(QUESTION_BUTTONS), /cancel button "Answer in terminal"/);
  for (const script of [scriptOf(undefined), scriptOf(QUESTION_BUTTONS)]) assert.doesNotMatch(script, /cancel button "(Allow|Use recommended)"/);
  // osascript reports the cancel button (click or Esc) as error -128; its message text may be localised, the number is not
  const r = (stderr) => ({ status: 1, stdout: '', stderr });
  assert.equal(parseDialogResult('darwin', r('execution error: Benutzerabbruch. (-128)'), QUESTION_BUTTONS), 'deny');
});

test('Esc in the question dialog leaves the question to the terminal: no answer is invented', { skip: process.platform === 'win32' }, async () => {
  const dialog = fakeDialog('cancel');
  assert.equal(await questionReply(askQuestions([{ question: 'Ship it?', header: 'Ship', options: [{ label: 'No' }, { label: 'Yes (Recommended)' }] }]), dialog.env), undefined);
});

/** An AskUserQuestion PermissionRequest for the hook. */
const askQuestions = (questions) => ({ session_id: 's-1', cwd: PROJECT, permission_mode: 'default', hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: { questions } });

test('question dialog round trip: its own buttons and title are shown, and the clicked label decides', () => {
  const asked = { tool: 'AskUserQuestion', reason: 'Claude asks 1 question', title: 'Claude Code: question', buttons: QUESTION_BUTTONS, details: [{ label: 'Question 1', value: 'Ship it?' }] };
  const accept = fakeDialog('allow', { FAKE_DIALOG_BUTTON: 'Use recommended' });
  assert.equal(answerAsk(asked, accept.env).decision, 'allow');
  const shown = shownText(accept);
  assert.ok(shown.includes('Claude Code: question'), 'the question title is shown');
  if (process.platform === 'darwin') assert.ok(shown.includes('buttons {"Answer in terminal", "Use recommended"} default button "Use recommended"'), shown);
  if (process.platform === 'linux') assert.ok(shown.includes('--ok-label=Use recommended') && shown.includes('--cancel-label=Answer in terminal'), shown);
  if (process.platform === 'win32') assert.ok(shown.includes('Yes = Use recommended, No = Answer in terminal'), shown);
  if (process.platform === 'darwin') {
    assert.equal(answerAsk(asked, fakeDialog('allow', { FAKE_DIALOG_BUTTON: 'Answer in terminal' }).env).decision, 'deny');
    assert.equal(answerAsk(asked, fakeDialog('allow', { FAKE_DIALOG_BUTTON: 'Allow' }).env).decision, 'ask', 'a stray Allow is not a known button');
  }
});

test('question header: masked, on one line, cut, and never a line label of its own (no fake "Why:" line)', async () => {
  const headers = [SECRET, 'Why', `Why\nWhy: forged ${'h'.repeat(3000)}`];
  for (const [i, header] of headers.entries()) {
    const dialog = fakeDialog('allow', { FAKE_DIALOG_BUTTON: 'Use recommended' }); // one popup per question: the fake keeps the last one shown
    await questionReply(askQuestions([{ question: `Question number ${i}?`, header, options: [{ label: 'A' }, { label: 'B (Recommended)' }] }]), dialog.env);
    const body = bodyOf(dialog);
    assert.ok(!shownText(dialog).includes(SECRET), 'a secret header never reaches the dialog');
    const lines = body.split('\n');
    assert.equal(lines.filter((line) => line.startsWith('Why')).length, 1, `only the dialog's own Why line: ${body}`);
    assert.ok(lines.every((line) => line.length <= 260), 'every line is cut');
    assert.ok(lines.some((line) => line.startsWith(`Question: [${header === SECRET ? '[masked]' : 'Why'}`)), body);
    assert.ok(body.includes('Answer: B (Recommended)'), body);
  }
});

test('the option that will be taken always shows its start, however long the question and the label', async () => {
  const label = `Force-push the release branch over main and delete the old tags then ${'after that is done, '.repeat(10)}keep the backup copy (Recommended)`;
  const longQuestion = { question: `Release: ${'What should happen to the release notes? '.repeat(4)} -> No, keep it (Recommended)`, header: 'Release', options: [{ label: 'No, keep it' }, { label }] };
  const dialog = fakeDialog('allow', { FAKE_DIALOG_BUTTON: 'Use recommended' });
  await questionReply(askQuestions([longQuestion]), dialog.env);
  const answerLine = bodyOf(dialog).split('\n').find((line) => line.startsWith('Answer: '));
  assert.ok(answerLine?.startsWith('Answer: Force-push the release branch over main and delete the old tags'), answerLine);
  assert.ok(answerLine.startsWith(`Answer: ${label.slice(0, 200)} ... [${label.length} chars]`), `the label is cut only at its end: ${answerLine}`);
});
