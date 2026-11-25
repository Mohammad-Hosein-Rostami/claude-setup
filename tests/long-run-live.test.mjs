// Tests of `long-run live` (plan "Acceptance" lines 2-7): one frame per `live --once` (account, limit wait with its time, short
// session id, no token, no control character, group/item labels, finished runs, an unreadable run) and the redraw loop (frames,
// clear and width on a TTY, plain frames off one, Ctrl-C at once).
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { LIVE_REFRESH_MS, liveLoop } from '../home/tools/long-run/lib/live.mjs';
import { writeJournal, writeJson } from '../home/tools/long-run/lib/run-store.mjs';
import { formatWhen } from '../home/tools/long-run/lib/view.mjs';
import { TOKEN_A, cli, createRun, makeSandbox } from './long-run-helpers.mjs';

const SESSION_ID = 'a1b2c3d4-e5f6-4789-8abc-def012345678';
const SHORT_SESSION_ID = 'a1b2c3d4';
const SHORT_TOKEN_SHAPE = 'sk-ant-x1y2';
const BAD_TIME = 'not-a-date';
const NOT_A_STRING_SESSION_ID = 12345;
const WAIT_MINUTES = 30;
const MS_PER_MINUTE = 60 * 1000;
const ESC = '\x1b';
const CLEAR_AND_HOME = `${ESC}[H${ESC}[2J`;
const NARROW_COLUMNS = 30;
const FRAMES_BEFORE_ABORT = 3;
const FRAME_CAP = 10; // a loop that ignores abort() must fail the test, not spin
const FIXED_NOW = new Date('2026-11-25T12:00:00.000Z');
const CTRL_C_BUDGET_MS = 500;
const LONG_RUN_NAME = 'a-rather-long-name-for-a-narrow-view'; // its run id alone is wider than NARROW_COLUMNS
const STEP_ONE = { id: 'one', prompt: 'One.' };

const jobOf = (box, name, steps = [STEP_ONE]) => ({ name, cwd: box.work('repo'), steps });
const live = (box, args = []) => cli(box, ['live', '--once', ...args]);
const linesOf = (result) => result.stdout.trimEnd().split('\n');

/** A journal of a started step, as the driver leaves it (only the fields `live` reads and the loader needs). */
function journalOf(unitId, overrides = {}) {
  return { id: unitId, sessionId: SESSION_ID, account: 'acct-a', folder: null, running: false, pid: null, last: null, totalStarts: 1, attempts: 0,
    waitUntil: null, nextAttemptAt: null, final: null, startsLog: [{ n: 1, at: FIXED_NOW.toISOString(), log: `logs/${unitId}.1.jsonl` }], ...overrides };
}

/** Makes `paths` look held by this test process: a lock, and a driver.json with a fresh beat. */
function holdRun(paths, live) {
  writeFileSync(paths.lock, `${process.pid} ${hostname()} ${Date.now()}\n`);
  writeJson(paths.driver, { pid: process.pid, host: hostname(), status: 'running', beatAt: new Date().toISOString(), live });
}

test('a run in a usage-limit wait shows its id, account, the wait and reset time, and only the first 8 characters of the session id', () => {
  const box = makeSandbox();
  const paths = createRun(box, jobOf(box, 'limit'));
  const until = new Date(Date.now() + WAIT_MINUTES * MS_PER_MINUTE).toISOString();
  writeJournal(paths, 'one', journalOf('one', { running: true, pid: process.pid }));
  holdRun(paths, { one: { state: 'waiting-limit', until, since: new Date().toISOString() } });
  const result = live(box);
  assert.equal(result.status, 0, result.stderr);
  const lines = linesOf(result);
  const runLine = lines.find((line) => line.startsWith(paths.runId));
  assert.ok(runLine, `a line for ${paths.runId} in:\n${result.stdout}`);
  assert.match(runLine, /^\S+ {2}waiting-limit {2}acct acct-a {2}0\/1 done$/);
  const stepLine = lines.find((line) => /^ {2}one\b/.test(line));
  assert.ok(stepLine, `a line for step one in:\n${result.stdout}`);
  assert.match(stepLine, /\bwaiting-limit\b/);
  assert.ok(stepLine.includes(`resets ${formatWhen(until)}`), `"resets ${formatWhen(until)}" in: ${stepLine}`);
  assert.match(stepLine, new RegExp(`session ${SHORT_SESSION_ID}(?: |$)`)); // exactly 8 characters: the next one is a space or the end
  assert.ok(!result.stdout.includes(SESSION_ID), 'the full session id must not be shown');
});

test('a token and token-shaped text in a step reason print as <token>', () => {
  const box = makeSandbox();
  const paths = createRun(box, jobOf(box, 'secret'));
  writeJournal(paths, 'one', journalOf('one', { final: { status: 'failed', reason: `login failed with ${TOKEN_A} and ${SHORT_TOKEN_SHAPE}` } }));
  const result = live(box);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes(TOKEN_A), 'the sandbox token must not be shown');
  assert.ok(!result.stdout.includes('sk-ant-'), 'no sk-ant- text must be shown');
  assert.match(result.stdout, /<token>/);
});

test('a reason with an escape sequence and a newline prints without an ESC character and stays on its step line', () => {
  const box = makeSandbox();
  const paths = createRun(box, jobOf(box, 'hostile'));
  writeJournal(paths, 'one', journalOf('one', { final: { status: 'failed', reason: `before${ESC}[2Jafter\nsecond line` } }));
  const result = live(box);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes(ESC), 'no ESC character in the output');
  const lines = linesOf(result);
  assert.equal(lines.length, 3, `a header, the run line and one step line:\n${result.stdout}`);
  assert.match(lines[2], /^ {2}one .*before.*after.*second line/);
});

test('a parallel item prints as group/item', () => {
  const box = makeSandbox();
  const job = jobOf(box, 'fan', [{ id: 'pages', parallel: [{ id: 'p1', prompt: 'One.', cwd: box.work('p1') }, { id: 'p2', prompt: 'Two.', cwd: box.work('p2') }] }]);
  createRun(box, job);
  const lines = linesOf(live(box));
  assert.ok(lines.some((line) => /^ {2}pages\/p1 /.test(line)), `pages/p1 in:\n${lines.join('\n')}`);
  assert.ok(lines.some((line) => /^ {2}pages\/p2 /.test(line)), `pages/p2 in:\n${lines.join('\n')}`);
});

test('a finished run is absent by default and present with --all', () => {
  const box = makeSandbox();
  const running = createRun(box, jobOf(box, 'going'));
  const finished = createRun(box, jobOf(box, 'finished'));
  writeJson(finished.driver, { pid: null, host: hostname(), status: 'done', beatAt: new Date().toISOString(), live: {} });
  const byDefault = live(box);
  assert.equal(byDefault.status, 0, byDefault.stderr);
  assert.ok(byDefault.stdout.includes(running.runId), 'the running run is listed');
  assert.ok(!byDefault.stdout.includes(finished.runId), 'the finished run is not listed');
  const all = live(box, ['--all']);
  assert.equal(all.status, 0, all.stderr);
  assert.ok(all.stdout.includes(running.runId), 'the running run is listed with --all');
  assert.ok(all.stdout.includes(finished.runId), 'the finished run is listed with --all');
});

test('with no runs, live prints the "no live runs" line and --all the "no runs" line, both with exit 0', () => {
  const box = makeSandbox();
  const byDefault = live(box);
  assert.equal(byDefault.status, 0, byDefault.stderr);
  assert.ok(linesOf(byDefault).some((line) => line.startsWith('no live runs')), `"no live runs" in:\n${byDefault.stdout}`);
  const all = live(box, ['--all']);
  assert.equal(all.status, 0, all.stderr);
  assert.ok(linesOf(all).includes('no runs'), `"no runs" in:\n${all.stdout}`);
});

test('a run whose job.json is garbage is one unreadable line and the other runs still print, with exit 0', () => {
  const box = makeSandbox();
  const broken = createRun(box, jobOf(box, 'broken'));
  const fine = createRun(box, jobOf(box, 'fine'));
  writeFileSync(broken.job, 'this is not json {');
  const result = live(box);
  assert.equal(result.status, 0, result.stderr);
  const lines = linesOf(result);
  assert.ok(lines.some((line) => line.startsWith(`${broken.runId}  unreadable (`)), `an unreadable line for ${broken.runId} in:\n${result.stdout}`);
  assert.ok(lines.some((line) => line.startsWith(fine.runId)), `a line for ${fine.runId} in:\n${result.stdout}`);
});

test('one run with a bad value in driver.json is one line and the other runs still print, with exit 0', () => {
  const box = makeSandbox();
  const bad = createRun(box, jobOf(box, 'bad-value'));
  const fine = createRun(box, jobOf(box, 'fine'));
  writeJournal(bad, 'one', journalOf('one', { running: true, pid: process.pid }));
  holdRun(bad, { one: { state: 'waiting-limit', until: BAD_TIME, since: new Date().toISOString() } }); // valid JSON, but formatWhen cannot read `until`
  const result = live(box);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stderr.includes('RangeError'), result.stderr);
  assert.ok(result.stdout.includes(fine.runId), `a line for ${fine.runId} in:\n${result.stdout}`);
  assert.ok(result.stdout.includes(bad.runId), `a line for ${bad.runId} in:\n${result.stdout}`);
});

test('liveLoop keeps drawing the other runs when one run has a session id that is not a string', async () => {
  const box = makeSandbox();
  const bad = createRun(box, jobOf(box, 'bad-session'));
  const fine = createRun(box, jobOf(box, 'fine'));
  writeJournal(bad, 'one', journalOf('one', { sessionId: NOT_A_STRING_SESSION_ID, running: true, pid: process.pid }));
  holdRun(bad, { one: { state: 'running', since: new Date().toISOString() } });
  const { frames } = await loopFrames(box, { isTTY: false });
  assert.equal(frames.length, FRAMES_BEFORE_ABORT);
  for (const frame of frames) assert.ok(frame.includes(fine.runId), `a line for ${fine.runId} in:\n${frame}`);
});

/** liveLoop over `root` with a sleep that returns at once and aborts after `framesBeforeAbort` frames. @returns the frames and the sleep calls. */
async function loopFrames(box, { isTTY, columns = () => 0, framesBeforeAbort = FRAMES_BEFORE_ABORT }) {
  const controller = new AbortController();
  const frames = [];
  const sleeps = [];
  const sleep = async (ms) => {
    sleeps.push(ms);
    if (sleeps.length >= framesBeforeAbort) controller.abort();
    if (sleeps.length > FRAME_CAP) throw new Error('liveLoop kept drawing after abort()');
  };
  await liveLoop({ root: box.root, write: (frame) => frames.push(frame), signal: controller.signal, isTTY, columns, now: () => FIXED_NOW, sleep });
  return { frames, sleeps };
}

test('liveLoop draws a frame per wait of LIVE_REFRESH_MS and returns after abort()', async () => {
  const box = makeSandbox();
  createRun(box, jobOf(box, 'looped'));
  const { frames, sleeps } = await loopFrames(box, { isTTY: false });
  assert.equal(frames.length, FRAMES_BEFORE_ABORT);
  assert.deepEqual(sleeps, Array(FRAMES_BEFORE_ABORT).fill(LIVE_REFRESH_MS));
});

test('liveLoop on a TTY starts each frame by clearing the screen and cuts every line to one less than the width', async () => {
  const box = makeSandbox();
  createRun(box, jobOf(box, LONG_RUN_NAME));
  const { frames } = await loopFrames(box, { isTTY: true, columns: () => NARROW_COLUMNS });
  assert.ok(frames.length >= 2, `at least 2 frames, got ${frames.length}`);
  for (const frame of frames) {
    assert.ok(frame.startsWith(CLEAR_AND_HOME), 'a frame starts with cursor home and clear');
    const lines = frame.slice(CLEAR_AND_HOME.length).split('\n');
    const longest = Math.max(...lines.map((line) => line.length));
    assert.equal(longest, NARROW_COLUMNS - 1, `the longest line is cut to columns - 1:\n${frame}`);
  }
});

test('liveLoop off a TTY writes plain frames: no ESC, no cut, a blank line after each', async () => {
  const box = makeSandbox();
  createRun(box, jobOf(box, LONG_RUN_NAME));
  const { frames } = await loopFrames(box, { isTTY: false, columns: () => NARROW_COLUMNS });
  assert.ok(frames.length >= 2, `at least 2 frames, got ${frames.length}`);
  for (const frame of frames) {
    assert.ok(!frame.includes(ESC), 'no ESC character off a TTY');
    assert.ok(frame.endsWith('\n\n'), 'a frame ends with a blank line');
    assert.ok(frame.split('\n').some((line) => line.length >= NARROW_COLUMNS), 'lines are not cut off a TTY');
  }
});

test('liveLoop with the default sleep returns at once when the signal aborts during the wait', async () => {
  const box = makeSandbox();
  createRun(box, jobOf(box, 'ctrl-c'));
  const controller = new AbortController();
  const frames = [];
  const write = (frame) => {
    frames.push(frame);
    if (frames.length > FRAME_CAP) throw new Error('liveLoop kept drawing after abort()');
  };
  const started = performance.now();
  const done = liveLoop({ root: box.root, write, signal: controller.signal }); // draws frame one, then waits LIVE_REFRESH_MS
  controller.abort();
  await done;
  const waitedMs = performance.now() - started;
  assert.ok(waitedMs < CTRL_C_BUDGET_MS, `returned after ${Math.round(waitedMs)} ms, budget ${CTRL_C_BUDGET_MS} ms (refresh is ${LIVE_REFRESH_MS} ms)`);
  assert.equal(frames.length, 1);
});
