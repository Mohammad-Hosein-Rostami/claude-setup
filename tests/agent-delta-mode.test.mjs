// Tests for the "Delta mode" of the reviewer and security-auditor agents, the home/CLAUDE.md gate sentence that sends every
// fix-round re-review through `review-tier --delta`, and the catalog line for `--prior` (round 7, lane r7-delta).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
const AGENTS = ['reviewer', 'security-auditor'];

/** The text of the "Delta mode" section: from its heading to the next heading. */
function deltaSection(name) {
  const text = read(`home/agents/${name}.md`);
  const start = text.search(/^#{2,3} Delta mode\s*$/m);
  assert.ok(start >= 0, `${name} has a "Delta mode" heading`);
  const rest = text.slice(start).replace(/^#.*\n/, '');
  const end = rest.search(/^#{1,3} /m);
  return end < 0 ? rest : rest.slice(0, end);
}

test('reviewer and security-auditor each have a Delta mode section', () => {
  for (const name of AGENTS) assert.ok(deltaSection(name).trim().length > 0, name);
});

test('Delta mode starts when the brief names a delta range or prior findings, and reviews the range, callers and each prior finding', () => {
  for (const name of AGENTS) {
    const section = deltaSection(name);
    assert.match(section, /delta range/i, name);
    assert.match(section, /prior findings/i, name);
    assert.match(section, /callers/i, name);
    assert.match(section, /each prior finding/i, name);
  }
});

test('Delta mode still reads what a fix can break outside the range: callers, and the readers of shared state, config and data the changed lines write', () => {
  for (const name of AGENTS) {
    const section = deltaSection(name);
    assert.match(section, /shared state, config and data the changed lines write that other code reads/, name);
    assert.match(section, /reader that never calls/, `${name}: says why callers are not enough`);
  }
});

test('Delta mode says where the prior findings are when the brief names no findings file', () => {
  for (const name of AGENTS) assert.match(deltaSection(name), /`none`[^.]*items the brief lists/, name);
});

test('the prior line goes before the final line, so a report still ends with the line the Output contract names', () => {
  const finalLine = { reviewer: 'verified:', 'security-auditor': 'exploitable:' };
  for (const name of AGENTS) {
    assert.ok(deltaSection(name).includes(`before the final \`${finalLine[name]}\` line`), name);
    assert.ok(read(`home/agents/${name}.md`).includes(`\n- Final line: \`${finalLine[name]} `), `${name}: the Output contract still ends with ${finalLine[name]}`);
  }
});

test('Delta mode keeps the same lens, model and effort', () => {
  for (const name of AGENTS) assert.match(deltaSection(name), /same lens,? same model,? same effort/i, name);
});

test('Delta mode reports the prior count line', () => {
  for (const name of AGENTS) assert.match(deltaSection(name), /prior: N closed, M open; new:/, name);
});

test('Delta mode does not allow skipping a lens or lowering the model', () => {
  for (const name of AGENTS) assert.match(deltaSection(name), /never (lower|skip)/i, name);
});

test('home/CLAUDE.md quality gates send a fix round re-review through the delta brief and keep one full-range review before land', () => {
  const gates = read('home/CLAUDE.md').split(/^## Quality gates/m)[1].split(/^## /m)[0];
  assert.match(gates, /fix round'?s? re-review is always the delta brief from `review-tier --delta`/);
  assert.match(gates, /full-range review runs once at the reviewed tip before land/);
});

test('docs/catalog.md review-tier line names --prior', () => {
  const line = read('docs/catalog.md').split('\n').find((row) => row.startsWith('| `review-tier` |'));
  assert.ok(line, 'catalog has the review-tier row');
  assert.match(line, /--prior/);
});
