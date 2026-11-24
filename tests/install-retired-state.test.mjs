// Tests for removeRetiredState (scripts/install/retired-state.mjs): an install removes, once, the stores the removed parts left in
// ~/.claude (recall, ask queue, estimate, done-check, ...), records each removal, never follows a link, and keeps every store of a
// kept part. HOME is a temp folder in every case (P8); the link case needs POSIX symlinks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeContext } from '../scripts/install/context.mjs';
import { RETIRED_STATE, removeRetiredState } from '../scripts/install/retired-state.mjs';
import { posix } from './disk-clean-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
// Stores of parts that stay (question popups, limits, status line, proof records): never in the list, never touched.
const KEPT_STATE = ['state/question-answered', 'state/limits', 'state/board', 'state/board-cache', 'state/ui-proof', 'state/asking', 'state/account'];

/** A temp HOME with every retired and kept store filled, the context of an install there and an empty record. */
function setup(flags = {}) {
  const home = makeTempDir('retired-state-');
  const ctx = makeContext(flags, REPO, { HOME: home });
  for (const relative of [...RETIRED_STATE, ...KEPT_STATE]) {
    mkdirSync(join(ctx.claudeDir, relative), { recursive: true });
    writeFileSync(join(ctx.claudeDir, relative, 'data.json'), '{}\n');
  }
  const record = { version: 1, repo: REPO, root: REPO, tag: null, firstLayer: null, made: [], backups: [] };
  return { home, ctx, record };
}

test('the list names only stores of removed parts, never a kept one', () => {
  for (const kept of KEPT_STATE) assert.equal(RETIRED_STATE.includes(kept), false, kept);
  for (const relative of RETIRED_STATE) assert.match(relative, /^(recall|ask|state\/[a-z-]+)$/, relative);
});

test('an install removes every retired store once, records each removal and leaves the kept stores', () => {
  const { ctx, record } = setup();
  removeRetiredState(ctx, record);
  for (const relative of RETIRED_STATE) assert.equal(existsSync(join(ctx.claudeDir, relative)), false, relative);
  for (const relative of KEPT_STATE) assert.equal(existsSync(join(ctx.claudeDir, relative, 'data.json')), true, relative);
  assert.deepEqual(record.retiredState.map((entry) => entry.path), RETIRED_STATE.map((relative) => join(ctx.claudeDir, relative)));
  removeRetiredState(ctx, record);
  assert.equal(record.retiredState.length, RETIRED_STATE.length, 'a second run finds nothing to remove');
});

test('--dry-run lists the retired stores and removes nothing', () => {
  const { ctx, record } = setup({ dryRun: true });
  removeRetiredState(ctx, record);
  for (const relative of RETIRED_STATE) assert.equal(existsSync(join(ctx.claudeDir, relative, 'data.json')), true, relative);
  assert.equal(record.retiredState, undefined);
});

test('a link at a retired path is never followed or removed', posix, () => {
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
});
