// Tests for the board refresher's cache files (home/tools/board/lib/cache-file.mjs) and what RC5 left of the identity hues: the
// byte cap of a cache file, the 7-day sweep that takes a `<session>-hues.json` left by an older release (F3), and a status line
// run that writes no colour file (F2). Files under a temp HOME; the status line runs as a child.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSessionFile } from '../home/hooks/lib/session-store.mjs';
import { cacheDir, writeCacheFile } from '../home/tools/board/lib/cache-file.mjs';
import { placedWriterBoard } from './statusline-board-fixture.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { cleanEnv } from './clean-env.mjs';

const STATUSLINE = fileURLToPath(new URL('../home/statusline.mjs', import.meta.url));
const DAY_S = 24 * 60 * 60;

test('a cache file is capped in bytes, not in characters: a value of 2-byte characters over the cap is not written', () => {
  const env = { HOME: makeTempDir('cache-bytes-') };
  const file = join(env.HOME, '.claude', 'state', 'board-cache', 'bytes-1.json');
  assert.equal(writeCacheFile('bytes-1', { text: 'é'.repeat(600) }, env, 1024), false, '1200 bytes, 612 characters');
  assert.equal(existsSync(file), false);
  assert.equal(writeCacheFile('bytes-1', { text: 'e'.repeat(600) }, env, 1024), true);
  assert.equal(existsSync(file), true);
});

test('a cache file of exactly the cap is written and one byte over is not', () => {
  const env = { HOME: makeTempDir('cache-exact-') };
  const value = (length) => ({ t: 'x'.repeat(length) });
  const exact = JSON.stringify(value(10)).length;
  assert.equal(writeCacheFile('cap-1', value(10), env, exact), true);
  assert.equal(writeCacheFile('cap-2', value(11), env, exact), false);
});

test('F3: a hue file an older release left goes with the board cache\'s 7-day sweep, a newer one stays until then', () => {
  const env = { HOME: makeTempDir('cache-old-hues-') };
  writeCacheFile('old-session-hues', { v: 1, items: [] }, env, 1024);
  writeCacheFile('new-session-hues', { v: 1, items: [] }, env, 1024);
  const eightDaysAgo = Date.now() / 1000 - 8 * DAY_S;
  utimesSync(join(cacheDir(env), 'old-session-hues.json'), eightDaysAgo, eightDaysAgo);
  assert.equal(writeCacheFile('next-session', { files: {} }, env, 1024), true, 'the next refresh writes its cache');
  assert.deepEqual(readdirSync(cacheDir(env)).sort(), ['new-session-hues.json', 'next-session.json']);
});

test('F2: a status line run on a 256-colour terminal writes no file to the board cache (no colour file left to share)', () => {
  const home = makeTempDir('statusline-no-hues-');
  const session = 'no-hues-session-1';
  writeSessionFile(join(home, '.claude', 'state', 'board'), session, JSON.stringify({ ...placedWriterBoard(Date.now()), session }));
  const env = cleanEnv({ HOME: home, USERPROFILE: home, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8', COLUMNS: '160', LINES: '36', NO_COLOR: '' });
  const run = spawnSync(process.execPath, [STATUSLINE], { input: JSON.stringify({ session_id: session, model: { display_name: 'Opus 5.5' } }), env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /agents/, 'the line drew the board');
  assert.equal(existsSync(cacheDir({ HOME: home })), false, 'no board-cache folder: nothing written for colours');
});
