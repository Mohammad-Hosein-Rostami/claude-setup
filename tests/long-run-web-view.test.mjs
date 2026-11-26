// Tests of the `long-run view` screen (plan run-viewer, pieces rv-1 and rv-2). The data: flowOf draws the job's routes; runsData
// lists the runs newest first with step times and events, cleans token-shaped text, shows a broken run as an error entry, and
// writes nothing. The server: it serves the page and the runs on 127.0.0.1 with a strict CSP, refuses other paths, methods and
// Host headers, refuses a port in use with one line, and writes nothing; openBrowser picks the opener per platform; the CLI
// refuses an unknown run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { appendJsonLine, readRunJob, writeJournal, writeJson } from '../home/tools/long-run/lib/run-store.mjs';
import { flowOf, runsData } from '../home/tools/long-run/lib/web-data.mjs';
import { openBrowser, startViewServer } from '../home/tools/long-run/lib/web-view.mjs';
import { TOKEN_A, cli, createRun, makeSandbox } from './long-run-helpers.mjs';

const OLDER = new Date('2026-11-25T10:00:00.000Z');
const NEWER = new Date('2026-11-25T11:00:00.000Z');
const NOW = new Date('2026-11-25T12:00:00.000Z');
const STARTED_AT = '2026-11-25T10:05:00.000Z';
const LAST_START_AT = '2026-11-25T10:20:00.000Z';
const RETRY_AT = '2026-11-25T12:30:00.000Z';
const WALL_MS = 90000;
const STEP_ONE = { id: 'one', prompt: 'One.' };

const jobOf = (box, name, steps = [STEP_ONE]) => ({ name, cwd: box.work('repo'), steps });

/** A journal of a started step, as the driver leaves it (only the fields runView reads). */
function journalOf(unitId, overrides = {}) {
  return { id: unitId, sessionId: null, account: 'acct-a', folder: null, running: false, pid: null, last: null, totalStarts: 2, attempts: 0,
    startedAt: STARTED_AT, wallMs: WALL_MS, waitUntil: null, nextAttemptAt: null, final: null,
    startsLog: [{ n: 1, at: STARTED_AT, log: `logs/${unitId}.1.jsonl` }, { n: 2, at: LAST_START_AT, log: `logs/${unitId}.2.jsonl` }], ...overrides };
}

/** Two runs: the older one done, the newer one waiting for a retry with no driver; each with one event. */
function twoRuns(box, { reason = 'fine' } = {}) {
  const done = createRun(box, jobOf(box, 'finished'), { now: OLDER });
  writeJournal(done, 'one', journalOf('one', { final: { status: 'done', reason } }));
  writeJson(done.driver, { status: 'done', hold: null }); // the driver's last word on a run it finished
  appendJsonLine(done.events, { t: STARTED_AT, event: 'step-done', step: 'one', detail: 'done', extra: 1 });
  const waiting = createRun(box, jobOf(box, 'retrying'), { now: NEWER });
  writeJournal(waiting, 'one', journalOf('one', { attempts: 1, nextAttemptAt: RETRY_AT }));
  appendJsonLine(waiting.events, { t: LAST_START_AT, event: 'step-retry', step: 'one', detail: `retry at ${RETRY_AT}` });
  return { done, waiting };
}

/** Every file and folder under `root` with its size and mtime, to show that nothing was written. */
function snapshot(root) {
  return readdirSync(root, { recursive: true }).sort().map((name) => {
    const stats = statSync(join(root, name));
    return `${name} ${stats.size} ${stats.mtimeMs}`;
  });
}

test('flowOf gives one entry per job step, a group with its item ids, and only the routes the job names', () => {
  const box = makeSandbox();
  const paths = createRun(box, jobOf(box, 'flow', [
    { id: 'plan', prompt: 'Plan.' },
    { id: 'pages', parallel: [{ id: 'guide', prompt: 'Guide.', cwd: box.work('guide') }, { id: 'api', prompt: 'Api.', cwd: box.work('api') }] },
    { id: 'build', prompt: 'Build.', next: { failed: 'fix' } },
    { id: 'fix', prompt: 'Fix.', next: { done: 'build' } },
  ]));
  assert.deepEqual(flowOf(readRunJob(paths)), [
    { id: 'plan', kind: 'step', items: [], next: {} },
    { id: 'pages', kind: 'group', items: ['guide', 'api'], next: {} },
    { id: 'build', kind: 'step', items: [], next: { failed: 'fix' } },
    { id: 'fix', kind: 'step', items: [], next: { done: 'build' } },
  ]);
});

test('runsData lists both runs newest first, with step times, the retry time, the flow and the events', () => {
  const box = makeSandbox();
  const { done, waiting } = twoRuns(box);
  const data = runsData(box.root, { now: NOW });
  assert.equal(data.now, NOW.toISOString());
  assert.deepEqual(data.runs.map((run) => run.runId), [waiting.runId, done.runId]);
  const [newer, older] = data.runs;
  assert.equal(older.finished, true);
  assert.equal(older.view.state, 'done');
  assert.equal(older.view.steps[0].status, 'done');
  assert.equal(newer.finished, false);
  assert.equal(newer.view.state, 'stale'); // no driver.json: nobody drives it
  assert.deepEqual(
    { status: newer.view.steps[0].status, waitUntil: newer.view.steps[0].waitUntil, startedAt: newer.view.steps[0].startedAt,
      lastStartAt: newer.view.steps[0].lastStartAt, wallMs: newer.view.steps[0].wallMs },
    { status: 'started', waitUntil: RETRY_AT, startedAt: STARTED_AT, lastStartAt: LAST_START_AT, wallMs: WALL_MS },
  );
  assert.deepEqual(newer.flow, [{ id: 'one', kind: 'step', items: [], next: {} }]);
  assert.deepEqual(older.events, [{ t: STARTED_AT, event: 'step-done', step: 'one', detail: 'done' }]); // extra fields dropped
  assert.deepEqual(newer.events, [{ t: LAST_START_AT, event: 'step-retry', step: 'one', detail: `retry at ${RETRY_AT}` }]);
});

test('a step not started yet has no times', () => {
  const box = makeSandbox();
  createRun(box, jobOf(box, 'fresh'));
  const [step] = runsData(box.root, { now: NOW }).runs[0].view.steps;
  assert.deepEqual({ status: step.status, startedAt: step.startedAt, lastStartAt: step.lastStartAt, wallMs: step.wallMs },
    { status: 'not started', startedAt: null, lastStartAt: null, wallMs: 0 });
});

test('a token and token-shaped text in a reason come back as <token>', () => {
  const box = makeSandbox();
  twoRuns(box, { reason: `login failed with ${TOKEN_A}` });
  const text = JSON.stringify(runsData(box.root, { now: NOW }));
  assert.ok(!text.includes(TOKEN_A), 'the sandbox token must not be in the data');
  assert.ok(!text.includes('sk-ant-'), 'no sk-ant- text must be in the data');
  assert.match(text, /login failed with <token>/);
});

test('a run with a broken job.json is an error entry and the other run still shows', () => {
  const box = makeSandbox();
  const { done, waiting } = twoRuns(box);
  writeFileSync(waiting.job, '{ not json');
  const [broken, fine] = runsData(box.root, { now: NOW }).runs;
  assert.equal(broken.runId, waiting.runId);
  assert.equal(typeof broken.error, 'string');
  assert.deepEqual(Object.keys(broken), ['runId', 'error']);
  assert.equal(fine.runId, done.runId);
  assert.equal(fine.view.state, 'done');
});

test('runsData writes nothing: the state folder has the same files, sizes and mtimes after it', () => {
  const box = makeSandbox();
  twoRuns(box);
  const before = snapshot(box.root);
  runsData(box.root, { now: NOW });
  assert.deepEqual(snapshot(box.root), before);
});

/** One request to the view server; `host` replaces the Host header (fetch cannot set it). */
function ask(url, path, { method = 'GET', host = null } = {}) {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const sent = request({ hostname, port, path, method, headers: host ? { host } : {} }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    sent.on('error', reject);
    sent.end();
  });
}

test('the view server serves the page and the runs on 127.0.0.1 and refuses other paths, methods and hosts', async () => {
  const box = makeSandbox();
  const paths = createRun(box, jobOf(box, 'served'));
  const before = snapshot(box.root);
  const { url, close } = await startViewServer({ root: box.root, port: 0, now: () => NOW });
  try {
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const page = await ask(url, '/');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /^text\/html/);
    assert.match(page.headers['content-security-policy'], /default-src 'none'; script-src 'self'/);
    assert.equal(page.headers['access-control-allow-origin'], undefined);
    const runs = await ask(url, '/api/runs');
    assert.equal(runs.status, 200);
    assert.deepEqual(JSON.parse(runs.body).runs.map((run) => run.runId), [paths.runId]);
    assert.equal((await ask(url, '/view.js')).status, 200);
    assert.equal((await ask(url, '/../package.json')).status, 404);
    assert.equal((await ask(url, '/x')).status, 404);
    assert.equal((await ask(url, '/api/runs', { method: 'POST' })).status, 405);
    assert.equal((await ask(url, '/', { host: `evil.example:${new URL(url).port}` })).status, 403);
  } finally {
    await close();
  }
  assert.deepEqual(snapshot(box.root), before);
});

test('a port in use is refused with one line naming --port', async () => {
  const box = makeSandbox();
  const first = await startViewServer({ root: box.root, port: 0 });
  const { port } = new URL(first.url);
  try {
    await assert.rejects(startViewServer({ root: box.root, port: Number(port) }), {
      message: `port ${port} is in use (another long-run view? open http://127.0.0.1:${port}/); try --port <n>`,
    });
  } finally {
    await first.close();
  }
});

test('openBrowser uses open on macOS, explorer.exe on Windows and xdg-open on Linux, detached', () => {
  for (const [platform, command] of [['darwin', 'open'], ['win32', 'explorer.exe'], ['linux', 'xdg-open']]) {
    const calls = [];
    const spawner = (file, args, options) => {
      calls.push({ file, args, detached: options.detached });
      return { on: () => {}, unref: () => {} };
    };
    openBrowser('http://127.0.0.1:4790/', { platform, spawner });
    assert.deepEqual(calls, [{ file: command, args: ['http://127.0.0.1:4790/'], detached: true }]);
  }
});

test('long-run view of an unknown run exits 3', () => {
  const box = makeSandbox();
  assert.equal(cli(box, ['view', 'nope-20260101-000000', '--no-open']).status, 3);
});
