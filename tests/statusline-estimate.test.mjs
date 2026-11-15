// Tests for the status line's estimate segment: home/tools/estimate/lib/segment-cache.mjs (the read side, run on every render),
// home/tools/estimate/statusline-cache.mjs (the detached refresh that writes the cache) and home/statusline.mjs wired to both.
// The spawner and the clock are injected: no real sleep, no wall-clock assertion, no real refresh process in the read-side tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateFile } from '../home/tools/estimate/lib/from-files.mjs';
import { finishClock } from '../home/tools/estimate/lib/report.mjs';
import {
  MAX_CACHE_BYTES, RECOMPUTE_AFTER_MS, REFRESH_INTERVAL_MS, STALE_SHOW_MS, estimateSegment, readEntry, writeEntry,
} from '../home/tools/estimate/lib/segment-cache.mjs';
import { fiveDoneRows, row, statusDoc } from './estimate-fixtures.mjs';

const STATUSLINE = fileURLToPath(new URL('../home/statusline.mjs', import.meta.url));
const REFRESH_SCRIPT = fileURLToPath(new URL('../home/tools/estimate/statusline-cache.mjs', import.meta.url));
const SEGMENT_LIB = fileURLToPath(new URL('../home/tools/estimate/lib/segment-cache.mjs', import.meta.url));
const NOW = 1_800_000_000_000;
const SEGMENT = 'done ~14:50-16:15';
const USABLE_DOC = statusDoc(fiveDoneRows([row({ id: 'O1', size: 'L' })]));
const REFUSED_DOC = statusDoc([row({ id: 'D1', startedH: 0, doneH: 1 }), row({ id: 'O1' })]); // one done item: refused, exit 3
const DELIVERED_DOC = statusDoc(fiveDoneRows([row({ id: 'C1', item: 'close: row', startedH: 13, doneH: 14 })])); // nothing open after a delivery
const iso = (ms) => new Date(ms).toISOString();
const refreshIn = (root, projectDir, statusPath) => {
  const home = join(root, 'home');
  const run = spawnSync(process.execPath, [REFRESH_SCRIPT, statusPath], { cwd: projectDir, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
  return { run, entry: readEntry(join(home, '.claude', 'state', 'estimate-segment'), statusPath) };
};

/** A project folder with a STATUS.md and an empty cache folder; `spawns` records every refresh the render asked for. */
async function setup(doc = USABLE_DOC) {
  const root = await mkdtemp(join(tmpdir(), 'estimate-segment-'));
  const projectDir = join(root, 'project');
  await mkdir(projectDir);
  const statusPath = join(projectDir, 'STATUS.md');
  if (doc !== null) await writeFile(statusPath, doc);
  const cacheDir = join(root, 'cache');
  const spawns = [];
  const render = (now) => estimateSegment(projectDir, { cacheDir, now, spawnRefresh: (...args) => spawns.push(args) });
  return { root, projectDir, statusPath, cacheDir, spawns, render };
}

/** A cache entry that matches the file on disk now (the state after a finished refresh). */
async function matchingEntry(statusPath, fields = {}) {
  const { mtimeMs, size } = await stat(statusPath);
  return { path: statusPath, text: SEGMENT, highMs: NOW + 10 * 3_600_000, mtimeMs, size, computedAt: NOW - 1, refreshStartedAt: NOW - 1, ...fields };
}

test('a cache that matches the file is shown and starts no refresh', async () => {
  const { statusPath, cacheDir, spawns, render } = await setup();
  writeEntry(cacheDir, statusPath, await matchingEntry(statusPath));
  assert.equal(render(NOW), SEGMENT);
  assert.equal(spawns.length, 0);
});

test('a cache holding no text (the tool refused) shows nothing and is not refreshed while the file is unchanged', async () => {
  const { statusPath, cacheDir, spawns, render } = await setup(REFUSED_DOC);
  writeEntry(cacheDir, statusPath, await matchingEntry(statusPath, { text: null }));
  assert.equal(render(NOW), null);
  assert.equal(spawns.length, 0);
});

test('no STATUS.md: nothing is shown and nothing is spawned', async () => {
  const { render, spawns } = await setup(null);
  assert.equal(render(NOW), null);
  assert.equal(spawns.length, 0);
});

test('only <project dir>/STATUS.md is used: a missing project dir shows nothing', async () => {
  const { cacheDir, spawns } = await setup();
  assert.equal(estimateSegment(undefined, { cacheDir, now: NOW, spawnRefresh: (...args) => spawns.push(args) }), null);
  assert.equal(spawns.length, 0);
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
  const entry = await matchingEntry(statusPath, { text: 'x'.repeat(MAX_CACHE_BYTES) });
  await writeFile(cacheFile, JSON.stringify(entry));
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
  const { statusPath, projectDir, spawns, render } = await setup();
  assert.equal(render(NOW), null);
  assert.equal(render(NOW + REFRESH_INTERVAL_MS - 1), null);
  assert.deepEqual(spawns, [[statusPath, projectDir]]);
  assert.equal(render(NOW + REFRESH_INTERVAL_MS), null);
  assert.equal(spawns.length, 2);
});

test('review 2: a matching cache older than RECOMPUTE_AFTER_MS still shows its text and starts one refresh (the finish moves with the clock)', async () => {
  const { statusPath, cacheDir, spawns, render } = await setup();
  writeEntry(cacheDir, statusPath, await matchingEntry(statusPath, { computedAt: NOW - RECOMPUTE_AFTER_MS, refreshStartedAt: NOW - RECOMPUTE_AFTER_MS }));
  assert.equal(render(NOW), SEGMENT);
  assert.equal(render(NOW + 1), SEGMENT);
  assert.equal(spawns.length, 1);
});

test('review 2: no segment once the cached range\'s high end has passed', async () => {
  const { statusPath, cacheDir, render } = await setup();
  writeEntry(cacheDir, statusPath, await matchingEntry(statusPath, { highMs: NOW - 1 }));
  assert.equal(render(NOW), null);
  assert.equal(render(NOW - 2), SEGMENT);
});

test('a changed file keeps the old text for STALE_SHOW_MS while one refresh runs, then shows nothing', async () => {
  const { statusPath, cacheDir, spawns, render } = await setup();
  const old = await matchingEntry(statusPath, { mtimeMs: 1, size: 1, computedAt: NOW, refreshStartedAt: 0 });
  writeEntry(cacheDir, statusPath, old);
  assert.equal(render(NOW + 1), SEGMENT);
  assert.equal(render(NOW + 2), SEGMENT);
  assert.equal(spawns.length, 1, 'the second render sees the claim and spawns nothing');
  assert.equal(render(NOW + STALE_SHOW_MS), null);
});

test('the render function takes only the cache entry and the file stat, never a transcript', async () => {
  const source = await readFile(SEGMENT_LIB, 'utf8');
  const imports = [...source.matchAll(/^import .* from '(.+)';$/gm)].map((match) => match[1]);
  assert.deepEqual(imports.filter((name) => /compute|limits|items|from-files/.test(name)), []);
});

test('the refresh script writes "done ~<finish clock>" from the estimate lib for the same STATUS.md', async () => {
  const { root, projectDir, statusPath } = await setup();
  const before = Date.now();
  const { run, entry } = refreshIn(root, projectDir, statusPath);
  const after = Date.now();
  assert.equal(run.status, 0, run.stderr);
  // the script reads the clock itself: its text is the lib's text at some instant between the two readings
  const expected = [before, after].map((now) => `done ~${finishClock(estimateFile(statusPath, { cwd: projectDir, transcripts: root, now: iso(now) }).result)}`);
  assert.ok(expected.includes(entry.text), `${entry.text} not in ${expected}`);
  assert.match(entry.text, /^done ~(\w{3} )?\d\d:\d\d( - \w{3} |-)\d\d:\d\d$/);
  assert.ok(entry.highMs > before, 'the printed high end is stored for the render to hide a passed range');
  assert.equal(entry.size, (await stat(statusPath)).size);
  assert.equal(entry.mtimeMs, (await stat(statusPath)).mtimeMs);
});

test('the refresh script caches "no text" when the tool refuses (exit 3 case) or the job is delivered', async () => {
  for (const doc of [REFUSED_DOC, DELIVERED_DOC]) {
    const { root, projectDir, statusPath } = await setup(doc);
    const { run, entry } = refreshIn(root, projectDir, statusPath);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(entry.text, null);
    assert.equal(entry.highMs, null);
    assert.equal(run.stdout + run.stderr, '');
  }
});

test('the status line prints the segment from a fresh cache and omits it without STATUS.md', async () => {
  const { root, projectDir, statusPath } = await setup();
  const home = join(root, 'home');
  const cacheDir = join(home, '.claude', 'state', 'estimate-segment');
  writeEntry(cacheDir, statusPath, await matchingEntry(statusPath, { computedAt: Date.now(), refreshStartedAt: Date.now() }));
  const render = (dir) => spawnSync(process.execPath, [STATUSLINE], {
    input: JSON.stringify({ model: { id: 'claude-sonnet-5-5', display_name: 'Sonnet 5.5' }, workspace: { project_dir: dir }, rate_limits: { five_hour: {} } }),
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
  }).stdout;
  assert.match(render(projectDir), /done ~14:50-16:15/);
  assert.doesNotMatch(render(root), /done ~/);
});
