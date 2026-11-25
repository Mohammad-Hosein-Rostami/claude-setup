// Tests for the hook temp root of home/hooks/lib/edit-log.mjs (tempRoot, checkedTempRoot) and its user lib/team-switch.mjs (noticeOnce keeps its
// per-session markers under the checked root). The root is per user and checked before every use: a real folder of this uid with no group or
// other bits; one with read bits only is tightened to 0700; anything else is refused, nothing is kept there and one stderr line says so per
// process. Each test points TMPDIR at a fresh folder of its own and puts it back after; the stderr lines are caught at the process's write.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkedTempRoot, tempRoot } from '../home/hooks/lib/edit-log.mjs';
import { noticeOnce } from '../home/hooks/lib/team-switch.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { cleanEnv } from './clean-env.mjs';

const POSIX_ONLY = process.platform === 'win32' ? 'owner and mode bits are POSIX only (Windows: phase 7)' : false;
const EDIT_LOG_MODULE = pathToFileURL(fileURLToPath(new URL('../home/hooks/lib/edit-log.mjs', import.meta.url))).href;
const KILL_AFTER_MS = 30000; // only so an open that waits ends the run; the assertion reads the answer, never the time
const NAME = 'claude-post-edit';
const ENV_KEYS = ['TMPDIR', 'TEMP', 'TMP'];
const NOTICE_SESSION = 's1';
const NOTICE_KEY = 'CLAUDE_POST_EDIT_SKIP';
const REFUSAL_LINE = /^edit-log: hook temp folder refused, (.+?): nothing is kept there; remove it if it is yours: (.+)\n$/;

/** Runs `body(tmp)` with TMPDIR at a fresh folder; returns the refusal reasons this process wrote to stderr (other output passes through). */
function inTemp(body, prepare = () => {}) {
  const tmp = makeTempDir('edit-log-root-');
  const saved = ENV_KEYS.map((key) => process.env[key]);
  const realWrite = process.stderr.write;
  const reasons = [];
  prepare(tmp);
  Object.assign(process.env, { TMPDIR: tmp, TEMP: tmp, TMP: tmp });
  process.stderr.write = function write(chunk, ...rest) {
    const refusal = REFUSAL_LINE.exec(String(chunk));
    return refusal ? reasons.push(refusal[1]) : realWrite.call(this, chunk, ...rest);
  };
  try {
    body(tmp);
  } finally {
    process.stderr.write = realWrite;
    ENV_KEYS.forEach((key, i) => (saved[i] === undefined ? delete process.env[key] : (process.env[key] = saved[i])));
  }
  return reasons;
}

const mode = (path) => statSync(path).mode & 0o7777;

/** Every user of the root gives "nothing here" for a refused root: no marker is kept, so the notice is shown again each time. */
function assertRefused() {
  assert.equal(checkedTempRoot(), null);
  assert.equal(noticeOnce(NOTICE_SESSION, NOTICE_KEY), true);
  assert.equal(noticeOnce(NOTICE_SESSION, NOTICE_KEY), true, 'no marker was kept, so the second call shows it again');
}
const CHECK_SCRIPT = `import { checkedTempRoot } from ${JSON.stringify(EDIT_LOG_MODULE)}; console.log(JSON.stringify(checkedTempRoot()));`;
/** The root check in a second process (a hook is its own process), with TMPDIR as set now: its stdout answer and its refusal reasons. */
function checkedRootInChildProcess(tmp = process.env.TMPDIR) {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', CHECK_SCRIPT], { encoding: 'utf8', timeout: KILL_AFTER_MS, env: cleanEnv({ TMPDIR: tmp }) });
  assert.deepEqual([run.status, run.signal, run.stdout.trim()], [0, null, 'null'], run.stderr);
  return run.stderr.split('\n').filter(Boolean).map((line) => REFUSAL_LINE.exec(`${line}\n`)?.[1]);
}
const NOT_FOLDER = ['not a folder'];

test('(a) a private temp folder: the root keeps its old name and is 0700 after the first use, and a notice marker is kept in it', { skip: POSIX_ONLY }, () => {
  const reasons = inTemp((tmp) => {
    assert.equal(tempRoot(), join(tmp, NAME));
    assert.equal(checkedTempRoot(), join(tmp, NAME));
    assert.equal(mode(join(tmp, NAME)), 0o700);
    assert.equal(noticeOnce(NOTICE_SESSION, NOTICE_KEY), true, 'first call shows the notice');
    assert.equal(noticeOnce(NOTICE_SESSION, NOTICE_KEY), false, 'the marker under the root says it was shown');
    assert.deepEqual(readdirSync(join(tmp, NAME, 'team-switch')), [`${NOTICE_SESSION}--${NOTICE_KEY}`]);
  });
  assert.deepEqual(reasons, []);
});

test('(b) a shared temp folder (mode 1777): the root is named for the uid', { skip: POSIX_ONLY }, () => {
  inTemp((tmp) => {
    const root = join(tmp, `${NAME}-${process.getuid()}`);
    assert.equal(tempRoot(), root);
    assert.equal(checkedTempRoot(), root);
    assert.equal(mode(root), 0o700);
  }, (tmp) => chmodSync(tmp, 0o1777));
});

test('(c) a link at the root is refused: nothing is written in or through it, one line per process', { skip: POSIX_ONLY }, () => {
  const target = makeTempDir('edit-log-root-target-');
  chmodSync(target, 0o700);
  let childReasons;
  const reasons = inTemp(() => {
    assertRefused();
    childReasons = checkedRootInChildProcess();
  }, (tmp) => symlinkSync(target, join(tmp, NAME)));
  assert.deepEqual([readdirSync(target), reasons, childReasons], [[], ['a link'], ['a link']], 'one line from this process, one from the second process');
});

test('(d) a root owned by another uid is refused', { skip: POSIX_ONLY }, () => {
  const realGetuid = process.getuid;
  process.getuid = () => realGetuid() + 1;
  let reasons;
  try {
    reasons = inTemp((tmp) => {
      assert.equal(tempRoot(), join(tmp, `${NAME}-${realGetuid() + 1}`), 'a temp folder of another uid is shared');
      assertRefused();
    });
  } finally {
    process.getuid = realGetuid;
  }
  assert.deepEqual(reasons, ['owned by another user']);
});

test('(e) a root others may write (0775, 0777) is refused and left as it is', { skip: POSIX_ONLY }, () => {
  for (const loose of [0o775, 0o777]) {
    let root;
    const reasons = inTemp(assertRefused, (tmp) => {
      root = join(tmp, NAME);
      mkdirSync(root);
      chmodSync(root, loose);
    });
    assert.deepEqual([reasons, mode(root), readdirSync(root)], [['writable by other users'], loose, []], loose.toString(8));
  }
});

test('(f) a 0755 root of this user is tightened to 0700, then used', { skip: POSIX_ONLY }, () => {
  let root;
  const reasons = inTemp(() => {
    assert.equal(checkedTempRoot(), root);
    assert.equal(mode(root), 0o700);
    assert.equal(noticeOnce(NOTICE_SESSION, NOTICE_KEY), true);
    assert.equal(noticeOnce(NOTICE_SESSION, NOTICE_KEY), false, 'the tightened root keeps the marker');
  }, (tmp) => {
    root = join(tmp, NAME);
    mkdirSync(root);
    chmodSync(root, 0o755);
  });
  assert.deepEqual(reasons, []);
});

test('(g) a regular file at the root path is refused', { skip: POSIX_ONLY }, () => {
  const reasons = inTemp(assertRefused, (tmp) => writeFileSync(join(tmp, NAME), 'not a folder'));
  assert.deepEqual(reasons, NOT_FOLDER);
});

test('(g) a FIFO at the root path is refused without waiting', { skip: POSIX_ONLY }, () => {
  const tmp = makeTempDir('edit-log-root-fifo-');
  execFileSync('mkfifo', [join(tmp, NAME)]);
  assert.deepEqual(checkedRootInChildProcess(tmp), NOT_FOLDER);
});

test('(h) a root refused many times in one process writes one line', { skip: POSIX_ONLY }, () => {
  const reasons = inTemp(() => {
    assertRefused();
    assertRefused();
  }, (tmp) => writeFileSync(join(tmp, NAME), 'x'));
  assert.deepEqual(reasons, NOT_FOLDER);
});
