// Tests of what review-tier checks of its own packs (lane r7-delta, fix round 6, security S10, spec check K3): a process of the same user
// that swaps, adds or removes pack files in the tool's temp repository while the tool runs. Each case is the security review's p37 made
// deterministic: the recording git (spyGit, SPY_PACK) acts at a fixed call instead of racing the tool; fix round 7 (R7-1, S11) adds the
// changes that only ctime shows (an in-place rewrite with the mtime put back, a rename aside and back). The lane is p37's: the fix turns a
// guard into an `execSync` call (security class, tier 2); the forged packs serve the guard's text under the fix's blob name (tier 1).
// POSIX only (the spy is a `#!` script).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CLEAN_ENV, git } from './git-tidy-helpers.mjs';
import { packOf, renameIndexEntry, spiedRun } from './review-tier-forgery-helpers.mjs';
import { lane, priorFile, sha256Of } from './review-tier-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const POSIX_ONLY = { skip: process.platform === 'win32' && 'the recording git is a `#!` script' };
const GUARD = "export function decide(cmd) {\n  if (cmd.includes(';')) return 'deny';\n  return 'allow';\n}\n";
const NO_GUARD = "export function decide(cmd) {\n  return 'allow';\n}\n";
const EXEC = "import { execSync } from 'node:child_process';\nexport function decide(cmd) {\n  if (cmd.includes(';')) return 'deny';\n  execSync(cmd);\n  return 'allow';\n}\n";
const CHANGED = /the tool's own temp repository changed during the run/;
const FANOUT_END = 8 + 255 * 4; // a version-2 pack index: magic, version, then 256 counts; the last one is the number of objects
const OIDS_AT = 8 + 256 * 4;
const TRAILER_BYTES = 20;
const WHOLE_SECOND = 1_767_225_600; // 2026-01-01T00:00:00Z: an mtime with no sub-second digits, which utimes puts back to the nanosecond
const FACTS_PUT_BACK = ['dev', 'ino', 'size', 'mtimeNs'];

/** A reverse index (`.rev`, gitformat-pack) for a version-2 `.idx` with 32-bit offsets: index positions in pack order. */
function writeReverseIndex(name) {
  const index = readFileSync(`${name}.idx`);
  const count = index.readUInt32BE(FANOUT_END);
  const offsetOf = (at) => index.readUInt32BE(OIDS_AT + count * 24 + at * 4);
  const positions = Array.from({ length: count }, (_, at) => at).sort((a, b) => offsetOf(a) - offsetOf(b));
  const body = Buffer.alloc(12 + count * 4 + TRAILER_BYTES);
  body.write('RIDX', 0, 'latin1');
  body.writeUInt32BE(1, 4);
  body.writeUInt32BE(1, 8);
  positions.forEach((position, at) => body.writeUInt32BE(position, 12 + at * 4));
  index.copy(body, 12 + count * 4, index.length - 2 * TRAILER_BYTES, index.length - TRAILER_BYTES);
  writeFileSync(`${name}.rev`, Buffer.concat([body, createHash('sha1').update(body).digest()]));
}

/** Points the entry `oid` of a version-2 `.idx` (32-bit offsets) at the bytes of the entry `other` of the same pack (advice A2's forgery). */
function pointIndexEntry(file, oid, other) {
  const index = Buffer.from(readFileSync(file));
  const count = index.readUInt32BE(FANOUT_END);
  const positionOf = (wanted) => Array.from({ length: count }, (_, at) => index.toString('hex', OIDS_AT + at * 20, OIDS_AT + at * 20 + 20)).indexOf(wanted);
  const [to, from] = [positionOf(oid), positionOf(other)];
  for (const column of [count * 20, count * 24]) index.copy(index, OIDS_AT + column + to * 4, OIDS_AT + column + from * 4, OIDS_AT + column + from * 4 + 4);
  createHash('sha1').update(index.subarray(0, index.length - TRAILER_BYTES)).digest().copy(index, index.length - TRAILER_BYTES);
  chmodSync(file, 0o644);
  writeFileSync(file, index);
}

/** From the spy's log: the target file of SPY_PACK step `step` has the same dev, inode, size and mtime after it as before it; only ctime moved. */
function assertOnlyCtimeMoved(facts, step, label) {
  const [before, after] = ['before', 'after'].map((when) => facts.find((row) => row.step === step && row.when === when));
  assert.ok(before?.ino !== undefined && after?.ino !== undefined, `${label}: the step ran on the file: ${JSON.stringify(facts)}`);
  for (const field of FACTS_PUT_BACK) assert.equal(after[field], before[field], `${label}: ${field} is the same`);
  assert.notEqual(after.ctimeNs, before.ctimeNs, `${label}: ctime moved`);
}

/** p37's lane, its fix round and the oids the forgeries need. */
function raceLane() {
  const made = lane();
  git(made.dir, 'checkout', '-q', 'main');
  made.write('a.txt', 'a0\n');
  made.write('src/run.mjs', "import { decide } from './gate.mjs';\nexport const run = (c) => decide(c);\n");
  const start = made.write('src/gate.mjs', NO_GUARD);
  git(made.dir, 'checkout', '-q', '-B', 'lane');
  made.write('a.txt', 'a1\n');
  const reviewed = made.write('src/gate.mjs', GUARD);
  made.write('a.txt', 'a2\n');
  const head = made.write('src/gate.mjs', EXEC);
  const prior = priorFile();
  const fixRound = ['--delta', reviewed, '--base', start, '--prior', prior, '--prior-sha256', sha256Of(prior), '--lane-classes', 'logic,docs', '--json'];
  const oid = (name) => git(made.dir, 'rev-parse', name);
  const stored = (text) => spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: made.dir, input: text, encoding: 'utf8', env: CLEAN_ENV }).stdout.trim();
  return { ...made, fixRound, head, oid, stored, spied: (more) => spiedRun(made.dir, made.log, fixRound, more) };
}

/** A folder holding one full forged pack (`.pack`, `.idx`, `.rev`): every tree and file of the lane, the fix's blob serving `text`. */
function fullForgery(made, text) {
  const fixBlob = made.oid(`${made.head}:src/gate.mjs`);
  const listed = git(made.dir, 'rev-list', '--objects', made.head).split('\n').map((line) => line.slice(0, 40));
  const objects = listed.filter((oid) => oid !== fixBlob && git(made.dir, 'cat-file', '-t', oid) !== 'commit');
  const lure = made.stored(text);
  const name = packOf(made.dir, [...objects, lure], realpathSync(makeTempDir('review-tier-forged-')));
  renameIndexEntry(`${name}.idx`, lure, fixBlob);
  writeReverseIndex(name);
  return join(name, '..');
}

/** Exit 2 with the run's own message, no report, and the temp repository removed. */
function assertStopped({ result, trusted }, said, label) {
  assert.equal(result.status, 2, `${label}: ${result.stderr}`);
  assert.equal(result.stdout, '', label);
  assert.match(result.stderr, said, label);
  assert.ok(!existsSync(trusted[0].env.GIT_DIR), `${label}: the temp repository is removed`);
}

test('the control: with no other process the fix round of the lane is read as it is (tier 2, security), and every pack check passes', POSIX_ONLY, () => {
  const { result } = raceLane().spied({});
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.ok(report.classes.includes('security') && report.tier >= 2, result.stdout);
});

test('spec check K3 (a): a full forged pack renamed over the phase-2 pack right after git index-pack, before the tool notes it, is exit 2, never tier 1', POSIX_ONLY, () => {
  const made = raceLane();
  const from = fullForgery(made, `${GUARD}// x\n`);
  assertStopped(made.spied({ SPY_PACK: JSON.stringify({ word: 'index-pack', nth: 2, action: 'swap', from }) }), CHANGED, 'swap before the note');
});

test('spec check K3 (b): an .idx that points the fix\'s blob at the bytes of another file in the same pack, renamed over the noted one after the closure check, before any read, is exit 2', POSIX_ONLY, () => {
  const made = raceLane();
  const copied = realpathSync(makeTempDir('review-tier-phase-'));
  const control = made.spied({ SPY_PACK: JSON.stringify({ word: 'index-pack', nth: 2, action: 'copy', to: copied }) });
  assert.equal(control.result.status, 0, control.result.stderr);
  const from = realpathSync(makeTempDir('review-tier-forged-'));
  copyFileSync(join(copied, 'phase.idx'), join(from, 'phase.idx'));
  pointIndexEntry(join(from, 'phase.idx'), made.oid(`${made.head}:src/gate.mjs`), made.oid(`${made.head}:a.txt`));
  assertStopped(made.spied({ SPY_PACK: JSON.stringify({ word: '--batch-check', nth: 1, action: 'swap', from }) }), CHANGED, 'swap of the index after the note');
});

test('review R7-1, security S11: the noted .idx rewritten in place (forged bytes of the same size) with its whole-second mtime put back keeps every noted fact but ctime, and the run is exit 2', POSIX_ONLY, () => {
  const made = raceLane();
  const copied = realpathSync(makeTempDir('review-tier-phase-'));
  const control = made.spied({ SPY_PACK: JSON.stringify({ word: 'index-pack', nth: 2, action: 'copy', to: copied }) });
  assert.equal(control.result.status, 0, control.result.stderr);
  const forged = join(realpathSync(makeTempDir('review-tier-forged-')), 'phase.idx');
  copyFileSync(join(copied, 'phase.idx'), forged);
  pointIndexEntry(forged, made.oid(`${made.head}:src/gate.mjs`), made.oid(`${made.head}:a.txt`));
  const steps = [
    { word: 'index-pack', nth: 2, action: 'mtime', ext: 'idx', mtime: WHOLE_SECOND }, // before the note: the noted mtime has no sub-second digits
    { word: '--batch-check', nth: 1, action: 'rewrite', ext: 'idx', from: forged, mtime: WHOLE_SECOND },
  ];
  const run = made.spied({ SPY_PACK: JSON.stringify(steps) });
  assertOnlyCtimeMoved(run.facts, 1, 'the .idx rewritten in place');
  assertStopped(run, /\.idx is gone or is not the file git index-pack wrote/, 'the .idx rewritten in place');
});

test('security S11 (p48): a noted .idx or .pack renamed aside, another file of its size written under its name and the first one renamed back keeps every noted fact but ctime, and the run is exit 2', POSIX_ONLY, async (t) => {
  const made = raceLane();
  for (const ext of ['idx', 'pack']) {
    await t.test(`.${ext}`, () => {
      const run = made.spied({ SPY_PACK: JSON.stringify([{ word: '--batch-check', nth: 1, action: 'renameBack', ext }]) });
      assertOnlyCtimeMoved(run.facts, 0, `.${ext}`);
      assertStopped(run, new RegExp(`\\.${ext} is gone or is not the file git index-pack wrote`), `.${ext} renamed back`);
    });
  }
});

test('spec check K3 (c): a full forged pack added after the closure check, before any read, is exit 2 at the last check', POSIX_ONLY, () => {
  const made = raceLane();
  const from = fullForgery(made, `${GUARD}// x\n`);
  assertStopped(made.spied({ SPY_PACK: JSON.stringify({ word: '--batch-check', nth: 1, action: 'add', from }) }), /the tool's own temp repository holds objects\/pack\/pack-/, 'a pack added');
});

test('spec check K3 (d): a noted .rev removed after the second import is exit 2, and so is one gone before the tool notes it', POSIX_ONLY, () => {
  const made = raceLane();
  assertStopped(made.spied({ SPY_PACK: JSON.stringify({ word: '--batch-check', nth: 1, action: 'remove', ext: 'rev' }) }), /\.rev is gone or is not the file git index-pack wrote/, 'a noted .rev removed');
  assertStopped(made.spied({ SPY_PACK: JSON.stringify({ word: 'index-pack', nth: 2, action: 'remove', ext: 'rev' }) }), /\.rev is not there right after git index-pack/, 'a .rev removed before the note');
});

test('spec check K3, advice A1: git index-pack fed another pack than the one the tool wrote is exit 2 naming the pack, before anything is read', POSIX_ONLY, () => {
  const made = raceLane();
  const folder = fullForgery(made, `${GUARD}// x\n`);
  const from = join(folder, readdirSync(folder).find((file) => file.endsWith('.pack')));
  assertStopped(made.spied({ SPY_PACK: JSON.stringify({ word: 'index-pack', nth: 2, action: 'feed', from }) }), /git index-pack named the pack .* this run wrote/, 'another pack fed');
});
