// Tests for removeRetiredState (scripts/install/retired-state.mjs): an install moves, once, the stores the removed parts left in
// ~/.claude (recall, ask queue, estimate, done-check, stop-blocks, ...) into the install backup folder, never deletes them,
// records each move, never follows a link, and keeps every store of a kept part and Claude Code's own ~/.claude/jobs.
// HOME is a temp folder in every case (P8), with a space in its name; the link case needs POSIX symlinks. The last cases run the
// real installer there (--no-plugins --no-tools), which needs jq.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeContext } from '../scripts/install/context.mjs';
import { RECORD_NAME } from '../scripts/install/record.mjs';
import { RETIRED_STATE, removeRetiredState } from '../scripts/install/retired-state.mjs';
import { posix } from './disk-clean-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { cleanEnv } from './clean-env.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const INSTALLER = join(REPO, 'scripts', 'install.mjs');
// Stores of parts that stay (limits, status line, proof records) and Claude Code's own jobs: never listed or touched.
const KEPT_STATE = ['state/limits', 'state/board', 'state/board-cache', 'state/ui-proof', 'state/account', 'jobs'];
const STORE_TEXT = '{}\n';

/** Puts a store at `path`: a file when the name ends in .json, else a folder holding data.json. */
function fillStore(path) {
  if (path.endsWith('.json')) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, STORE_TEXT);
    return;
  }
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'data.json'), STORE_TEXT);
}

/** A temp HOME (a space in its path) with every retired and kept store filled, the context of an install there and an empty record. */
function setup(flags = {}) {
  const home = makeTempDir('retired state ');
  const ctx = makeContext(flags, REPO, { HOME: home });
  for (const relativePath of [...RETIRED_STATE, ...KEPT_STATE]) fillStore(join(ctx.claudeDir, relativePath));
  const record = { version: 1, repo: REPO, root: REPO, tag: null, firstLayer: null, made: [], backups: [] };
  return { home, ctx, record };
}

/** The path a store has inside the backup folder (backup() keeps its place under HOME). */
const savedPath = (ctx, relativePath) => join(ctx.backupDir, relative(ctx.home, join(ctx.claudeDir, relativePath)));

test('the list names only stores of removed parts, never a kept one or Claude Code\'s jobs', () => {
  for (const kept of KEPT_STATE) assert.equal(RETIRED_STATE.includes(kept), false, kept);
  for (const relativePath of RETIRED_STATE) assert.match(relativePath, /^(recall|ask|state\/[a-z-]+(\.json)?|logs\/\.?guard[.a-z0-9-]*)$/, relativePath);
  for (const added of ['state/stop-blocks', 'state/budget-denied', 'state/mcp-discover-verdicts.json', 'state/question-answered', 'state/asking', 'state/guard-allowed', 'logs/guard.jsonl']) assert.ok(RETIRED_STATE.includes(added), added);
});

test('an install moves every retired store into the backup folder once, records each move and leaves the kept stores', () => {
  const { ctx, record } = setup();
  removeRetiredState(ctx, record);
  for (const relativePath of RETIRED_STATE) {
    assert.equal(existsSync(join(ctx.claudeDir, relativePath)), false, `${relativePath} left ~/.claude`);
    const saved = savedPath(ctx, relativePath);
    const savedFile = relativePath.endsWith('.json') ? saved : join(saved, 'data.json');
    assert.equal(readFileSync(savedFile, 'utf8'), STORE_TEXT, `${relativePath} is kept in the backup folder`);
  }
  for (const relativePath of KEPT_STATE) assert.equal(existsSync(join(ctx.claudeDir, relativePath, 'data.json')), true, relativePath);
  const paths = RETIRED_STATE.map((relativePath) => join(ctx.claudeDir, relativePath));
  assert.deepEqual(record.retiredState.map((entry) => entry.path), paths);
  assert.deepEqual(record.retiredState.map((entry) => entry.backup), RETIRED_STATE.map((relativePath) => savedPath(ctx, relativePath)));
  assert.deepEqual(record.backups.map((entry) => [entry.path, entry.backupRoot, entry.ours]), paths.map((path) => [path, ctx.backupDir, false]));
  removeRetiredState(ctx, record);
  assert.equal(record.retiredState.length, RETIRED_STATE.length, 'a second run finds nothing to move');
  assert.equal(record.backups.length, RETIRED_STATE.length, 'a second run backs up nothing');
});

test('--dry-run lists the retired stores and moves nothing', () => {
  const { home, ctx, record } = setup({ dryRun: true });
  const printed = [];
  const log = console.log;
  console.log = (line) => printed.push(String(line));
  try {
    removeRetiredState(ctx, record);
  } finally {
    console.log = log;
  }
  for (const relativePath of RETIRED_STATE) {
    assert.equal(existsSync(join(ctx.claudeDir, relativePath)), true, relativePath);
    assert.ok(printed.some((line) => line.startsWith(`[dry-run] move ${join(ctx.claudeDir, relativePath)} to `)), relativePath);
  }
  assert.equal(record.retiredState, undefined);
  assert.deepEqual(record.backups, []);
  assert.deepEqual(readdirSync(home), ['.claude'], 'no backup folder');
});

test('a link at a retired path is never followed or moved', posix, () => {
  const { home, ctx, record } = setup();
  const outside = join(home, 'owner-data');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep.txt'), 'owner\n');
  const recall = join(ctx.claudeDir, 'recall');
  removeRetiredState(ctx, record);
  symlinkSync(outside, recall, 'dir');
  removeRetiredState(ctx, record);
  assert.equal(existsSync(recall), true, 'the link stays');
  assert.equal(existsSync(join(outside, 'keep.txt')), true, 'its target is untouched');
  assert.equal(record.retiredState.length, RETIRED_STATE.length, 'the link is not recorded as moved');
});

test('the installer moves state/stop-blocks into the backup folder and records it; a second --dry-run prints no action', () => {
  const home = makeTempDir('retired state install ');
  const env = cleanEnv({ HOME: home, USERPROFILE: home });
  const claudeDir = join(home, '.claude');
  const store = join(claudeDir, 'state', 'stop-blocks');
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, 'x'), 'blocks\n');
  mkdirSync(join(claudeDir, 'jobs'));
  writeFileSync(join(claudeDir, 'jobs', 'job.json'), STORE_TEXT);
  const install = spawnSync(process.execPath, [INSTALLER, '--no-plugins', '--no-tools'], { env, encoding: 'utf8' });
  assert.equal(install.status, 0, install.stderr);
  assert.equal(existsSync(store), false, 'the store left ~/.claude');
  const backups = readdirSync(home).filter((name) => name.startsWith('.claude-backup-'));
  assert.equal(backups.length, 1, readdirSync(home).join(', '));
  const saved = join(home, backups[0], '.claude', 'state', 'stop-blocks');
  assert.equal(readFileSync(join(saved, 'x'), 'utf8'), 'blocks\n', 'the store is in the backup folder');
  assert.equal(readFileSync(join(claudeDir, 'jobs', 'job.json'), 'utf8'), STORE_TEXT, 'Claude Code\'s jobs stay');
  const record = JSON.parse(readFileSync(join(claudeDir, RECORD_NAME), 'utf8'));
  assert.deepEqual(record.retiredState.map((entry) => [entry.path, entry.backup]), [[store, saved]]);
  assert.ok(record.backups.some((entry) => entry.path === store && entry.backup === saved), 'named in the backups --uninstall reads');
  const again = spawnSync(process.execPath, [INSTALLER, '--dry-run', '--no-plugins', '--no-tools'], { env, encoding: 'utf8' });
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(again.stdout.split('\n').filter((line) => line.startsWith('[dry-run] ')), [], again.stdout);
});

test('install then --uninstall puts a moved store back where it was', () => {
  const home = makeTempDir('retired state uninstall ');
  const env = cleanEnv({ HOME: home, USERPROFILE: home });
  const verdicts = join(home, '.claude', 'state', 'mcp-discover-verdicts.json');
  fillStore(verdicts);
  const install = spawnSync(process.execPath, [INSTALLER, '--no-plugins', '--no-tools'], { env, encoding: 'utf8' });
  assert.equal(install.status, 0, install.stderr);
  assert.equal(existsSync(verdicts), false);
  const uninstall = spawnSync(process.execPath, [INSTALLER, '--uninstall'], { env, encoding: 'utf8' });
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.equal(readFileSync(verdicts, 'utf8'), STORE_TEXT);
});
