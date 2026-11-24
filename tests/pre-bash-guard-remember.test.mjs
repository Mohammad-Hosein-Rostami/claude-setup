// End-to-end tests for literal secrets in the Bash guard under owner rule G1 (pre-bash-guard.mjs, lib/remembered-ask.mjs): a secret typed
// into a command never opens a dialog, is never bounced and is never remembered (the old lib/allowed-literals.mjs store stays unwritten);
// the log names its kind only. The dialog is faked: a script named like the platform's dialog tool sits first on PATH, counts how often
// it is shown and answers. run() sends a command and, when the guard bounces it, the identical retry; sendOnce() is a single send.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { sharedNodeToolDir } from './shared-tools.mjs';
import { delimiter, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { allowedLiteralsDir } from '../home/hooks/lib/allowed-literals.mjs';
import { RETRY_LINE } from '../home/hooks/lib/bounce-once.mjs';
import { dialogExecutable } from '../home/hooks/lib/timed-ask.mjs';
import { hookEnv } from './hook-env.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const GUARD = fileURLToPath(new URL('../home/hooks/pre-bash-guard.mjs', import.meta.url));
const PROJECT = resolve('/work/proj');
const VALUE = 'i6IWfakefilekey0123';
const SECRET_COMMAND = `KEY='${VALUE}' ./fetch-figma.sh`;
const NEW_PART = 'NEWTAIL98765';
const FAKE_SCRIPT = `
const { appendFileSync } = require('node:fs');
appendFileSync(process.env.FAKE_DIALOG_COUNT, 'x');
appendFileSync(process.env.FAKE_DIALOG_COUNT + '.shown', JSON.stringify([...process.argv.slice(2), process.env.CLAUDE_ASK_DIALOG_TEXT ?? '']) + '\\n');
const out = {
  darwin: { allow: 'button returned:Allow, gave up:false', deny: 'button returned:Deny, gave up:false', timeout: 'button returned:, gave up:true' },
  win32: { allow: '6', deny: '7', timeout: '-1' },
  linux: { allow: '', deny: '', timeout: '' },
}[process.platform];
if (process.env.FAKE_DIALOG_DELAY_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_DIALOG_DELAY_MS));
process.stdout.write(out[process.env.FAKE_DIALOG_RESULT]);
process.exit(process.platform === 'linux' ? { allow: 0, deny: 1, timeout: 5 }[process.env.FAKE_DIALOG_RESULT] : 0);
`;

/** One simulated owner session: a private HOME, decision log and fake dialog whose answer can change between calls. */
function session() {
  const dir = makeTempDir('remember-');
  // POSIX: one shared tool (a new executable is slow to start); it reads the answer and the count file from env
  const tools = process.platform === 'win32' ? dir : sharedNodeToolDir(dialogExecutable(process.platform), FAKE_SCRIPT);
  if (process.platform === 'win32') {
    const script = join(dir, 'fake.cjs');
    writeFileSync(script, FAKE_SCRIPT);
    writeFileSync(join(dir, `${dialogExecutable(process.platform)}.cmd`), `@node "${script}" %*\r\n`);
  }
  const count = join(dir, 'count');
  const home = join(dir, 'home');
  const base = hookEnv({ HOME: home, USERPROFILE: home, PATH: `${tools}${delimiter}${process.env.PATH}`, DISPLAY: ':0', FAKE_DIALOG_COUNT: count, CLAUDE_PROJECT_DIR: PROJECT });
  for (const name of ['NODE_TEST_CONTEXT', 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'CI']) delete base[name];
  const sendOnce = (command, answer, sessionId = 'sess-1', extraEnv = {}) => {
    const input = { cwd: PROJECT, session_id: sessionId, tool_input: { command } };
    return spawnSync(process.execPath, [GUARD], { input: JSON.stringify(input), encoding: 'utf8', env: { ...base, FAKE_DIALOG_RESULT: answer, ...extraEnv } });
  };
  return {
    home: { HOME: home },
    shownText: () => readFileSync(`${count}.shown`, 'utf8').trim().split('\n').map((line) => JSON.parse(line).join('\n')).at(-1),
    dialogs: () =>(existsSync(count) ? readFileSync(count, 'utf8').length : 0),
    log: () => readFileSync(base.CLAUDE_GUARD_LOG, 'utf8').trim().split('\n').map((line) => JSON.parse(line)),
    sendOnce,
    run(...args) {
      const first = sendOnce(...args);
      return isBounce(first) ? sendOnce(...args) : first;
    },
  };
}

/** True when the guard bounced the command (a deny whose text holds the retry line), not the owner. */
const isBounce = ({ stdout }) => stdout !== '' && JSON.parse(stdout).hookSpecificOutput.permissionDecisionReason.split('\n').includes(RETRY_LINE);
const noAllowMemory = (s) => existsSync(allowedLiteralsDir(s.home)) === false; // the old per-session secret memory is never written

test('G1: a secret-only command runs on its first send: no bounce, no dialog, no memory, one "secret" log line with the kind only', () => {
  const s = session();
  const first = s.sendOnce(SECRET_COMMAND, 'deny'); // a Deny answer would show if the dialog opened
  assert.deepEqual([first.status, first.stdout, s.dialogs()], [0, '', 0]);
  const lines = s.log();
  assert.deepEqual(lines.map(({ outcome, reason, command }) => [outcome, reason, command]), [['secret', 'a key, token, secret or password assigned in the command', '']]);
  assert.ok(!JSON.stringify(lines).includes(VALUE));
  assert.ok(noAllowMemory(s));
});

test('G1: another session, another value, a short value or a value with a tail glued on runs silently too', () => {
  const s = session();
  for (const [command, id] of [[SECRET_COMMAND, 'sess-2'], ["KEY='another-unseen-value-99' ./fetch-figma.sh", 'sess-1'], ['PGPASSWORD=short psql -h db', 'sess-1'],
    [`KEY='${VALUE}'${NEW_PART} ./fetch-figma.sh`, 'sess-1'], [`KEY='${VALUE}'; bash -c "PGPASSWORD=\\"${NEW_PART}\\" psql"`, 'sess-1']]) {
    assert.equal(s.sendOnce(command, 'deny', id).stdout, '', command);
  }
  assert.equal(s.dialogs(), 0);
  assert.ok(noAllowMemory(s));
});

test('G1: a secret next to git push: the push still asks the owner on every send, and the reason never names the secret', () => {
  const s = session();
  const both = `KEY='${VALUE}' git push origin main`;
  s.run(both, 'allow');
  s.run(both, 'deny');
  assert.equal(s.dialogs(), 2);
  assert.ok(!s.shownText().includes('literal password/token') && !s.shownText().includes(VALUE));
  assert.ok(noAllowMemory(s));
});

test('G1: the same secret-only command sent again and again never opens a dialog, and each send logs its own "secret" line', () => {
  const s = session();
  for (let send = 0; send < 3; send += 1) assert.deepEqual([s.sendOnce(SECRET_COMMAND, 'deny').stdout, s.dialogs()], ['', 0], `send ${send}`);
  assert.deepEqual(s.log().map(({ outcome, command }) => [outcome, command]), Array(3).fill(['secret', '']));
  assert.ok(noAllowMemory(s));
});

test('G1: a new command holding a value sent before is judged on its own: it runs as a secret line, never as "remembered"', () => {
  const s = session();
  s.sendOnce(SECRET_COMMAND, 'deny');
  const fresh = s.sendOnce(`KEY='${VALUE}' ./never-sent-before.sh`, 'deny');
  assert.deepEqual([fresh.stdout, s.dialogs(), s.log().at(-1).outcome], ['', 0, 'secret']);
  assert.ok(s.log().every(({ outcome }) => outcome !== 'remembered'));
  s.run(`KEY='${VALUE}' git push origin main`, 'allow');
  assert.equal(s.dialogs(), 1, 'an earlier secret-only send does not silence a push next to the same value');
});

test('G1: no file the guard writes (its log, its bounce store) holds the raw value, and no allow memory is made', () => {
  const s = session();
  s.sendOnce(SECRET_COMMAND, 'deny');
  s.run(`KEY='${VALUE}' git push origin main`, 'allow');
  s.run(`KEY='${VALUE}'; perl -e 'system("git push -f")'`, 'allow'); // bounced first: writes the bounce store
  const files = readdirSync(s.home.HOME, { recursive: true }).map((name) => join(s.home.HOME, String(name))).filter((path) => statSync(path).isFile());
  assert.ok(files.length > 0, 'the bounce store was written under HOME');
  for (const path of files) assert.equal(readFileSync(path, 'utf8').includes(VALUE), false, path);
  assert.equal(JSON.stringify(s.log()).includes(VALUE), false);
  assert.ok(noAllowMemory(s));
});

test('G1: a push next to a secret that times out goes ahead as a timeout, and the next send asks again (nothing is remembered)', () => {
  const s = session();
  const both = `KEY='${VALUE}' git push origin main`;
  const waitedOut = { CLAUDE_ASK_TIMEOUT_S: '1', FAKE_DIALOG_DELAY_MS: '1200' };
  assert.equal(s.run(both, 'timeout', 'sess-1', waitedOut).stdout, '');
  assert.deepEqual([s.dialogs(), s.log().map(({ outcome }) => outcome)], [1, ['secret', 'timeout']]);
  const denied = s.run(both, 'deny');
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(s.dialogs(), 2, 'the timeout was not remembered');
  assert.ok(noAllowMemory(s));
});

test('G1: a short secret value runs silently on every send, and its log lines hold no command', () => {
  const s = session();
  for (let send = 0; send < 2; send += 1) assert.equal(s.sendOnce('PGPASSWORD=short psql -h db', 'deny').stdout, '', `send ${send}`);
  assert.equal(s.dialogs(), 0);
  assert.deepEqual(s.log().map(({ outcome, command }) => [outcome, command]), Array(2).fill(['secret', '']));
  assert.ok(noAllowMemory(s));
});

test('G1: with no GUI a secret-only command still runs, and a secret next to a push still gets the CLI ask', () => {
  const s = session();
  const noGui = hookEnv({ HOME: s.home.HOME, CLAUDE_PROJECT_DIR: PROJECT });
  const send = (command) => spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ cwd: PROJECT, session_id: 'sess-1', tool_input: { command } }), encoding: 'utf8', env: noGui });
  assert.equal(send(SECRET_COMMAND).stdout, '');
  const push = send(`KEY='${VALUE}' git push origin main`);
  assert.equal(JSON.parse(push.stdout).hookSpecificOutput.permissionDecision, 'ask');
});

// Each of these hides a second command from the rules; with the secret no longer a reason, the fail-to-ask backstop judges them all.
const HIDDEN_RISK = [
  `KEY='${VALUE}'; python3 -c "import os;os.system('git push -f')"`,
  `KEY='${VALUE}'; node -e "require('child_process').execSync('rm -rf /x')"`,
  `KEY='${VALUE}'; perl -e 'system("git push -f")'`,
  `KEY='${VALUE}'; osascript -e 'do shell script "git push -f"'`,
  "KEY='git push -f'; python3 -c \"import os;os.system('git push -f origin main')\"",
];

test('G1: a secret never hides another risk: the first send bounces and the identical retry asks the owner', () => {
  for (const command of HIDDEN_RISK) {
    const s = session();
    assert.equal(isBounce(s.sendOnce(command, 'allow')), true, `bounced: ${command}`);
    s.sendOnce(command, 'allow');
    assert.equal(s.dialogs(), 1, `dialog for: ${command}`);
  }
});

test('G1: a secret next to a hidden push is judged by the hidden push alone: bounced once, then the dialog with the normal timeout, the value masked', () => {
  const s = session();
  const command = `KEY='${VALUE}'; python3 -c "import os;os.system('git push -f origin main')"`;
  const small = { CLAUDE_ASK_SECRET_TIMEOUT_S: '7', CLAUDE_ASK_TIMEOUT_S: '40' };
  assert.equal(isBounce(s.sendOnce(command, 'allow', 'sess-1', small)), true);
  s.sendOnce(command, 'allow', 'sess-1', small);
  assert.equal(s.dialogs(), 1);
  assert.match(s.shownText(), /With no answer in 40 s/);
  assert.equal(s.shownText().includes(VALUE), false);
  assert.ok(noAllowMemory(s));
});

test('G1: a secret value that itself holds dangerous words runs as data, and does not hide a later hidden push', () => {
  const s = session();
  assert.equal(s.sendOnce("KEY='git push -f' ./run", 'deny').stdout, '');
  assert.equal(s.dialogs(), 0);
  const hidden = "KEY='git push -f'; python3 -c \"import os;os.system('git push -f origin main')\"";
  assert.equal(isBounce(s.sendOnce(hidden, 'allow')), true);
  s.sendOnce(hidden, 'allow');
  assert.equal(s.dialogs(), 1);
  assert.deepEqual(s.log().map(({ outcome }) => outcome), ['secret', 'secret', 'bounce', 'secret', 'allow']);
});

test('the secret-only timeout knob no longer shortens anything: a push ask (with or without a secret) waits the normal timeout', () => {
  const small = { CLAUDE_ASK_SECRET_TIMEOUT_S: '7', CLAUDE_ASK_TIMEOUT_S: '40' };
  for (const command of ['git push origin main', `KEY='${VALUE}' git push origin main`]) {
    const s = session();
    s.run(command, 'allow', 'sess-1', small);
    assert.match(s.shownText(), /With no answer in 40 s/, command);
  }
});
