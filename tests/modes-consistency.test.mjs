// Consistency checks between the mode list in mode.mjs, the playbooks, ccm, docs/modes.md and home/CLAUDE.md
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

test('ccm, docs/modes.md and home/CLAUDE.md mention all five modes', () => {
  assert.equal(MODES.length, 5);
  for (const file of ['home/bin/ccm', 'docs/modes.md', 'home/CLAUDE.md']) {
    const text = read(file);
    for (const mode of MODES) assert.ok(text.includes(mode), `${file} must mention ${mode}`);
  }
});
