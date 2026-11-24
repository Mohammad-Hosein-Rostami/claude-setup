// disk-clean and a reused pid (P16, lib/live-sessions.mjs): a session record whose pid is alive but whose procStart names another
// start time than ps does belongs to a finished session, so its idle scratchpad folder goes exactly like one of a dead pid; a record
// whose procStart matches keeps its folder. The live pid is this test process. Fake roots only (tests/disk-clean-helpers.mjs); the
// ps cases skip on Windows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runClean } from '../home/tools/disk-free/disk-clean.mjs';
import { NEWEST, OLD, OTHER, sessionFolder, transcript, world } from './disk-clean-helpers.mjs';

const withPs = { skip: process.platform === 'win32' && 'no ps on Windows' };
const DEAD = '77777777-0000-4000-8000-000000000008';
const IDLE_DAYS = 10;
const HOUR_MS = 60 * 60 * 1000;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The start of this process as ps tells it in UTC with LC_ALL=C (what Claude Code writes as procStart), trimmed. */
function ownStart() {
  const ps = ['/bin/ps', '/usr/bin/ps'].find((path) => existsSync(path));
  return execFileSync(ps, ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', env: { TZ: 'UTC', LC_ALL: 'C' } }).trim();
}

/** Epoch ms as an lstart text in UTC, the day space-padded like ps. */
function lstartOf(ms) {
  const d = new Date(ms);
  const two = (n) => String(n).padStart(2, '0');
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

/** A ~/.claude/sessions/<sessionId>.json record with a procStart (the helpers' sessionFile writes none). */
const sessionRecord = (w, pid, sessionId, procStart) => writeFileSync(join(w.sessions, `${sessionId}.json`), JSON.stringify({ pid, sessionId, procStart }));

test('a live pid whose procStart differs from the process start loses its idle folder like a dead pid; a matching procStart keeps it', withPs, async () => {
  const w = world();
  const start = ownStart();
  const deadPid = spawnSync(process.execPath, ['-e', '0']).pid; // exited: the pid is free
  for (const id of [OLD, OTHER, DEAD]) transcript(w, '-proj', id, IDLE_DAYS);
  transcript(w, '-proj', NEWEST, 0);
  const same = sessionFolder(w, OLD, IDLE_DAYS);
  const reused = sessionFolder(w, OTHER, IDLE_DAYS);
  const dead = sessionFolder(w, DEAD, IDLE_DAYS);
  sessionRecord(w, process.pid, OLD, start);
  sessionRecord(w, process.pid, OTHER, lstartOf(Date.parse(`${start} UTC`) - HOUR_MS)); // the pid of a session that ended an hour ago
  sessionRecord(w, deadPid, DEAD, start);
  await runClean(w.options);
  assert.deepEqual({ same: existsSync(same), reused: existsSync(reused), dead: existsSync(dead) }, { same: true, reused: false, dead: false });
});
