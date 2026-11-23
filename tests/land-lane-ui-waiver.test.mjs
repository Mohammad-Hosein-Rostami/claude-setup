// Tests of `land-lane --owner-waive-ui` and `git-tidy land --owner-waive-ui` with the real tools on throw-away repos (land-lane-helpers.mjs):
// a lane that changes a UI file lands without a visual-qa PASS only when the STATUS.md holds the owner's `ui-proof waiver for road <road>`
// line for the road of --close-row; without the line, for another road or with UNCONFIRMED it is exit 2 and nothing runs; without the flag
// the UI proof is exit 6 as before; every other check (here the new-file size rule) stays. The rule itself is in owner-ui-waiver.test.mjs.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { commit, git, tidy } from './git-tidy-helpers.mjs';
import { landArgs, makeWorld } from './land-lane-helpers.mjs';

const ROW = 'iceweb.s1.fe-session';
const DECISION = '- 2026-11-23 ui-proof waiver for road iceweb: web API lanes land without the screen check (owner, 2026-11-23)';
const REASON = 'API lane, owner waiver 2026-11-23';
const WAIVER_EVIDENCE = '(ui-proof waived: owner decision)';
const BIG_FILE_BYTES = 5 * 1024 * 1024 + 1; // one byte over the commit gate's MAX_NEW_FILE_BYTES (hooks/lib/new-file-size.mjs)
const firstLineOf = (result) => result.stdout.split('\n')[0];
const output = (result) => result.stdout + result.stderr;
const branches = (dir) => git(dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').sort();
const rowOf = (world) => readFileSync(world.statusFile, 'utf8').split('\n').find((line) => line.startsWith(`| ${ROW} `)) ?? '';

/** A world whose STATUS.md has the road row `ROW` open and `decisions` under `## Owner decisions`, and a lane `lane/ui` adding `file`. */
function uiLane(decisions, { file = 'page.css', text = 'body { color: red; }\n' } = {}) {
  const world = makeWorld();
  const table = `| id | item | size | started | done | evidence |\n| -- | ---- | ---- | ------- | ---- | -------- |\n| ${ROW} | build: session | S | 2026-11-22T10:00Z | - | - |`;
  writeFileSync(world.statusFile, `# STATUS\n\n## Work items\n\n${table}\n\n## Owner decisions\n${decisions.join('\n')}\n`);
  git(world.dir, 'checkout', '-q', '-b', 'lane/ui');
  if (file === 'big.bin') commit(world.dir, 'page.css', 'body { color: red; }\n');
  const tip = commit(world.dir, file, text);
  git(world.dir, 'checkout', '-q', 'main');
  return { world, tip, main: git(world.dir, 'rev-parse', 'main') };
}

/** Asserts that nothing ran: the base and the lane are where they were and the row is still open. */
function assertNothingLanded({ world, main }) {
  assert.equal(git(world.dir, 'rev-parse', 'main'), main);
  assert.ok(branches(world.dir).includes('lane/ui'));
  assert.match(rowOf(world), / - \| - \|$/);
}

test('waiver with the owner\'s line: the UI lane lands, the output says the UI proof was waived, the row evidence ends with it', () => {
  const { world, tip } = uiLane([DECISION]);
  const result = world.run(landArgs(world, 'lane/ui', tip, ['--owner-waive-ui', REASON], ROW));
  assert.equal(result.status, 0, output(result));
  assert.equal(firstLineOf(result), 'land: landed');
  assert.ok(result.stdout.split('\n').includes(`ui-proof: waived by owner decision (${REASON})`), result.stdout);
  assert.equal(git(world.dir, 'log', '-1', '--format=%s', 'main'), 'add page.css');
  const evidence = rowOf(world).split('|').at(-2).trim();
  assert.match(evidence, /^landed [0-9a-f]{40} on main from [0-9a-f]{40}/);
  assert.ok(evidence.endsWith(` ${WAIVER_EVIDENCE}`), evidence);
});

test('waiver without the owner\'s line, for another road, or UNCONFIRMED: exit 2 naming the missing line, nothing runs', () => {
  const cases = [[], [DECISION.replace('road iceweb', 'road iceplat')], [`${DECISION}: UNCONFIRMED (timeout default)`], [DECISION.replace('iceweb', 'icewebx')]];
  for (const decisions of cases) {
    const lane = uiLane(decisions);
    const result = lane.world.run(landArgs(lane.world, 'lane/ui', lane.tip, ['--owner-waive-ui', REASON], ROW));
    assert.equal(result.status, 2, output(result));
    assert.equal(firstLineOf(result), 'land: usage');
    assert.match(result.stdout, /needs a line with "ui-proof waiver for road iceweb"/);
    assertNothingLanded(lane);
  }
});

test('no flag: the UI proof stays on (exit 6) even when the owner\'s line is there', () => {
  const lane = uiLane([DECISION]);
  const result = lane.world.run(landArgs(lane.world, 'lane/ui', lane.tip, [], ROW));
  assert.equal(result.status, 6, output(result));
  assert.equal(firstLineOf(result), 'land: ui-proof');
  assertNothingLanded(lane);
});

test('waiver: a bad reason or a close row that is no road row is exit 2', () => {
  const lane = uiLane([DECISION]);
  for (const reason of ['', 'x'.repeat(201), 'a\tb']) {
    assert.equal(lane.world.run(landArgs(lane.world, 'lane/ui', lane.tip, ['--owner-waive-ui', reason], ROW)).status, 2, JSON.stringify(reason));
  }
  const notRoad = lane.world.run(landArgs(lane.world, 'lane/ui', lane.tip, ['--owner-waive-ui', REASON], 'close:1'));
  assert.equal(notRoad.status, 2, output(notRoad));
  assert.match(notRoad.stdout, /needs a road lane row/);
  assertNothingLanded(lane);
});

test('waiver: every other check stays: a new file over the size limit is still exit 7', () => {
  const lane = uiLane([DECISION], { file: 'big.bin', text: 'x'.repeat(BIG_FILE_BYTES) });
  const result = lane.world.run(landArgs(lane.world, 'lane/ui', lane.tip, ['--owner-waive-ui', REASON], ROW));
  assert.equal(result.status, 7, output(result));
  assertNothingLanded(lane);
});

// ---- git-tidy land itself: it checks the owner's line again, so a direct call cannot skip it ----

const tidyLand = ({ world, tip }, extra) => tidy(['land', 'lane/ui', world.dir, '--tip', tip, ...extra], { cwd: world.dir, env: world.env });
const waiverFlags = (world, road = 'iceweb') => ['--owner-waive-ui', REASON, '--status-file', world.statusFile, '--road', road];

test('git-tidy land --owner-waive-ui: lands with the owner\'s line and prints the waiver; without it exit 2; no flag exit 6', () => {
  const plain = uiLane([DECISION]);
  assert.equal(tidyLand(plain, []).status, 6);
  assert.equal(tidyLand(plain, waiverFlags(plain.world, 'iceplat')).status, 2);
  assertNothingLanded(plain);
  const landed = tidyLand(plain, waiverFlags(plain.world));
  assert.equal(landed.status, 0, output(landed));
  assert.ok(landed.stdout.split('\n').includes(`ui-proof: waived by owner decision (${REASON})`), landed.stdout);
  const json = uiLane([DECISION]);
  assert.equal(JSON.parse(tidyLand(json, [...waiverFlags(json.world), '--json']).stdout).uiWaived, REASON);
});

test('git-tidy land --owner-waive-ui: the three flags go together, never with --rebase-only, and need an absolute STATUS.md', () => {
  const lane = uiLane([DECISION]);
  const flags = waiverFlags(lane.world);
  for (const extra of [flags.slice(0, 2), flags.slice(0, 4), flags.slice(2), [...flags, '--rebase-only'], [...flags.slice(0, 3), 'STATUS.md', ...flags.slice(4)]]) {
    const result = tidyLand(lane, extra);
    assert.equal(result.status, 2, `${extra.join(' ')}\n${output(result)}`);
  }
  assertNothingLanded(lane);
});
