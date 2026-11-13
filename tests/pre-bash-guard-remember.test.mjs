// End-to-end tests for the guard's per-session memory of an allowed literal secret (pre-bash-guard.mjs, lib/allowed-literals.mjs).
// The dialog is faked: a script named like the platform's dialog tool sits first on PATH, counts how often it is shown and answers.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { allowedLiteralsDir } from '../home/hooks/lib/allowed-literals.mjs';
import { dialogExecutable } from '../home/hooks/lib/timed-ask.mjs';
import { hookEnv } from './hook-env.mjs';

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
  const dir = mkdtempSync(join(tmpdir(), 'remember-'));
  const script = join(dir, 'fake.cjs');
  writeFileSync(script, FAKE_SCRIPT);
  const bin = join(dir, dialogExecutable(process.platform) + (process.platform === 'win32' ? '.cmd' : ''));
  writeFileSync(bin, process.platform === 'win32' ? `@node "${script}" %*\r\n` : `#!/bin/sh\nexec node "${script}" "$@"\n`);
  chmodSync(bin, 0o755);
  const count = join(dir, 'count');
  const home = join(dir, 'home');
  const base = hookEnv({ HOME: home, USERPROFILE: home, PATH: `${dir}${delimiter}${process.env.PATH}`, DISPLAY: ':0', FAKE_DIALOG_COUNT: count, CLAUDE_PROJECT_DIR: PROJECT });
  for (const name of ['NODE_TEST_CONTEXT', 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'CI']) delete base[name];
  return {
    home: { HOME: home },
    shownText: () => readFileSync(`${count}.shown`, 'utf8').trim().split('\n').map((line) => JSON.parse(line).join('\n')).at(-1),
    dialogs: () =>(existsSync(count) ? readFileSync(count, 'utf8').length : 0),
    log: () => readFileSync(base.CLAUDE_GUARD_LOG, 'utf8').trim().split('\n').map((line) => JSON.parse(line)),
    run(command, answer, sessionId = 'sess-1', extraEnv = {}) {
      const input = { cwd: PROJECT, session_id: sessionId, tool_input: { command } };
      return spawnSync(process.execPath, [GUARD], { input: JSON.stringify(input), encoding: 'utf8', env: { ...base, FAKE_DIALOG_RESULT: answer, ...extraEnv } });
    },
  };
}

test('allowed once: the same value again shows no dialog, prints nothing and logs outcome "remembered"', () => {
  const s = session();
  assert.equal(s.run(SECRET_COMMAND, 'allow').stdout, '');
  assert.equal(s.dialogs(), 1);
  const again = s.run(`KEY='${VALUE}' ./other-script.sh`, 'deny'); // a Deny answer would show if the dialog opened
  assert.equal(again.status, 0);
  assert.equal(again.stdout, '');
  assert.equal(s.dialogs(), 1, 'no second dialog');
  const last = s.log().at(-1);
  assert.deepEqual([last.decision, last.outcome], ['allow', 'remembered']);
});

test('the memory is per session and per value', () => {
  const s = session();
  s.run(SECRET_COMMAND, 'allow');
  s.run(SECRET_COMMAND, 'allow', 'sess-2');
  assert.equal(s.dialogs(), 2, 'another session asks again');
  s.run("KEY='another-unseen-value-99' ./fetch-figma.sh", 'allow');
  assert.equal(s.dialogs(), 3, 'another value asks again');
  s.run(`KEY='${VALUE}' PGPASSWORD=never-seen-before psql`, 'allow');
  assert.equal(s.dialogs(), 4, 'one unseen value among known ones asks again');
});

test('denied: nothing is remembered, the next run asks again', () => {
  const s = session();
  const denied = s.run(SECRET_COMMAND, 'deny');
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(existsSync(allowedLiteralsDir(s.home)), false);
  s.run(SECRET_COMMAND, 'deny');
  assert.equal(s.dialogs(), 2);
});

test('a dialog that fails (no GUI) falls back to ask and remembers nothing', () => {
  const s = session();
  const noGui = hookEnv({ HOME: s.home.HOME, CLAUDE_PROJECT_DIR: PROJECT });
  const input = { cwd: PROJECT, session_id: 'sess-1', tool_input: { command: SECRET_COMMAND } };
  const r = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(input), encoding: 'utf8', env: noGui });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(existsSync(allowedLiteralsDir(s.home)), false);
});

test('a secret together with git push always shows the dialog and is never remembered', () => {
  const s = session();
  const both = `KEY='${VALUE}' git push origin main`;
  s.run(both, 'allow');
  s.run(both, 'allow');
  assert.equal(s.dialogs(), 2);
  assert.equal(existsSync(allowedLiteralsDir(s.home)), false);
  s.run(SECRET_COMMAND, 'allow');
  s.run(both, 'allow');
  assert.equal(s.dialogs(), 4, 'a value remembered for a secret-only ask does not silence a mixed ask');
});

test('the remembered store holds no raw value', () => {
  const s = session();
  s.run(SECRET_COMMAND, 'allow');
  const file = join(allowedLiteralsDir(s.home), 'sess-1.json');
  assert.ok(!readFileSync(file, 'utf8').includes(VALUE));
});

test('a real timeout (auto-allow) is remembered; an allow-then-remembered value is silent next time', () => {
  const s = session();
  const waitedOut = { CLAUDE_ASK_TIMEOUT_S: '1', FAKE_DIALOG_DELAY_MS: '1200' };
  assert.equal(s.run(SECRET_COMMAND, 'timeout', 'sess-1', waitedOut).stdout, '');
  assert.equal(s.dialogs(), 1);
  s.run(SECRET_COMMAND, 'deny');
  assert.equal(s.dialogs(), 1, 'the timeout was remembered');
});

// Each of these hides a second command from the rules once a secret reason exists, so a remembered value must not silence them.
const HIDDEN_RISK = [
  `KEY='${VALUE}'; python3 -c "import os;os.system('git push -f')"`,
  `KEY='${VALUE}'; node -e "require('child_process').execSync('rm -rf /x')"`,
  `KEY='${VALUE}'; perl -e 'system("git push -f")'`,
  `KEY='${VALUE}'; osascript -e 'do shell script "git push -f"'`,
  `KEY='${VALUE}'; bash -c "PGPASS""WORD=${NEW_PART} psql"`,
  `KEY='${VALUE}'${NEW_PART} ./fetch-figma.sh`,
  `KEY='${VALUE}'; bash -c "PGPASSWORD=\\"${NEW_PART}\\" psql"`,
];

test('a remembered value never silences a command that hides another risk, a new secret or a partial value', () => {
  for (const command of HIDDEN_RISK) {
    const s = session();
    s.run(SECRET_COMMAND, 'allow');
    assert.equal(s.dialogs(), 1);
    s.run(command, 'allow');
    assert.equal(s.dialogs(), 2, `dialog for: ${command}`);
  }
});

test('a short value is never remembered', () => {
  const s = session();
  s.run('PGPASSWORD=short psql -h db', 'allow');
  s.run('PGPASSWORD=short psql -h db', 'allow');
  assert.equal(s.dialogs(), 2);
  assert.equal(existsSync(allowedLiteralsDir(s.home)), false);
});

test('a secret-only ask waits the short secret timeout, a push ask the normal one, and the lower setting wins', () => {
  const small = { CLAUDE_ASK_SECRET_TIMEOUT_S: '7', CLAUDE_ASK_TIMEOUT_S: '40' };
  const secret = session();
  secret.run(SECRET_COMMAND, 'allow', 'sess-1', small);
  assert.match(secret.shownText(), /With no answer in 7 s/);
  const push = session();
  push.run('git push origin main', 'allow', 'sess-1', small);
  assert.match(push.shownText(), /With no answer in 40 s/);
  const lower = session();
  lower.run(SECRET_COMMAND, 'allow', 'sess-1', { CLAUDE_ASK_SECRET_TIMEOUT_S: '7', CLAUDE_ASK_TIMEOUT_S: '5' });
  assert.match(lower.shownText(), /With no answer in 5 s/);
  const byDefault = session();
  byDefault.run(SECRET_COMMAND, 'allow');
  assert.match(byDefault.shownText(), /With no answer in 30 s/);
});

const HIDDEN_PUSH = `import os;os.system('git push -f origin main')`;

test('a secret next to a hidden push is not a secret-only ask: it gets the normal timeout, not the short one', () => {
  const s = session();
  s.run(`KEY='${VALUE}'; python3 -c "${HIDDEN_PUSH}"`, 'allow', 'sess-1', { CLAUDE_ASK_SECRET_TIMEOUT_S: '7', CLAUDE_ASK_TIMEOUT_S: '40' });
  assert.match(s.shownText(), /With no answer in 40 s/);
  assert.equal(existsSync(allowedLiteralsDir(s.home)), false, 'a mixed ask remembers nothing');
});

test('a remembered value that itself contains the dangerous words does not hide a later hidden push', () => {
  const s = session();
  s.run("KEY='git push -f' ./run", 'allow');
  assert.equal(s.dialogs(), 1);
  s.run("KEY='git push -f'; python3 -c \"import os;os.system('git push -f origin main')\"", 'allow');
  assert.equal(s.dialogs(), 2);
});
