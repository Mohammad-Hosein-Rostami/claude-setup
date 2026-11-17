// Round 5 lane D checks: every principle id that review-tier can hand to a brief exists in the principle table, and the workflows
// README names the round 5 behaviour (waiver, audit mode, contract, join lists, audit stage, `red`, bugfix without a tier arg).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PRINCIPLES_BY_TRIGGER } from '../home/tools/review-tier/tiers.mjs';

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
const ID_COLUMN = /^(P\d+) \|/;

/** The ids in the first column of home/rules/principles.md. */
function tableIds() {
  return new Set(read('home/rules/principles.md').split('\n').map((line) => ID_COLUMN.exec(line)?.[1]).filter(Boolean));
}

test('every id in PRINCIPLES_BY_TRIGGER has a row in principles.md', () => {
  const known = tableIds();
  for (const [trigger, ids] of Object.entries(PRINCIPLES_BY_TRIGGER)) {
    assert.ok(ids.length > 0, `trigger ${trigger} names no principle`);
    for (const id of ids) assert.ok(known.has(id), `trigger ${trigger} names ${id}, which principles.md does not define`);
  }
});

test('the check reads real data: the table has rows and a missing id is caught', () => {
  const known = tableIds();
  assert.ok(known.size >= 13);
  assert.ok(!known.has('P999'));
});

/** The text of one README section, from its `## ` heading to the next one. */
function readmeSection(title) {
  const text = read('home/workflows/README.md');
  const start = text.indexOf(`## ${title}`);
  assert.notEqual(start, -1, `README has no "## ${title}" section`);
  const next = text.indexOf('\n## ', start + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

test('README: review documents waiverAt, audit mode, principles and baseSha', () => {
  const section = readmeSection('Round 5: contracts, waiver and audit');
  for (const needle of ['waiverAt', 'audit: {base, tip}', 'baseSha', 'principles', 'full set when the range is no longer waivable', 'failed']) {
    assert.ok(section.includes(needle), `review part misses "${needle}"`);
  }
});

test('README: build documents the contract, join lists, audit stage and statuses', () => {
  const section = readmeSection('Round 5: contracts, waiver and audit');
  for (const needle of ['appendOnly', 'checkpoints', 'vacuous', 'outOfScope', 'contractTouched', 'auditLane', 'contract-touched', 'audit-findings', 'audit-error', 'audit-log gate']) {
    assert.ok(section.includes(needle), `build part misses "${needle}"`);
  }
});

test('README: land documents `red` and bugfix documents that it takes no tier', () => {
  const section = readmeSection('Round 5: contracts, waiver and audit');
  assert.match(section, /`red`/);
  assert.match(section, /bugfix[^\n]*no `tier`|no `tier`[^\n]*bugfix/i);
});

test('README: the args table lists the round 5 args', () => {
  const text = read('home/workflows/README.md');
  for (const needle of ['waiverAt?', 'principles?', 'audit?', 'appendOnly?', 'checkpoints?']) {
    assert.ok(text.includes(needle), `args table misses ${needle}`);
  }
});

test('README: the older land and build bullets name `red` too', () => {
  const text = read('home/workflows/README.md');
  const bulletStartingWith = (start) => text.slice(text.indexOf(start)).split('\n- ')[0];
  const landBullet = bulletStartingWith('- `land` first checks');
  const buildBullet = bulletStartingWith('- `build` runs lanes as a pipeline');
  assert.match(landBullet, /`red`/, 'the land results list misses `red`');
  assert.match(buildBullet, /`red`/, 'the build re-review sentence misses `red`');
});

test('README: red is fixed differently in build and bugfix, and the waiver and gate exceptions are stated', () => {
  const section = readmeSection('Round 5: contracts, waiver and audit');
  assert.match(section, /initialFindings[^\n]*fix agent|fix agent[^\n]*initialFindings/, 'build path of red is not stated');
  assert.match(section, /`waiverAt` is the joined sha[\s\S]*?no `contract-dispute`/, 'waiverAt does not mention contract-dispute');
  assert.match(section, /record --state pending` itself fails[^\n]*holds nothing/, 'pending-record failure exception is missing');
});

test('README: waivable conditions match review.js (non-empty waivable.reviews; a missing audit set gets the full set)', () => {
  const section = readmeSection('Round 5: contracts, waiver and audit');
  assert.match(section, /`tier\.waivable\.reviews` is not empty/);
  assert.match(section, /only an empty set[^\n]*failed|an empty set[^\n]*`failed`/);
});
