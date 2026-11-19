// Tests that the five long-running worker agents carry the "Waiting" line (lane r7-waits): run long commands with
// run_in_background or one bounded wait, never a sleep/poll loop; and that docs/catalog.md describes the guard behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
const WORKERS = ['implementer', 'ui-implementer', 'runner', 'test-writer', 'deep-debugger'];

test('each long-running worker agent has a Waiting line naming background runs, a bounded wait and no polling', () => {
  for (const name of WORKERS) {
    const line = read(`home/agents/${name}.md`).split('\n').find((text) => /waiting/i.test(text) && /run_in_background/.test(text));
    assert.ok(line, `${name}: no Waiting line with run_in_background`);
    assert.match(line, /watch\.mjs|timeout/, name);
    assert.match(line, /poll|sleep/i, name);
  }
});

test('the catalog line for pre-bash-guard describes the sleep loop bounce', () => {
  const row = read('docs/catalog.md').split('\n').find((text) => text.startsWith('| `pre-bash-guard.mjs`'));
  assert.ok(row, 'guard row');
  assert.match(row, /sleep/i);
  assert.match(row, /run_in_background/);
});

test('the catalog rows name timeout with the 2-h maximum, and watch.mjs only for waiting on a session or an agent', () => {
  const rows = read('docs/catalog.md').split('\n');
  const guardRow = rows.find((text) => text.startsWith('| `pre-bash-guard.mjs`'));
  const adviceRow = rows.find((text) => text.startsWith('| `lib/wait-advice.mjs`'));
  assert.ok(adviceRow, 'wait-advice row');
  for (const row of [guardRow, adviceRow]) {
    assert.match(row, /`run_in_background: true` (and|with) `timeout`[^.;]*7200000 ms/);
    assert.doesNotMatch(row, /bounded wait/);
  }
  assert.match(adviceRow, /unattended run \(`-p`, Agent SDK, CI, cloud\)[^.]*30 min \(10 min for a text `-p` prompt\)/);
  assert.match(adviceRow, /`watch\.mjs` is named only for waiting on a session or an agent/);
});
