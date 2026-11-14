// Consistency checks between the mode list in mode.mjs, the playbooks, ccm, docs/modes.md, home/CLAUDE.md and home/modes/_lead.md
// (node:test, no dependencies). A mode added to MODES must show up everywhere or one of these tests fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MODES } from '../home/hooks/mode.mjs';

const read = (relative) => readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');
const SESSION_ONLY_ENDING = 'Applies to this session only.';

test('every mode has a playbook ending with the session-only line', () => {
  for (const mode of MODES) {
    const playbook = read(`home/modes/${mode}.md`).trimEnd();
    assert.ok(playbook.endsWith(SESSION_ONLY_ENDING), `${mode}.md must end with "${SESSION_ONLY_ENDING}"`);
  }
});

const LANE_BUDGETS = { normal: 2, medium: 3, high: 6, 'extra-high': 6, 'ultra-high': 8 };

test('every playbook states its lane budget', () => {
  for (const mode of MODES) {
    assert.match(read(`home/modes/${mode}.md`), new RegExp(`Lane budget: (up to )?${LANE_BUDGETS[mode]} agents? at`), `${mode}.md lane budget`);
  }
});

test('_lead.md carries the lead-discipline rules and stays small', () => {
  const lead = read('home/modes/_lead.md');
  for (const needle of ['Persian', 'No turn without a decision', 'runner', '2nd compaction', 'usage-limit', 'STATUS.md', '3k chars', 'restart the session', 'No answer in 60 s','≤ 300 words', 'continue them with SendMessage', 'estimate.mjs']) {
    assert.ok(lead.includes(needle), `_lead.md must mention ${needle}`);
  }
  assert.ok(lead.split('\n').length <= 100, '_lead.md is injected into every session; keep it <= 100 lines');
});

test('ultra-high playbook keeps the assembly and compact-before-waiting rules', () => {
  const playbook = read('home/modes/ultra-high.md');
  assert.match(playbook, /Workflow assembly is not judgment/);
  assert.match(playbook, /max 1 continuation/);
  assert.match(playbook, /`\/compact` first/);
});

test('home/CLAUDE.md names Persian replies, the STATUS.md re-read and the Grep tool or rg', () => {
  const text = read('home/CLAUDE.md');
  assert.match(text, /Persian included/);
  assert.match(text, /`STATUS\.md` path/);
  assert.match(text, /Grep tool or `rg`/);
  assert.match(text, /Git push[\s\S]*confirm dialog even in bypass mode[\s\S]*auto-allow after 3 minutes[\s\S]*literal password or token/);
});

test('ccm, docs/modes.md, home/CLAUDE.md and home/modes/_lead.md mention all five modes', () => {
  assert.equal(MODES.length, 5);
  for (const file of ['home/bin/ccm', 'docs/modes.md', 'home/CLAUDE.md', 'home/modes/_lead.md']) {
    const text = read(file);
    for (const mode of MODES) assert.ok(text.includes(mode), `${file} must mention ${mode}`);
  }
});
