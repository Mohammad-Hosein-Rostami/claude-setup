// Round 5 lane D check: every principle id that review-tier can hand to a brief exists in the principle table. (The cases that read the
// workflows README went with the workflow scripts.)
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
  assert.ok(known.size >= 16);
  assert.ok(!known.has('P999'));
});
