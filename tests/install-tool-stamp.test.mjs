// Tests of the tool install stamp (scripts/install/tools.mjs, spec 21): `<lockfile sha256>:<Node ABI>`, so a Node upgrade that
// changes the ABI reinstalls a tool's native modules once, and an old stamp without `:` counts as stale. Exports: none (node:test
// file). Each case is a --dry-run on a fake checkout in a temp folder, so nothing is installed and no real state is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installStamp, installToolDeps } from '../scripts/install/tools.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

/** A fake checkout with one npm tool `demo`, its lockfile and, when given, the stamp of an earlier install. */
function checkout(stamp) {
  const root = makeTempDir('install-stamp-');
  const tool = join(root, 'home', 'tools', 'demo');
  mkdirSync(join(tool, 'node_modules'), { recursive: true });
  writeFileSync(join(tool, 'package-lock.json'), '{"lockfileVersion":3}');
  const lockHash = createHash('sha256').update(readFileSync(join(tool, 'package-lock.json'))).digest('hex');
  if (stamp) writeFileSync(join(tool, 'node_modules', '.lock-sha256'), stamp(lockHash));
  return { root, tool: realpathSync(tool) };
}

/** Runs the tool step under --dry-run and returns its notes and its printed lines. */
function dryRun(root) {
  const ctx = { root, dryRun: true, done: [] };
  const printed = [];
  const log = console.log;
  console.log = (line) => printed.push(String(line));
  try {
    installToolDeps(ctx, ['demo']);
  } finally {
    console.log = log;
  }
  return { notes: ctx.done, printed };
}

test('the stamp is the lockfile hash, a colon and this Node ABI', () => {
  const { tool } = checkout(null);
  const hash = createHash('sha256').update(readFileSync(join(tool, 'package-lock.json'))).digest('hex');
  assert.equal(installStamp(join(tool, 'package-lock.json')), `${hash}:${process.versions.modules}`);
});

test('the same lockfile and ABI skip the install', () => {
  const { root } = checkout((hash) => `${hash}:${process.versions.modules}`);
  const { notes, printed } = dryRun(root);
  assert.deepEqual(notes, ['ok demo dependencies (lockfile and Node ABI unchanged)']);
  assert.ok(!printed.some((line) => line.startsWith('[dry-run] npm')));
});

for (const [name, stamp] of [['another ABI', (hash) => `${hash}:1`], ['an old stamp without ":"', (hash) => hash], ['another lockfile', () => `0:${process.versions.modules}`]]) {
  test(`${name} reinstalls with npm ci`, () => {
    const { root, tool } = checkout(stamp);
    const { notes, printed } = dryRun(root);
    assert.ok(printed.includes(`[dry-run] npm ci --prefix ${tool}`), printed.join('\n'));
    assert.deepEqual(notes, ['demo dependencies']);
  });
}
