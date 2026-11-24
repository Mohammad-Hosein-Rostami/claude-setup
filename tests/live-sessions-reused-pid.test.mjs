// Tests for liveSessionIds in home/tools/disk-free/lib/live-sessions.mjs on a fake ~/.claude/sessions folder (P16: a pid alone is no
// identity). A record whose pid is alive but whose procStart names another start time than ps does is a reused pid and does not count;
// a start within 2 s counts; a record without a comparable procStart keeps the pid-only answer; a dead pid and a bad file never count.
// The live process is a child this test starts and kills. The ps cases skip on Windows only (no ps there: the pid-only answer holds).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { liveSessionIds } from '../home/tools/disk-free/lib/live-sessions.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const withPs = { skip: process.platform === 'win32' && 'no ps on Windows' };
const HOUR_MS = 60 * 60 * 1000;
const WITHIN_TOLERANCE_MS = 1000; // the code allows 2 s (Linux lstart may differ by a second between two reads)
const PAST_TOLERANCE_MS = 5000;
const SESSION_FILE_MAX_BYTES = 1 << 16; // the code reads no record bigger than this
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A child that stays alive for the test (killed after it); resolves to its pid once it runs. */
async function liveChild(t) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  t.after(() => child.kill());
  await once(child, 'spawn');
  return child.pid;
}

/** The start of `pid` as ps tells it in UTC with LC_ALL=C (what Claude Code writes as procStart), trimmed. */
function psStart(pid) {
  const ps = ['/bin/ps', '/usr/bin/ps'].find((path) => existsSync(path));
  return execFileSync(ps, ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { TZ: 'UTC', LC_ALL: 'C' } }).trim();
}

/** Epoch ms as an lstart text in UTC (`Sun Nov  1 08:05:09 2026`: the day space-padded, like ps). */
function lstartOf(ms) {
  const d = new Date(ms);
  const two = (n) => String(n).padStart(2, '0');
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

/** A sessions folder with one `<name>.json` per entry of `records` (name -> record object, or raw text). */
function sessionsFolder(records) {
  const folder = makeTempDir('live-sessions-');
  for (const [name, record] of Object.entries(records)) writeFileSync(join(folder, `${name}.json`), typeof record === 'string' ? record : JSON.stringify(record));
  return folder;
}

const sorted = (ids) => [...ids].sort();

test('a live pid whose procStart is the process start as ps tells it counts; one an hour off is a reused pid and does not', withPs, async (t) => {
  const pid = await liveChild(t);
  const start = psStart(pid);
  const startMs = Date.parse(`${start} UTC`); // a fixture value only; the code under test parses field by field
  const folder = sessionsFolder({
    same: { pid, sessionId: 'same', procStart: start },
    reused: { pid, sessionId: 'reused', procStart: lstartOf(startMs - HOUR_MS) },
    later: { pid, sessionId: 'later', procStart: lstartOf(startMs + HOUR_MS) },
  });
  assert.deepEqual(sorted(await liveSessionIds(folder)), ['same']);
});

test('a procStart within 2 s of the ps start counts; 5 s off does not', withPs, async (t) => {
  const pid = await liveChild(t);
  const startMs = Date.parse(`${psStart(pid)} UTC`);
  const folder = sessionsFolder({
    before: { pid, sessionId: 'before', procStart: lstartOf(startMs - WITHIN_TOLERANCE_MS) },
    after: { pid, sessionId: 'after', procStart: lstartOf(startMs + WITHIN_TOLERANCE_MS) },
    farAfter: { pid, sessionId: 'farAfter', procStart: lstartOf(startMs + PAST_TOLERANCE_MS) },
  });
  assert.deepEqual(sorted(await liveSessionIds(folder)), ['after', 'before']);
});

test('a live pid with no procStart, or one of another shape (Linux ticks, empty, a number, ISO), keeps the pid-only answer: it counts', async (t) => {
  const pid = await liveChild(t);
  const folder = sessionsFolder({
    missing: { pid, sessionId: 'missing' },
    ticks: { pid, sessionId: 'ticks', procStart: '12345678' },
    empty: { pid, sessionId: 'empty', procStart: '' },
    number: { pid, sessionId: 'number', procStart: 12345678 },
    iso: { pid, sessionId: 'iso', procStart: '2001-01-01T00:00:00Z' },
  });
  assert.deepEqual(sorted(await liveSessionIds(folder)), ['empty', 'iso', 'missing', 'number', 'ticks']);
});

test('a dead pid never counts, with or without a procStart', async () => {
  const dead = spawnSync(process.execPath, ['-e', '0']).pid; // exited: the pid is free
  const folder = sessionsFolder({ bare: { pid: dead, sessionId: 'bare' }, stamped: { pid: dead, sessionId: 'stamped', procStart: lstartOf(Date.now()) } });
  assert.deepEqual(sorted(await liveSessionIds(folder)), []);
});

test('bad records never count and never throw: garbage JSON, a string, zero or negative pid, a huge file, a link; a good record still counts', async (t) => {
  const pid = await liveChild(t);
  const folder = sessionsFolder({
    good: { pid, sessionId: 'good' },
    garbage: '{"pid": ',
    stringPid: { pid: String(pid), sessionId: 'stringPid' },
    zeroPid: { pid: 0, sessionId: 'zeroPid' },
    negativePid: { pid: -pid, sessionId: 'negativePid' },
    noSession: { pid },
    huge: { pid, sessionId: 'huge', pad: 'x'.repeat(SESSION_FILE_MAX_BYTES) },
  });
  if (process.platform !== 'win32') { // a file link needs admin rights on Windows
    const target = join(makeTempDir('live-sessions-target-'), 'record');
    writeFileSync(target, JSON.stringify({ pid, sessionId: 'linked' }));
    symlinkSync(target, join(folder, 'linked.json'));
  }
  assert.deepEqual(sorted(await liveSessionIds(folder)), ['good']);
  assert.deepEqual(sorted(await liveSessionIds(undefined)), []);
});
