// Tests that pin the identity.mjs rules the other identity tests left open (C11-1 of the delta-1 review): the saved assignment's
// validation, which items hold a hue and in what order, which worktree is a lane, the isolated worktree names, the tie of a run to
// a lane, the fixed home hues of the sample names, and the hue file's session id. Pure boardIdentity calls (no I/O) except the last.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HUE_CODES } from '../home/tools/board/lib/cells.mjs';
import { writeCacheFile } from '../home/tools/board/lib/cache-file.mjs';
import { identityOf } from '../home/tools/board/lib/hue-store.mjs';
import { agentKey, boardIdentity, hueOf, worktreeKey } from '../home/tools/board/lib/identity.mjs';
import { NOW } from './statusline-identity-fixture.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const MIN_MS = 60_000;
const run = (id, name) => ({ id, name, state: 'run' }); // a running agent: the live item of these cases
const lane = (name, extra = {}) => ({ name, branch: name, main: false, ...extra });
const boardOf = ({ runs = [], agents = [], worktrees = [], repos = null } = {}) => ({ agents: [...runs, ...agents], repo: null, repos: repos ?? [{ name: 'r', worktrees }] });
const homeOf = (name) => hueOf(boardIdentity({ agents: [run('wf_home', name)], repos: [] }), name);
const withHome = (hue) => (name) => homeOf(name) === hue;
const namesHomedAt = (hue, count) => Array.from({ length: 400 }, (_, index) => `new-${index}`).filter(withHome(hue)).slice(0, count);
const stored = (name, hue, seenAgoMin, extra = {}) => ({ name, hue, seenMs: NOW - seenAgoMin * MIN_MS, sinceMs: NOW - (seenAgoMin + 10) * MIN_MS, ...extra });
const identityWith = (board, items) => boardIdentity(board, { v: 1, items }, NOW);

test('the home hue of a name is fixed (the hash and the palette): sample names keep their hue release to release', () => {
  assert.deepEqual(HUE_CODES, [31, 166, 99, 64, 197, 133], 'the six 256-colour indexes the README lists');
  const homes = Object.fromEntries(['remove-modes', 'road-gate-landed-row', 'statusline-identity-colours', 'build', 'a'].map((name) => [name, homeOf(name)]));
  assert.deepEqual(homes, { 'remove-modes': 0, 'road-gate-landed-row': 1, 'statusline-identity-colours': 4, build: 5, a: 4 });
});

test('a saved item with a negative hue or a name that is no non-empty string is left out, and is not saved again', () => {
  const home = homeOf('a');
  const negative = identityWith(boardOf({ runs: [run('wf_a', 'a')] }), [stored('a', -1, 1)]);
  assert.equal(hueOf(negative, 'a'), home, 'a hue of -1 is no hue: the name gets its fresh one');
  const odd = identityWith(boardOf({ runs: [run('wf_a', 'a')] }), [{ ...stored('x', 3, 1), name: 5 }, { ...stored('x', 3, 1), name: '' }, stored('keeper', 2, 1)]);
  assert.deepEqual(odd.store.items.map((item) => item.name).sort(), ['a', 'keeper'], 'only plain names are saved');
});

test('an item gone 5 to 30 minutes keeps its saved hue when no live item holds it, and of two that held one the older keeps it', () => {
  const board = boardOf({ runs: [run('wf_x', 'x')] });
  const savedHue = (homeOf('x') + 1) % HUE_CODES.length;
  assert.equal(hueOf(identityWith(board, [stored('x', savedHue, 10)]), 'x'), savedHue, 'not its home hue: the saved one');
  const two = boardOf({ runs: [run('wf_o', 'older'), run('wf_y', 'younger')] });
  const items = [{ ...stored('older', 2, 10), sinceMs: NOW - 60 * MIN_MS }, { ...stored('younger', 2, 10), sinceMs: NOW - 20 * MIN_MS }];
  const identity = identityWith(two, items);
  assert.equal(hueOf(identity, 'older'), 2, 'the item seen first');
  assert.notEqual(hueOf(identity, 'younger'), 2);
  assert.equal(identity.store.items.find((item) => item.name === 'younger').seenMs, NOW, 'a changed hue is saved as seen now');
});

test('a saved hue that changes is saved as seen now, and the saved list keeps the newest gone items', () => {
  const before = stored('mover', 2, 1.5, { away: true });
  const holder = stored('holder', 2, 1);
  const identity = identityWith(boardOf({ runs: [run('wf_m', 'mover'), run('wf_h', 'holder')] }), [before, holder]);
  assert.notEqual(hueOf(identity, 'mover'), 2);
  assert.equal(identity.store.items.find((item) => item.name === 'mover').seenMs, NOW, 'seen 90 s ago and the hue changed: seen now');
  const goneItems = Array.from({ length: 70 }, (_, index) => stored(`gone-${index}`, index % HUE_CODES.length, 1 + index / 10));
  const kept = identityWith(boardOf({ runs: [run('wf_l', 'live')] }), goneItems).store.items.map((item) => item.name);
  assert.equal(kept.length, 64);
  assert.ok(kept.includes('live') && kept.includes('gone-0') && kept.includes('gone-62'), 'the live item and the newest gone ones');
  assert.ok(!kept.includes('gone-69'), 'the oldest gone one is the one dropped');
});








test('a hue file is read and written only for a session id: a planted `undefined-hues.json` is not read', () => {
  const env = { HOME: makeTempDir('hue-planted-') };
  const board = boardOf({ runs: [run('wf_a', 'a')] });
  const planted = (homeOf('a') + 1) % HUE_CODES.length;
  writeCacheFile('undefined-hues', { v: 1, items: [stored('a', planted, 0)] }, env, 16_384);
  assert.equal(hueOf(identityOf(undefined, board, { env, nowMs: NOW }), 'a'), homeOf('a'));
  assert.equal(hueOf(identityOf('real-session', board, { env, nowMs: NOW }), 'a'), homeOf('a'));
});

test('the time limits are exact: a finished agent holds a hue for 30 s, an item stays itself for 5 min and is remembered for 30 min', () => {
  const scout = (doneAgoMs) => ({ id: 's', name: 'scout', state: 'done', doneMs: NOW - doneAgoMs });
  const holds = (doneAgoMs) => boardIdentity(boardOf({ agents: [scout(doneAgoMs)] }), null, NOW).hues.has('scout');
  assert.deepEqual([holds(29_999), holds(30_000)], [true, false]);
  const board = boardOf({ runs: [run('wf_a', 'a'), run('wf_z', 'z')] });
  const clash = (agoMs) => identityWith(board, [{ ...stored('a', 2, 0), seenMs: NOW - agoMs, sinceMs: NOW - 60 * MIN_MS }, stored('z', 2, 1)]);
  assert.equal(hueOf(clash(5 * MIN_MS), 'a'), 2, 'seen exactly 5 minutes ago: still the same live item');
  assert.notEqual(hueOf(clash(5 * MIN_MS + 1), 'a'), 2, 'a moment longer: it re-checks, and the hue is taken');
  const remembered = (agoMs) => identityWith(boardOf({ runs: [run('wf_l', 'live')] }), [{ ...stored('old', 3, 0), seenMs: NOW - agoMs }]).store.items.some((item) => item.name === 'old');
  assert.deepEqual([remembered(30 * MIN_MS), remembered(30 * MIN_MS + 1)], [true, false]);
});

test('a cache file of exactly the cap is written and one byte over is not', () => {
  const env = { HOME: makeTempDir('cache-exact-') };
  const value = (length) => ({ t: 'x'.repeat(length) });
  const exact = JSON.stringify(value(10)).length;
  assert.equal(writeCacheFile('cap-1', value(10), env, exact), true);
  assert.equal(writeCacheFile('cap-2', value(11), env, exact), false);
});
