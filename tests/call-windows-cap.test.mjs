// Tests of the call-window log cap (home/hooks/lib/call-window-cap.mjs, used by lib/call-windows.mjs and lib/change-owner.mjs):
// 32 MiB for the writer, the reader and the claim reader (P6), a log of real lines past the old 8 MiB cap still usable, an 8 MiB log
// written before the change still read (F2), and a full log reported once per session in guard.jsonl, also by two processes (F1).
// Every test runs under a temp HOME with its own guard.jsonl (P8); no line asserts elapsed time (the read time is measured in phase 8).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_EDGE_LINE_BYTES, MAX_USABLE_LOG_BYTES, MAX_WINDOW_LOG_BYTES, readCallWindows, recordCallEdge } from '../home/hooks/lib/call-windows.mjs';
import { LOG_FULL_OUTCOME } from '../home/hooks/lib/call-window-cap.mjs';
import { claimed } from '../home/hooks/lib/change-owner.mjs';
import { CLEAN_ENV } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { edges, LOG_DIR, logPath, OTHER, SESSION, sizeOf, writeLog } from './call-windows-helpers.mjs';

const MIB = 1024 * 1024;
const OLD_CAP_BYTES = 8 * MIB;
const OLD_FROZEN_LOG_BYTES = 8_388_589; // the size the 8 MiB log froze at in the real run (D7)
const NO_DEADLINE_MS = 10 * 60_000; // far away: these tests check sizes, never the read time
const SECOND = 'sess-2';

const homeEnv = () => {
  const home = makeTempDir('call-window-cap-home-');
  const guardLog = join(home, 'guard-log', 'guard.jsonl');
  return { home, guardLog, env: { ...CLEAN_ENV, HOME: home, USERPROFILE: home, CLAUDE_GUARD_LOG: guardLog } };
};
const windowsOf = (env, session = SESSION) => readCallWindows(env, session, Date.now() + NO_DEADLINE_MS);
const pre = (session, id) => ({ hook_event_name: 'PreToolUse', session_id: session, tool_name: 'Bash', tool_use_id: id, tool_input: {}, cwd: '/' });
const fullLines = (guardLog) => (existsSync(guardLog) ? readFileSync(guardLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [])
  .filter((line) => line.outcome === LOG_FULL_OUTCOME);

/** Real open and close lines (the writer's shape, each pair one closed window) until the log holds about `bytes`. */
function realLines(bytes, firstAt = 1000) {
  const lines = [];
  let size = 0;
  for (let i = 0, at = firstAt; size < bytes; i += 1, at += 10) {
    const pair = [edges.open(`toolu_${i}`, at, [i, null, 3000], { lim: 120000 }), edges.close(`toolu_${i}`, at + 5, [i + 1, null, 3000])];
    size += pair.reduce((sum, line) => sum + Buffer.byteLength(`${JSON.stringify(line)}\n`), 0);
    lines.push(...pair);
  }
  return lines;
}

/** A log of one real line padded with blanks (the parser skips them) to exactly `bytes`. */
const writePadded = (home, session, bytes) => writeFileSync(logPath(home, session), `${JSON.stringify(edges.open('a', 1, [0]))}\n`.padEnd(bytes, ' '));

test('one cap of 32 MiB: the reader refuses a log past it less one line, the writer a line that would pass it (P6)', () => {
  assert.equal(MAX_WINDOW_LOG_BYTES, 32 * MIB);
  assert.equal(MAX_USABLE_LOG_BYTES, MAX_WINDOW_LOG_BYTES - MAX_EDGE_LINE_BYTES);
  const { home, env } = homeEnv();
  writeLog(home, SESSION, []);
  writePadded(home, SESSION, MAX_USABLE_LOG_BYTES);
  assert.equal(windowsOf(env).usable, true, 'at the usable size');
  writePadded(home, SESSION, MAX_USABLE_LOG_BYTES + 1);
  assert.equal(windowsOf(env).usable, false, 'one byte more: a line may have been refused');
  writePadded(home, SESSION, MAX_WINDOW_LOG_BYTES - 10);
  assert.equal(recordCallEdge(pre(SESSION, 'over'), env), false, 'the line would pass the cap');
  assert.equal(sizeOf(logPath(home)), MAX_WINDOW_LOG_BYTES - 10);
});

test('a 30 MiB log of real lines (over the old 8 MiB cap) is usable, keeps every line, and the writer still appends', () => {
  const { home, env } = homeEnv();
  const lines = realLines(30 * MIB);
  writeLog(home, SESSION, lines);
  assert.ok(sizeOf(logPath(home)) >= 30 * MIB && sizeOf(logPath(home)) > OLD_CAP_BYTES);
  const log = windowsOf(env);
  assert.equal(log.usable, true);
  assert.equal(log.lines.length, lines.length);
  assert.equal(log.windows.length, lines.length / 2);
  assert.equal(recordCallEdge(pre(SESSION, 'next'), env), true);
  assert.equal(windowsOf(env).lines.at(-1).id, 'next');
});

test('an 8 MiB log written before the change, frozen at the old cap, reads again (F2)', () => {
  const { home, env } = homeEnv();
  writeLog(home, SESSION, [edges.watch(0, '/r', 0, 'a', 1), ...realLines(OLD_FROZEN_LOG_BYTES - 200)]);
  assert.ok(sizeOf(logPath(home)) > OLD_CAP_BYTES - MAX_EDGE_LINE_BYTES, 'unusable under the old cap');
  assert.equal(windowsOf(env).usable, true);
  assert.equal(recordCallEdge(pre(SESSION, 'after'), env), true, 'and the writer appends again');
});

test('a full log is reported once per session in guard.jsonl, never on every call; a log under the cap is not reported (F1)', () => {
  const { home, guardLog, env } = homeEnv();
  writeLog(home, SESSION, []);
  writePadded(home, SESSION, MAX_USABLE_LOG_BYTES - MAX_EDGE_LINE_BYTES);
  recordCallEdge(pre(SESSION, 'under'), env);
  assert.ok(sizeOf(logPath(home)) <= MAX_USABLE_LOG_BYTES);
  assert.deepEqual(fullLines(guardLog), [], 'still usable after the append: nothing to report');
  writePadded(home, SESSION, MAX_USABLE_LOG_BYTES + 1);
  writePadded(home, SECOND, MAX_USABLE_LOG_BYTES + 1);
  for (let i = 0; i < 5; i += 1) recordCallEdge(pre(SESSION, `call-${i}`), env);
  recordCallEdge(pre(SECOND, 'one'), env);
  recordCallEdge(pre(SECOND, 'two'), env);
  const reported = fullLines(guardLog);
  assert.deepEqual(reported.map((line) => line.session).sort(), [SESSION, SECOND]);
  assert.deepEqual([reported[0].hook, reported[0].tool, reported[0].decision], ['commit-gate', 'call-windows', 'skip']);
  assert.match(reported[0].reason, /^call-window log full \(\d+ bytes, cap 32 MiB\): every change of this session now counts as own$/);
});

test('two processes calling on one full log at once write one report between them (F1, P7)', async () => {
  const { home, guardLog, env } = homeEnv();
  writeLog(home, SESSION, []);
  writePadded(home, SESSION, MAX_USABLE_LOG_BYTES + 1);
  const script = `import { recordCallEdge } from ${JSON.stringify(new URL('../home/hooks/lib/call-windows.mjs', import.meta.url).href)};
    for (let i = 0; i < 50; i += 1) recordCallEdge({ hook_event_name: 'PreToolUse', session_id: '${SESSION}', tool_name: 'Bash', tool_use_id: process.argv[1] + i, tool_input: {}, cwd: '/' }, process.env);`;
  const runs = ['p', 'q'].map((tag) => new Promise((done) => spawn(process.execPath, ['--input-type=module', '-e', script, tag], { env, stdio: 'ignore' }).on('exit', done)));
  assert.deepEqual(await Promise.all(runs), [0, 0]);
  assert.equal(fullLines(guardLog).length, 1);
});

test('an unusable report store (a link at the marker) writes no report at all rather than one per call', () => {
  const { home, guardLog, env } = homeEnv();
  writeLog(home, SESSION, []);
  writePadded(home, SESSION, MAX_USABLE_LOG_BYTES + 1);
  writeFileSync(join(home, 'elsewhere.json'), '');
  symlinkSync(join(home, 'elsewhere.json'), join(LOG_DIR(home), `${SESSION}--log-full.json`));
  for (let i = 0; i < 3; i += 1) recordCallEdge(pre(SESSION, `call-${i}`), env);
  assert.deepEqual(fullLines(guardLog), []);
});

test('the claim reader reads other logs up to the same 32 MiB: a 20 MiB older log (over the old 16 MiB budget) still claims (P6)', () => {
  const { home, env } = homeEnv();
  writeLog(home, SESSION, [edges.open('own', 10 ** 9, [0]), edges.close('own', 10 ** 9 + 1, [0])]);
  const ctx = { env, session: SESSION, agent: null, log: windowsOf(env), top: '/top', deadlineMs: Date.now() + NO_DEADLINE_MS };
  writeLog(home, OTHER, [edges.watch(0, '/r', 0, 'a', 10), edges.open('o', 100, [5]), edges.close('o', 200, [9]), ...realLines(20 * MIB, 300)]);
  assert.ok(sizeOf(logPath(home, OTHER)) > 16 * MIB);
  assert.equal(claimed({ ...ctx }, { reflog: '/r', offset: 5 }), true);
  writePadded(home, OTHER, MAX_WINDOW_LOG_BYTES + 1);
  assert.equal(claimed({ ...ctx }, { reflog: '/r', offset: 5 }), false, 'past the budget: claims nothing (own)');
});
