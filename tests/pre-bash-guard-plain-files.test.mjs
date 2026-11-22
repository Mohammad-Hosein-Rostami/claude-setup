// Tests that a file planted where the Bash guard reads or writes cannot make it wait or write somewhere else (principle P1): the private
// production-host list the guard reads on every call, and the plain-file helpers. A FIFO at such a path used to hold the hook until its
// timeout, and a hook that times out answers nothing. Both are opened through lib/plain-file.mjs.
// A host list that is there but is not a plain file cannot be trusted to be the list: every ssh, psql and mysql host then asks.
// The hook runs as Claude Code runs it, with a private HOME, TMPDIR and log and no GUI. A hook that hangs is killed by spawnSync and fails
// its test through the missing answer; no test measures time. Command strings are only sent to the hook; nothing is executed.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { appendPlainFile, NOT_PLAIN_FILE, readPlainFile } from '../home/hooks/lib/plain-file.mjs';
import { EVERY_HOST, MAX_PROD_HOSTS_BYTES, readProdHosts } from '../home/hooks/lib/remote.mjs';
import { hookEnv } from './hook-env.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const GUARD = fileURLToPath(new URL('../home/hooks/pre-bash-guard.mjs', import.meta.url));
const PROJECT = resolve('/work/proj');
const SESSION = 'sess-plain';
const KILL_AFTER_MS = 30000; // only so a hook that waits on a FIFO ends the test run; the assertions read the answer, never the time
const noFifo = process.platform === 'win32' ? 'Windows has no FIFO and no O_NOFOLLOW' : false;
const FORCE_PUSH = 'git push --force origin main';
const RESTART = "'systemctl restart api'";
const LISTED_WRITE = `ssh deploy@db-box ${RESTART}`;
const OTHER_WRITE = `ssh deploy@build-box ${RESTART}`;

/** One Bash call sent to the real hook process: its exit status, signal and decision. */
function hookAnswer(command, env) {
  const input = JSON.stringify({ cwd: PROJECT, session_id: SESSION, tool_input: { command } });
  const run = spawnSync(process.execPath, [GUARD], { input, encoding: 'utf8', timeout: KILL_AFTER_MS, env: hookEnv({ CLAUDE_PROJECT_DIR: PROJECT, ...env }) });
  const output = run.stdout ? JSON.parse(run.stdout).hookSpecificOutput : undefined;
  return { status: run.status, signal: run.signal, decision: output?.permissionDecision ?? 'allow', reason: output?.permissionDecisionReason ?? '' };
}

const makeFifo = (path) => execFileSync('mkfifo', [path]);
const answered = (answer) => [answer.status, answer.signal, answer.decision];

/** A temp folder with a host list file in it that names one host. */
function hostList() {
  const dir = makeTempDir('prod-hosts-');
  const list = join(dir, 'prod-hosts');
  writeFileSync(list, '# hosts\ndb-box\n');
  return { dir, list };
}

test('a plain host list is read as before: a listed host asks, another host does not, and so with no list at all', () => {
  const { dir, list } = hostList();
  assert.deepEqual(readProdHosts(list), ['db-box']);
  assert.deepEqual(readProdHosts(join(dir, 'no-such-file')), []);
  assert.match(hookAnswer(LISTED_WRITE, { CLAUDE_PROD_HOSTS_FILE: list }).reason, /db-box, a production host/);
  assert.equal(hookAnswer(OTHER_WRITE, { CLAUDE_PROD_HOSTS_FILE: list }).decision, 'allow');
  assert.equal(hookAnswer(OTHER_WRITE, { CLAUDE_PROD_HOSTS_FILE: join(dir, 'no-such-file') }).decision, 'allow');
});

test('a FIFO at the host list path: the hook still answers, and every ssh, psql and mysql host asks', { skip: noFifo }, () => {
  const fifo = join(makeTempDir('prod-hosts-fifo-'), 'prod-hosts');
  makeFifo(fifo);
  const env = { CLAUDE_PROD_HOSTS_FILE: fifo };
  const push = hookAnswer(FORCE_PUSH, env);
  assert.deepEqual(answered(push), [0, null, 'ask'], 'the hook must answer, not wait for a writer on the FIFO');
  assert.match(push.reason, /force push/);
  for (const command of [OTHER_WRITE, 'psql -h build-box -c "DROP TABLE t"', 'mysql -h build-box -e "DROP TABLE t"']) {
    const answer = hookAnswer(command, env);
    assert.deepEqual(answered(answer), [0, null, 'ask'], command);
    assert.match(answer.reason, /build-box, a production host/, command);
  }
  assert.equal(hookAnswer('ssh deploy@build-box uptime', env).decision, 'allow', 'a read-only remote command is still not a write');
  assert.equal(hookAnswer('ls', env).decision, 'allow');
});

test('a link at the host list path is not followed, whatever it points to: every host asks', { skip: noFifo }, () => {
  const { dir, list } = hostList();
  const toList = join(dir, 'link-to-list');
  const toDevice = join(dir, 'link-to-device');
  symlinkSync(list, toList);
  symlinkSync('/dev/zero', toDevice);
  for (const link of [toList, toDevice]) {
    assert.deepEqual(readProdHosts(link), EVERY_HOST, link);
    const answer = hookAnswer(OTHER_WRITE, { CLAUDE_PROD_HOSTS_FILE: link });
    assert.deepEqual(answered(answer), [0, null, 'ask'], link);
    assert.match(answer.reason, /build-box, a production host/, link);
  }
  assert.deepEqual(readProdHosts(dir), EVERY_HOST, 'a folder is not a list either');
});

test('the host list is read up to its cap: at the cap it is the list, one byte over every host asks', () => {
  const file = join(makeTempDir('prod-hosts-cap-'), 'prod-hosts');
  const head = 'db-box\n#';
  writeFileSync(file, head + 'x'.repeat(MAX_PROD_HOSTS_BYTES - head.length));
  assert.equal(statSync(file).size, MAX_PROD_HOSTS_BYTES);
  assert.deepEqual(readProdHosts(file), ['db-box']);
  writeFileSync(file, 'x', { flag: 'a' });
  assert.deepEqual(readProdHosts(file), EVERY_HOST);
});

test('readPlainFile and appendPlainFile refuse everything but a regular file within the cap', { skip: noFifo }, () => {
  const dir = makeTempDir('plain-file-');
  const file = join(dir, 'file');
  assert.equal(appendPlainFile(file, 'one\n'), true);
  assert.equal(readPlainFile(file, 4), 'one\n');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.throws(() => readPlainFile(file, 3), { code: NOT_PLAIN_FILE });
  assert.equal(appendPlainFile(file, 'two\n', { maxBytes: 7 }), false);
  assert.throws(() => readPlainFile(dir, 1024), { code: NOT_PLAIN_FILE });
  assert.throws(() => readPlainFile(join(dir, 'missing'), 1024), { code: 'ENOENT' });
  const link = join(dir, 'link');
  symlinkSync(file, link);
  assert.throws(() => readPlainFile(link, 1024), (error) => error.code !== NOT_PLAIN_FILE && error.code !== 'ENOENT');
  assert.throws(() => appendPlainFile(link, 'x'));
  assert.equal(readPlainFile(file, 1024), 'one\n');
});
