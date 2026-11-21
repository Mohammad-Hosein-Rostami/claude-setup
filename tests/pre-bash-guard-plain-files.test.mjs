// Tests that a file planted where the Bash hooks read or write cannot make them wait or write somewhere else (principle P1): the private
// production-host list the guard reads on every call, the edit log (written by post-edit.mjs and bash-writes.mjs, read by the typecheck
// gate) and the before-record of bash-writes.mjs. A FIFO at such a path used to hold the hook until its timeout, and a hook that times
// out answers nothing. All are opened through lib/plain-file.mjs.
// A host list that is there but is not a plain file cannot be trusted to be the list: every ssh, psql and mysql host then asks.
// The hook runs as Claude Code runs it, with a private HOME, TMPDIR and log and no GUI. A hook that hangs is killed by spawnSync and fails
// its test through the missing answer; no test measures time. Command strings are only sent to the hook; nothing is executed.
import { PINNED_HOME } from './pin-home.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MAX_BEFORE_RECORD_BYTES } from '../home/hooks/bash-writes.mjs';
import { MAX_EDIT_LOG_BYTES, readEdits, recordEdit } from '../home/hooks/lib/edit-log.mjs';
import { appendPlainFile, NOT_PLAIN_FILE, readPlainFile } from '../home/hooks/lib/plain-file.mjs';
import { EVERY_HOST, MAX_PROD_HOSTS_BYTES, readProdHosts } from '../home/hooks/lib/remote.mjs';
import { hookEnv } from './hook-env.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const GUARD = fileURLToPath(new URL('../home/hooks/pre-bash-guard.mjs', import.meta.url));
const BASH_WRITES = fileURLToPath(new URL('../home/hooks/bash-writes.mjs', import.meta.url));
const EDIT_LOG_MODULE = pathToFileURL(fileURLToPath(new URL('../home/hooks/lib/edit-log.mjs', import.meta.url))).href;
const PROJECT = resolve('/work/proj');
const SESSION = 'sess-plain';
const KILL_AFTER_MS = 30000; // only so a hook that waits on a FIFO ends the test run; the assertions read the answer, never the time
const noFifo = process.platform === 'win32' ? 'Windows has no FIFO and no O_NOFOLLOW' : false;
const FORCE_PUSH = 'git push --force origin main';
const RESTART = "'systemctl restart api'";
const LISTED_WRITE = `ssh deploy@db-box ${RESTART}`;
const OTHER_WRITE = `ssh deploy@build-box ${RESTART}`;
const CODE_WRITE = 'sed -i s/a/b/ x.ts';

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

/** A private temp dir for the hook, the edit log and before-record paths the hook derives from it for this session, and a guard log. */
function editLogIn(tmp = makeTempDir('edit-log-')) {
  const log = join(tmp, 'claude-post-edit', 'edits', `${SESSION}--main`);
  const record = join(tmp, 'claude-post-edit', 'bash-writes', `${SESSION}--main--t1`);
  for (const path of [log, record]) mkdirSync(dirname(path), { recursive: true });
  const guardLog = join(makeTempDir('edit-log-guard-'), 'guard.jsonl');
  return { env: { TMPDIR: tmp, TEMP: tmp, TMP: tmp, CLAUDE_GUARD_LOG: guardLog }, log, record, guardLog };
}

const outcomesIn = (guardLog) => (existsSync(guardLog) ? readFileSync(guardLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line).outcome) : []);

/**
 * One Bash call of `sed -i` on `<project>/x.ts` sent to bash-writes.mjs: the before-step (unless `before` is false), `change(file)`, the
 * after-step. Each step must answer (exit 0, no signal, nothing printed).
 */
function bashWritesCall(env, change = () => {}, { before = true } = {}) {
  const project = realpathSync(makeTempDir('bash-writes-proj-'));
  const file = join(project, 'x.ts');
  const step = (event) => {
    const input = JSON.stringify({ hook_event_name: event, tool_name: 'Bash', session_id: SESSION, tool_use_id: 't1', cwd: project, tool_input: { command: CODE_WRITE }, tool_response: {} });
    const run = spawnSync(process.execPath, [BASH_WRITES], { input, encoding: 'utf8', timeout: KILL_AFTER_MS, env: hookEnv({ CLAUDE_PROJECT_DIR: project, ...env }) });
    assert.deepEqual([run.status, run.signal, run.stdout], [0, null, ''], `${event}: ${run.stderr}`);
  };
  if (before) step('PreToolUse');
  change(file);
  step('PostToolUse');
  return file;
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

test('the guard writes no edit log; bash-writes.mjs writes it after the command changed the file, when nothing is planted', () => {
  const { env, log } = editLogIn();
  assert.equal(hookAnswer(CODE_WRITE, env).decision, 'allow');
  assert.deepEqual(answered(hookAnswer(`${CODE_WRITE}; ${FORCE_PUSH}`, env)), [0, null, 'ask']);
  assert.equal(existsSync(log), false, 'the guard logs nothing');
  const file = bashWritesCall(env, (path) => writeFileSync(path, 'b'));
  assert.deepEqual(readFileSync(log, 'utf8').split('\n').filter(Boolean), [file]);
});

test('a FIFO at the edit log path: bash-writes.mjs still answers both steps', { skip: noFifo }, () => {
  const { env, log } = editLogIn();
  makeFifo(log);
  bashWritesCall(env, (path) => writeFileSync(path, 'b'));
  assert.equal(statSync(log).isFIFO(), true);
});

test('a link at the edit log path is not followed: the file it points to is never written', { skip: noFifo }, () => {
  const { env, log } = editLogIn();
  const target = join(makeTempDir('edit-log-target-'), 'victim.txt');
  symlinkSync(target, log);
  bashWritesCall(env, (path) => writeFileSync(path, 'b'));
  assert.equal(existsSync(target), false, 'the write went through the link');
  writeFileSync(target, 'keep\n');
  bashWritesCall(env, (path) => writeFileSync(path, 'b'));
  assert.equal(readFileSync(target, 'utf8'), 'keep\n');
});

test('a FIFO, a link or a folder at the before-record path: nothing waits, nothing is followed or logged, and the doubt is reported', { skip: noFifo }, () => {
  const target = join(makeTempDir('record-target-'), 'victim.txt');
  const plants = { fifo: makeFifo, link: (path) => symlinkSync(target, path), folder: (path) => mkdirSync(path) };
  for (const [kind, plant] of Object.entries(plants)) {
    const { env, log, record, guardLog } = editLogIn();
    plant(record);
    bashWritesCall(env, (path) => writeFileSync(path, 'b'));
    assert.deepEqual([existsSync(log), existsSync(target)], [false, false], kind);
    assert.deepEqual(outcomesIn(guardLog), ['bash-writes-error', 'bash-writes-unchecked'], `${kind}: the writer's refusal and the reader's doubt`);
  }
});

test('the before-record has one cap for its writer and its reader: a record at the cap is read, one byte more is refused', () => {
  for (const extra of [0, 1]) {
    const { env, record, guardLog } = editLogIn();
    bashWritesCall(env, (file) => {
      const head = `["${file}","missing`;
      writeFileSync(record, `${head}${'x'.repeat(MAX_BEFORE_RECORD_BYTES - head.length - 3 + extra)}"]\n`);
      assert.equal(statSync(record).size, MAX_BEFORE_RECORD_BYTES + extra);
    }, { before: false });
    assert.deepEqual(outcomesIn(guardLog), extra ? ['bash-writes-unchecked'] : [], `${extra} byte over the cap`);
  }
});

test('the reader of the edit log does not wait on a FIFO or follow a link either: it reads nothing there, and says so in the guard log', { skip: noFifo }, () => {
  const { log } = editLogIn();
  makeFifo(log);
  const guardLog = join(makeTempDir('edit-log-report-'), 'guard.jsonl');
  const reported = () => (existsSync(guardLog) ? readFileSync(guardLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
  const script = `import { readEdits } from ${JSON.stringify(EDIT_LOG_MODULE)}; console.log(JSON.stringify(readEdits(process.argv[1])));`;
  const read = spawnSync(process.execPath, ['--input-type=module', '-e', script, log], { encoding: 'utf8', timeout: KILL_AFTER_MS, env: { ...process.env, HOME: PINNED_HOME, CLAUDE_GUARD_LOG: guardLog } });
  assert.deepEqual([read.status, read.signal, read.stdout.trim()], [0, null, '[]'], read.stderr);
  assert.deepEqual(reported().map((line) => [line.hook, line.outcome]), [['typecheck-gate', 'edit-log-unreadable']], 'one line for the read of the FIFO');
  const { log: linked } = editLogIn();
  const real = join(makeTempDir('edit-log-real-'), 'edits.txt');
  writeFileSync(real, '/work/proj/a.ts\n');
  symlinkSync(real, linked);
  const before = process.env.CLAUDE_GUARD_LOG;
  process.env.CLAUDE_GUARD_LOG = guardLog; // these reads run in this process: their report must go to the temp log
  try {
    assert.deepEqual(readEdits(linked), []);
    assert.deepEqual(readEdits(real), ['/work/proj/a.ts']);
    assert.deepEqual(readEdits(join(dirname(real), 'no-log-here')), []);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_GUARD_LOG;
    else process.env.CLAUDE_GUARD_LOG = before;
  }
  const lines = reported();
  assert.equal(lines.length, 2, 'the link is reported; a plain log and a missing one are not');
  assert.match(lines[1].reason, /^the edit log sess-plain--main is not a plain file within \d+ bytes \(\w+\): its edits are not checked$/);
});

/** Runs `body` with the guard log of this process at a temp file; returns the outcomes it wrote. */
function withGuardLog(body) {
  const guardLog = join(makeTempDir('edit-log-lines-'), 'guard.jsonl');
  const before = process.env.CLAUDE_GUARD_LOG;
  process.env.CLAUDE_GUARD_LOG = guardLog;
  try {
    body();
  } finally {
    if (before === undefined) delete process.env.CLAUDE_GUARD_LOG;
    else process.env.CLAUDE_GUARD_LOG = before;
  }
  return outcomesIn(guardLog);
}

test('the edit log has one cap for its writer and its reader: a line that would pass it is not written and says so, a log at the cap is read', () => {
  const log = join(makeTempDir('edit-log-cap-'), 'edits');
  const line = '/work/proj/last.ts';
  writeFileSync(log, `${'x'.repeat(MAX_EDIT_LOG_BYTES - line.length - 2)}\n`); // room for exactly one more line
  assert.deepEqual(withGuardLog(() => recordEdit(log, line)), [], 'the line that reaches the cap exactly is written, silently');
  assert.equal(statSync(log).size, MAX_EDIT_LOG_BYTES);
  assert.equal(readEdits(log).at(-1), line);
  assert.deepEqual(withGuardLog(() => recordEdit(log, '/work/proj/over.ts')), ['edit-log-full'], 'one more line would pass the cap');
  assert.equal(statSync(log).size, MAX_EDIT_LOG_BYTES);
});

test('a path with a line break is turned away: the log stays as it was, and one line says so', () => {
  const log = join(makeTempDir('edit-log-break-'), 'edits');
  writeFileSync(log, '/work/proj/a.ts\n');
  for (const path of ['/work/proj/src/a\nb.ts', '/work/proj/src/a\rb.ts', '/work/proj/a.ts\n/etc/x.ts']) {
    assert.deepEqual(withGuardLog(() => recordEdit(log, path)), ['edit-log-bad-path'], JSON.stringify(path));
  }
  assert.equal(readFileSync(log, 'utf8'), '/work/proj/a.ts\n');
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
