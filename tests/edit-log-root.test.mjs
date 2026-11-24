// Tests for the hook temp root of home/hooks/lib/edit-log.mjs (tempRoot, checkedTempRoot) and every user of it: the agent call
// counters (callCounterPath, lib/writer-agents.mjs; agent-budget.mjs appends to them). The root is per user and checked before every use: a real folder of this uid with no group or other bits; one with
// read bits only is tightened to 0700; anything else is refused, nothing is kept there and one guard-log line says so per process.
// Each test points TMPDIR at a fresh folder of its own and the guard log at a temp file, and puts both back after.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkedTempRoot, tempRoot } from '../home/hooks/lib/edit-log.mjs';
import { callCounterPath } from '../home/hooks/lib/writer-agents.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { cleanEnv } from './clean-env.mjs';

const POSIX_ONLY = process.platform === 'win32' ? 'owner and mode bits are POSIX only (Windows: phase 7)' : false;
const EDIT_LOG_MODULE = pathToFileURL(fileURLToPath(new URL('../home/hooks/lib/edit-log.mjs', import.meta.url))).href;
const KILL_AFTER_MS = 30000; // only so an open that waits ends the run; the assertion reads the answer, never the time
const NAME = 'claude-post-edit';
const ENV_KEYS = ['TMPDIR', 'TEMP', 'TMP', 'CLAUDE_GUARD_LOG'];

/** Runs `body(tmp)` with TMPDIR at a fresh folder and the guard log in another; returns the guard-log outcomes it wrote. */
function inTemp(body, prepare = () => {}) {
  const tmp = makeTempDir('edit-log-root-');
  const guardLog = join(makeTempDir('edit-log-root-log-'), 'guard.jsonl');
  const saved = ENV_KEYS.map((key) => process.env[key]);
  prepare(tmp);
  Object.assign(process.env, { TMPDIR: tmp, TEMP: tmp, TMP: tmp, CLAUDE_GUARD_LOG: guardLog });
  try {
    body(tmp);
  } finally {
    ENV_KEYS.forEach((key, i) => (saved[i] === undefined ? delete process.env[key] : (process.env[key] = saved[i])));
  }
  return existsSync(guardLog) ? readFileSync(guardLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
}

const mode = (path) => statSync(path).mode & 0o7777;

/** Every user of the root gives "nothing here" for a refused root. */
function assertRefused() {
  assert.equal(checkedTempRoot(), null);
  assert.equal(callCounterPath('s1', 'a1'), null);
}
/** The root check in a second process (a hook is its own process), with TMPDIR as set now: its answer. */
function checkedRootInChildProcess() {
  const script = `import { checkedTempRoot } from ${JSON.stringify(EDIT_LOG_MODULE)}; console.log(JSON.stringify(checkedTempRoot()));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: KILL_AFTER_MS, env: cleanEnv({ CLAUDE_GUARD_LOG: process.env.CLAUDE_GUARD_LOG }) }); // inTemp's own log
  assert.deepEqual([run.status, run.signal, run.stdout.trim()], [0, null, 'null'], run.stderr);
}
const refusedLines = (lines) => lines.map((line) => [line.hook, line.tool, line.decision, line.outcome]);
const ONE_REFUSAL = [['edit-log', 'temp-root', 'skip', 'temp-root-refused']];

test('(a) a private temp folder: the root keeps its old name and is 0700 after the first use', { skip: POSIX_ONLY }, () => {
  const lines = inTemp((tmp) => {
    assert.equal(tempRoot(), join(tmp, NAME));
    assert.equal(checkedTempRoot(), join(tmp, NAME));
    assert.equal(mode(join(tmp, NAME)), 0o700);
    assert.equal(callCounterPath('s1', 'a1'), join(tmp, NAME, 'budget', 's1--a1'));
  });
  assert.deepEqual(lines, []);
});

test('(b) a shared temp folder (mode 1777): the root is named for the uid', { skip: POSIX_ONLY }, () => {
  inTemp((tmp) => {
    const root = join(tmp, `${NAME}-${process.getuid()}`);
    assert.equal(tempRoot(), root);
    assert.equal(checkedTempRoot(), root);
    assert.equal(mode(root), 0o700);
  }, (tmp) => chmodSync(tmp, 0o1777));
});

test('(c) a link at the root is refused: nothing is written in or through it, one line', { skip: POSIX_ONLY }, () => {
  const target = makeTempDir('edit-log-root-target-');
  chmodSync(target, 0o700);
  const lines = inTemp(() => {
    assertRefused();
    checkedRootInChildProcess();
  }, (tmp) => symlinkSync(target, join(tmp, NAME)));
  assert.deepEqual([readdirSync(target), refusedLines(lines)], [[], [...ONE_REFUSAL, ...ONE_REFUSAL]], 'one line from this process, one from the second process');
  assert.match(lines[0].reason, /^hook temp folder refused, a link: no edit log, counter or Bash-write record is kept there; remove it if it is yours: \//);
});

test('(d) a root owned by another uid is refused', { skip: POSIX_ONLY }, () => {
  const realGetuid = process.getuid;
  process.getuid = () => realGetuid() + 1;
  let lines;
  try {
    lines = inTemp((tmp) => {
      assert.equal(tempRoot(), join(tmp, `${NAME}-${realGetuid() + 1}`), 'a temp folder of another uid is shared');
      assertRefused();
    });
  } finally {
    process.getuid = realGetuid;
  }
  assert.deepEqual(refusedLines(lines), ONE_REFUSAL);
  assert.match(lines[0].reason, /owned by another user/);
});

test('(e) a root others may write (0775, 0777) is refused and left as it is', { skip: POSIX_ONLY }, () => {
  for (const loose of [0o775, 0o777]) {
    let root;
    const lines = inTemp(assertRefused, (tmp) => {
      root = join(tmp, NAME);
      mkdirSync(root);
      chmodSync(root, loose);
    });
    assert.deepEqual([refusedLines(lines), mode(root), readdirSync(root)], [ONE_REFUSAL, loose, []], loose.toString(8));
    assert.match(lines[0].reason, /writable by other users/);
  }
});

test('(f) a 0755 root of this user is tightened to 0700, then used', { skip: POSIX_ONLY }, () => {
  let root;
  const lines = inTemp((tmp) => {
    assert.equal(checkedTempRoot(), root);
    assert.equal(mode(root), 0o700);
    assert.equal(callCounterPath('s1', 'a1'), join(root, 'budget', 's1--a1'));
  }, (tmp) => {
    root = join(tmp, NAME);
    mkdirSync(root);
    chmodSync(root, 0o755);
  });
  assert.deepEqual(lines, []);
});

test('(g) a regular file at the root path is refused', { skip: POSIX_ONLY }, () => {
  const lines = inTemp(assertRefused, (tmp) => writeFileSync(join(tmp, NAME), 'not a folder'));
  assert.deepEqual(refusedLines(lines), ONE_REFUSAL);
  assert.match(lines[0].reason, /refused, not a folder:/);
});

test('(g) a FIFO at the root path is refused without waiting', { skip: POSIX_ONLY }, () => {
  const tmp = makeTempDir('edit-log-root-fifo-');
  execFileSync('mkfifo', [join(tmp, NAME)]);
  const guardLog = join(makeTempDir('edit-log-root-log-'), 'guard.jsonl');
  const script = `import { checkedTempRoot } from ${JSON.stringify(EDIT_LOG_MODULE)}; console.log(JSON.stringify(checkedTempRoot()));`;
  const env = cleanEnv({ TMPDIR: tmp, CLAUDE_GUARD_LOG: guardLog });
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: KILL_AFTER_MS, env });
  assert.deepEqual([run.status, run.signal, run.stdout.trim()], [0, null, 'null'], run.stderr);
  assert.equal(readFileSync(guardLog, 'utf8').trim().split('\n').length, 1);
});

test('(h) a root refused many times in one process writes one line', { skip: POSIX_ONLY }, () => {
  const lines = inTemp(() => {
    assertRefused();
    assertRefused();
  }, (tmp) => writeFileSync(join(tmp, NAME), 'x'));
  assert.deepEqual(refusedLines(lines), ONE_REFUSAL);
});
