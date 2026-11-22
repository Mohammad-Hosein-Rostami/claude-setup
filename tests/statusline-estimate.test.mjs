// Tests for the status line's estimate segment: home/tools/estimate/lib/segment-cache.mjs (the read side, run on every render),
// home/tools/estimate/statusline-cache.mjs (the detached refresh that writes the cache) and home/statusline.mjs wired to both.
// The spawner and the clock are injected in the read-side tests: no real sleep, no real refresh process. The end-to-end tests run
// the CLI and the refresh script with HOME in a temp folder and the real clock, and compare their clocks with each other only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, realpathSync, rmSync } from 'node:fs';
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_CACHE_BYTES, RECOMPUTE_AFTER_MS, REFRESH_INTERVAL_MS, STALE_SHOW_MS, estimateSegment, readEntry, writeEntry,
} from '../home/tools/estimate/lib/segment-cache.mjs';
import { noteTable } from '../home/tools/estimate/lib/table-store.mjs';
import { BASE_MS, HOUR_MS, MIN_MS, SESSION, iso, row, statusDoc, writeTranscript } from './estimate-tables.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const STATUSLINE = fileURLToPath(new URL('../home/statusline.mjs', import.meta.url));
const REFRESH_SCRIPT = fileURLToPath(new URL('../home/tools/estimate/statusline-cache.mjs', import.meta.url));
const CLI = fileURLToPath(new URL('../home/tools/estimate/estimate.mjs', import.meta.url));
const SEGMENT_LIB = fileURLToPath(new URL('../home/tools/estimate/lib/segment-cache.mjs', import.meta.url));
const NOW = 1_800_000_000_000;
const SEGMENT = 'done by 16:15';
const DOC = statusDoc([row({ id: 'D1', startedH: 0, doneH: 0.5 }), row({ id: 'O1', startedH: 0.5 })]);

/** A project folder with a STATUS.md, an empty cache folder and store; `spawns` records every refresh the render asked for. */
async function setup(doc = DOC) {
  const root = makeTempDir('estimate-segment-');
  const projectDir = join(root, 'project');
  await mkdir(projectDir);
  const statusPath = join(projectDir, 'STATUS.md');
  if (doc !== null) await writeFile(statusPath, doc);
  const cacheDir = join(root, 'cache');
  const stateDir = join(root, 'state');
  const spawns = [];
  const deps = { cacheDir, stateDir, spawnRefresh: (...args) => spawns.push(args) };
  const render = (now, where = { projectDir }) => estimateSegment(where, { ...deps, now });
  return { root, projectDir, statusPath, cacheDir, stateDir, spawns, render };
}

/** A cache entry that matches the file on disk now (the state after a finished refresh). */
async function matchingEntry(statusPath, fields = {}) {
  const { mtimeMs, size } = await stat(statusPath);
  return { path: statusPath, kind: 'finish', text: SEGMENT, highMs: NOW + 10 * HOUR_MS, mtimeMs, size, computedAt: NOW - 1, refreshStartedAt: NOW - 1, ...fields };
}

test('a cache that matches the file is shown and starts no refresh', async () => {
  const { statusPath, cacheDir, spawns, render } = await setup();
  writeEntry(cacheDir, statusPath, await matchingEntry(statusPath));
  assert.equal(render(NOW)?.text, SEGMENT);
  assert.equal(spawns.length, 0);
});

test('a cache holding no text yet (a claim) shows nothing and is not refreshed again within the interval', async () => {
  const { statusPath, cacheDir, spawns, render } = await setup();
  writeEntry(cacheDir, statusPath, await matchingEntry(statusPath, { kind: null, text: null }));
  assert.equal(render(NOW), null);
  assert.equal(spawns.length, 0);
});

test('no STATUS.md, no project dir and no link: nothing is shown and nothing is spawned', async () => {
  const { render, spawns } = await setup(null);
  assert.equal(render(NOW), null);
  assert.equal(render(NOW, {}), null);
  assert.equal(render(NOW, { sessionId: SESSION }), null);
  assert.equal(spawns.length, 0);
});

test('the session\'s linked STATUS.md is used first, else <project dir>/STATUS.md; the refresh gets the session', async () => {
  const { root, projectDir, statusPath, stateDir, spawns, render } = await setup();
  const elsewhere = join(root, 'elsewhere', 'STATUS.md');
  await mkdir(join(root, 'elsewhere'));
  await writeFile(elsewhere, DOC);
  assert.equal(noteTable(stateDir, elsewhere, { sessionId: SESSION, ids: ['D1', 'O1'], nowMs: NOW }), true);
  render(NOW, { projectDir, sessionId: SESSION });
  render(NOW, { projectDir, sessionId: '22222222-2222-4333-8444-555555555555' }); // no link: the project's file
  render(NOW, { projectDir, sessionId: '../escape' }); // not a session id: the project's file, no session passed on
  assert.deepEqual(spawns.map(([path, session]) => [path.endsWith(join('elsewhere', 'STATUS.md')), path === statusPath, session]), [
    [true, false, SESSION], [false, true, '22222222-2222-4333-8444-555555555555'],
  ]);
});

test('a cache written for another STATUS.md path is not shown', async () => {
  const { statusPath, cacheDir, render } = await setup();
  writeEntry(cacheDir, statusPath, await matchingEntry(statusPath, { path: join(tmpdir(), 'other', 'STATUS.md') }));
  assert.equal(render(NOW), null);
});

test('a corrupt cache file shows nothing and is replaced by a refresh claim', async () => {
  const { statusPath, cacheDir, spawns, render } = await setup();
  writeEntry(cacheDir, statusPath, await matchingEntry(statusPath));
  const cacheFile = join(cacheDir, readdirSync(cacheDir)[0]);
  await writeFile(cacheFile, '{not json');
  assert.equal(render(NOW), null);
  assert.equal(spawns.length, 1);
  assert.equal(readEntry(cacheDir, statusPath).refreshStartedAt, NOW);
});

test('an oversized cache file shows nothing', async () => {
  const { statusPath, cacheDir, render } = await setup();
  writeEntry(cacheDir, statusPath, await matchingEntry(statusPath));
  const cacheFile = join(cacheDir, readdirSync(cacheDir)[0]);
  await writeFile(cacheFile, JSON.stringify(await matchingEntry(statusPath, { text: 'x'.repeat(MAX_CACHE_BYTES) })));
  assert.equal(render(NOW), null);
});

test('a cache file that is a link shows nothing and starts no refresh (the claim cannot be written)', async () => {
  const { root, statusPath, cacheDir, spawns, render } = await setup();
  writeEntry(cacheDir, statusPath, await matchingEntry(statusPath));
  const cacheFile = join(cacheDir, readdirSync(cacheDir)[0]);
  const target = join(root, 'planted.json');
  await writeFile(target, JSON.stringify(await matchingEntry(statusPath)));
  rmSync(cacheFile);
  await symlink(target, cacheFile);
  assert.equal(render(NOW), null);
  assert.equal(spawns.length, 0);
  assert.equal((await readFile(target, 'utf8')).includes(SEGMENT), true, 'the link target is left alone');
});

test('a missing cache starts exactly one refresh within the interval, another after it', async () => {
  const { statusPath, spawns, render } = await setup();
  assert.equal(render(NOW), null);
  assert.equal(render(NOW + REFRESH_INTERVAL_MS - 1), null);
  assert.deepEqual(spawns, [[statusPath, undefined]]);
  assert.equal(render(NOW + REFRESH_INTERVAL_MS), null);
  assert.equal(spawns.length, 2);
});

test('a matching cache older than RECOMPUTE_AFTER_MS still shows its text and starts one refresh (a pause slides the time)', async () => {
  const { statusPath, cacheDir, spawns, render } = await setup();
  writeEntry(cacheDir, statusPath, await matchingEntry(statusPath, { computedAt: NOW - RECOMPUTE_AFTER_MS, refreshStartedAt: NOW - RECOMPUTE_AFTER_MS }));
  assert.equal(render(NOW)?.text, SEGMENT);
  assert.equal(render(NOW + 1)?.text, SEGMENT);
  assert.equal(spawns.length, 1);
});

test('a changed file keeps the old text for STALE_SHOW_MS while one refresh runs, then shows nothing', async () => {
  const { statusPath, cacheDir, spawns, render } = await setup();
  writeEntry(cacheDir, statusPath, await matchingEntry(statusPath, { mtimeMs: 1, size: 1, computedAt: NOW, refreshStartedAt: 0 }));
  assert.equal(render(NOW + 1)?.text, SEGMENT);
  assert.equal(render(NOW + 2)?.text, SEGMENT);
  assert.equal(spawns.length, 1, 'the second render sees the claim and spawns nothing');
  assert.equal(render(NOW + STALE_SHOW_MS), null);
});

test('the render never imports the forecast, the parser or the transcript reader', async () => {
  const source = await readFile(SEGMENT_LIB, 'utf8');
  const imports = [...source.matchAll(/^import .* from '(.+)';$/gm)].map((match) => match[1]);
  assert.deepEqual(imports.filter((name) => /forecast|activity|worked|items|from-files|report|segment-text/.test(name)), []);
});

/** A HOME with a STATUS.md whose rows ran in the last hour of the real clock, and a transcript of that hour. */
async function liveHome() {
  const root = makeTempDir('estimate-live-');
  const home = join(root, 'home');
  const nowH = Math.floor((Date.now() - BASE_MS) / MIN_MS) / 60;
  writeTranscript(join(home, '.claude', 'projects'), SESSION, nowH - 1, nowH);
  const statusPath = join(root, 'STATUS.md');
  await writeFile(statusPath, statusDoc([row({ id: 'D1', raw: { started: iso(nowH - 1), done: iso(nowH - 0.5) } }), row({ id: 'O1', raw: { started: iso(nowH - 0.5) } })]));
  const env = { ...process.env, HOME: home, USERPROFILE: home, TZ: 'UTC', CLAUDE_CODE_SESSION_ID: '' };
  return { home, statusPath, env };
}

test('after a CLI run the status-line refresh prints the same clock, from the same stored commitment', async () => {
  const { home, statusPath, env } = await liveHome();
  const cli = spawnSync(process.execPath, [CLI, statusPath, '--session', SESSION], { env, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const finish = cli.stdout.split('\n')[0].match(/^Finish: \w{3} \d+ \w{3} (\d\d:\d\d) /)[1];
  const refresh = spawnSync(process.execPath, [REFRESH_SCRIPT, statusPath, SESSION], { env, encoding: 'utf8' });
  assert.equal(refresh.status, 0, refresh.stderr);
  const entry = readEntry(join(home, '.claude', 'state', 'estimate-segment'), statusPath);
  assert.equal(entry.kind, 'finish');
  assert.match(entry.text, new RegExp(`^done by (\\w{3} )?${finish}$`));
  assert.equal(new Date(entry.highMs).toISOString().slice(11, 16), finish);
});

test('the refresh script: a bad call exits 1 and prints only its usage', async () => {
  const { statusPath, env } = await liveHome();
  for (const args of [[], [statusPath, '../escape'], [statusPath, SESSION, 'extra']]) {
    const run = spawnSync(process.execPath, [REFRESH_SCRIPT, ...args], { env, encoding: 'utf8' });
    assert.equal(run.status, 1, args.join(' '));
    assert.equal(run.stderr, 'usage: statusline-cache.mjs <STATUS.md> [<session-id>]\n');
  }
});

test('the status line prints the job of the session\'s linked STATUS.md from a fresh cache, and none without one', async () => {
  const { root, projectDir, statusPath } = await setup();
  const home = join(root, 'home');
  const cacheDir = join(home, '.claude', 'state', 'estimate-segment');
  const fresh = async (path) => ({ ...(await matchingEntry(statusPath, { computedAt: Date.now(), refreshStartedAt: Date.now(), numbers: startedNumbers() })), path });
  writeEntry(cacheDir, statusPath, await fresh(statusPath));
  const render = (input) => spawnSync(process.execPath, [STATUSLINE], {
    input: JSON.stringify({ model: { id: 'claude-sonnet-5-5', display_name: 'Sonnet 5.5' }, rate_limits: { five_hour: {} }, ...input }),
    env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' },
    encoding: 'utf8',
  }).stdout;
  assert.match(render({ workspace: { project_dir: projectDir }, cost: { total_duration_ms: HOUR_MS } }), LIVE_SHOWN);
  assert.match(render({ workspace: { project_dir: root } }), /^ALL no job linked$/m);
  noteTable(join(home, '.claude', 'state', 'estimate'), statusPath, { sessionId: SESSION, ids: [], nowMs: Date.now() });
  const linked = realpathSync(statusPath); // the link holds the real path, and the refresh caches under it
  writeEntry(cacheDir, linked, await fresh(linked));
  assert.match(render({ workspace: { project_dir: root }, session_id: SESSION }), LIVE_SHOWN);
});

// The render draws the finish from the entry's clock (highMs) in its own zone, with the weekday on another day (audit case 12).
const CLOCK_SHOWN = /done by (\w{3} )?\d\d:\d\d/;
const withClock = (line) => line.replace(/((Mon|Tue|Wed|Thu|Fri|Sat|Sun) )?\d\d:\d\d/, '<clock>');
const PROGRESS = { pct: 54, approx: false, rowsDone: 5, rowsTotal: 9, leftMin: 30, tag: 'moved' };
// The status line's job row counts live work only (owner decision RC6): one open row of 40 expected minutes started 10 minutes ago
// earns 10 of them, so 25% and 30 min left; the clock is when those 30 minutes end.
const LIVE_SHOWN = /^ALL .*30 min left · by (\w{3} )?\d\d:\d\d/m;
const startedNumbers = () => ({ finishMs: null, p85Ms: null, leftMin: 30, workedMin: 35, rowsDone: 5, rowsTotal: 9,
  rows: [{ id: 'O1', expectMin: 40, startedMs: Date.now() - 10 * MIN_MS }, { id: 'O2', expectMin: 9, startedMs: null }] });

test('a cache entry carries the job progress and the render returns it with the text; an entry without one gives null', async () => {
  const { statusPath, cacheDir, render } = await setup();
  writeEntry(cacheDir, statusPath, await matchingEntry(statusPath, { progress: PROGRESS }));
  assert.deepEqual(render(NOW), { kind: 'finish', highMs: NOW + 10 * HOUR_MS, text: SEGMENT, progress: PROGRESS, numbers: null });
  writeEntry(cacheDir, statusPath, await matchingEntry(statusPath));
  assert.deepEqual(render(NOW), { kind: 'finish', highMs: NOW + 10 * HOUR_MS, text: SEGMENT, progress: null, numbers: null });
  assert.ok(JSON.stringify(await matchingEntry(statusPath, { progress: PROGRESS })).length < MAX_CACHE_BYTES / 8);
});

test('a progress that is not the stored shape is dropped, the entry and its text stay', async () => {
  const { statusPath, cacheDir, render } = await setup();
  const bad = [{ ...PROGRESS, pct: 101 }, { ...PROGRESS, pct: 'x' }, { ...PROGRESS, tag: 'boom' }, { ...PROGRESS, rowsTotal: -1 }, { ...PROGRESS, leftMin: 'soon' }, 'text', [], { pct: 5 }];
  for (const progress of bad) {
    writeEntry(cacheDir, statusPath, await matchingEntry(statusPath, { progress }));
    assert.deepEqual(render(NOW), { kind: 'finish', highMs: NOW + 10 * HOUR_MS, text: SEGMENT, progress: null, numbers: null }, JSON.stringify(progress));
  }
});

test('once the shown clock has passed the render shows the overdue text and the overdue tag, whatever the stored tag', async () => {
  const { statusPath, cacheDir, render } = await setup();
  writeEntry(cacheDir, statusPath, await matchingEntry(statusPath, { progress: { ...PROGRESS, tag: null }, highMs: NOW + 1 }));
  assert.deepEqual(render(NOW + 2), { kind: 'finish', highMs: NOW + 1, text: 'done ? overdue', progress: { ...PROGRESS, tag: 'overdue' }, numbers: null });
});

test('the refresh script stores the progress of the job it estimated', async () => {
  const { home, statusPath, env } = await liveHome();
  const refresh = spawnSync(process.execPath, [REFRESH_SCRIPT, statusPath, SESSION], { env, encoding: 'utf8' });
  assert.equal(refresh.status, 0, refresh.stderr);
  const { progress } = readEntry(join(home, '.claude', 'state', 'estimate-segment'), statusPath);
  assert.equal(progress.rowsDone, 1);
  assert.equal(progress.rowsTotal, 2);
  assert.equal(progress.approx, false);
  assert.ok(Number.isInteger(progress.pct) && progress.pct >= 0 && progress.pct <= 99);
});

test('a CLI run at the real clock stores the same progress in the cache as the Finish block prints', async () => {
  const { home, statusPath, env } = await liveHome();
  const cli = spawnSync(process.execPath, [CLI, statusPath, '--session', SESSION], { env, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const printed = cli.stdout.match(/^Progress: (\d+)% \((\d+) of (\d+) rows; median left .+\)$/m);
  assert.ok(printed, cli.stdout);
  const { progress } = readEntry(join(home, '.claude', 'state', 'estimate-segment'), statusPath);
  assert.deepEqual([progress.pct, progress.rowsDone, progress.rowsTotal], printed.slice(1).map(Number));
});

test('the status line prints the job row and the git and session row, fitted to COLUMNS, without colour under NO_COLOR, ASCII under TERM=dumb', async () => {
  const { root, projectDir, statusPath } = await setup();
  const home = join(root, 'home');
  writeEntry(join(home, '.claude', 'state', 'estimate-segment'), statusPath, await matchingEntry(statusPath, { progress: PROGRESS, numbers: startedNumbers(), computedAt: Date.now(), refreshStartedAt: Date.now() }));
  const journals = join(root, 'proj', 'sess-1', 'subagents', 'workflows', 'wf_a');
  await mkdir(journals, { recursive: true });
  await writeFile(join(journals, 'journal.jsonl'), `${['started', 'result'].map((type) => JSON.stringify({ type, agentId: 'a1', label: 'impl-a:review', phase: 'Review' })).join('\n')}\n`);
  const render = (env) => spawnSync(process.execPath, [STATUSLINE], {
    input: JSON.stringify({ model: { id: 'claude-sonnet-5-5', display_name: 'Sonnet 5.5' }, rate_limits: { five_hour: {} }, workspace: { project_dir: projectDir }, cost: { total_duration_ms: HOUR_MS }, transcript_path: join(root, 'proj', 'sess-1.jsonl') }),
    env: { ...process.env, HOME: home, USERPROFILE: home, COLUMNS: '', NO_COLOR: '', CLAUDE_ACCOUNT: '', TERM: 'xterm-256color', ...env },
    encoding: 'utf8',
  }).stdout.trimEnd().split('\n');
  const wide = render({ COLUMNS: '120' });
  assert.equal(wide.length, 2);
  assert.match(wide[0], /by (\w{3} )?\d\d:\d\d/);
  assert.equal(withClock(wide[0]), '\u001b[2mALL    \u001b[0m████░░░░░░░░░░░░  25%  30 min left · \u001b[2mby <clock>\u001b[0m · \u001b[2m1 row started\u001b[0m');
  const session = 'Sonnet 5.5 · \u001b[2mctx ?\u001b[0m · account ?';
  assert.equal(wide[1], `\u001b[2mgit: loading\u001b[0m${' '.repeat(115 - 'git: loading'.length - 'Sonnet 5.5 · ctx ? · account ?'.length)}${session}`, 'git left, the session block ending at COLUMNS - 5');
  assert.equal(withClock(render({ COLUMNS: '80', NO_COLOR: '1' })[0]), 'ALL ██░░░░░░░░  25%  30 min left · by <clock> · 1 row started');
  assert.doesNotMatch(render({ COLUMNS: '80', NO_COLOR: '1', TERM: 'dumb' }).join(''), /\u001b|[^\u0020-\u007e]/);
  assert.equal(withClock(render({ COLUMNS: '50', NO_COLOR: '1' })[0]), 'ALL █░░░░░  25%  30 min left · by <clock>');
  assert.equal(withClock(render({ COLUMNS: 'abc', NO_COLOR: '1' })[0]), 'ALL ██░░░░░░░░  25%  30 min left · by <clock> · 1 row started', 'no usable COLUMNS: 80');
});

test('with neither progress nor a live run the status line stays at its two rows', async () => {
  const { root, projectDir } = await setup();
  const home = join(root, 'home');
  const out = spawnSync(process.execPath, [STATUSLINE], {
    input: JSON.stringify({ model: { id: 'claude-sonnet-5-5', display_name: 'Sonnet 5.5' }, rate_limits: { five_hour: {} }, workspace: { project_dir: projectDir }, transcript_path: join(root, 'proj', 'none.jsonl') }),
    env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8',
  }).stdout;
  assert.equal(out.trimEnd().split('\n').length, 2);
});
