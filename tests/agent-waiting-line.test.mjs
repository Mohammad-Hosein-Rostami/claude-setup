// Tests that the five long-running worker agents carry the "Waiting" line (lane r7-waits): run long commands with
// run_in_background and a timeout of at most 2 h, never a sleep/poll loop, a run over 2 h is split or started in an interactive session,
// watch.mjs is only for waiting on a session or an agent; and that docs/catalog.md describes the guard behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
const WORKERS = ['implementer', 'ui-implementer', 'runner', 'test-writer', 'deep-debugger'];

test('each long-running worker agent has a Waiting line naming background runs, a timeout and no polling', () => {
  for (const name of WORKERS) {
    const line = read(`home/agents/${name}.md`).split('\n').find((text) => /waiting/i.test(text) && /run_in_background/.test(text));
    assert.ok(line, `${name}: no Waiting line with run_in_background`);
    assert.match(line, /watch\.mjs|timeout/, name);
    assert.match(line, /poll|sleep/i, name);
  }
});

/** An agent's Waiting paragraph as one line: from the line that opens it to the next bullet or blank line. */
function waitingParagraph(name) {
  const lines = read(`home/agents/${name}.md`).split('\n');
  const start = lines.findIndex((text) => /^(- )?Waiting:/.test(text));
  assert.notEqual(start, -1, `${name}: no Waiting line`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((text) => text === '' || text.startsWith('- '));
  return [lines[start], ...rest.slice(0, end === -1 ? rest.length : end)].map((text) => text.trim()).join(' ');
}

/** The sentences of a paragraph: cut after each full stop that a blank follows (`watch.mjs` and `2 h)` stay whole). */
const sentencesOf = (text) => text.split(/(?<=\.)\s+/);

test('each Waiting line names run_in_background, timeout and the 2-h maximum in one sentence, and the path for a run over 2 h', () => {
  for (const name of WORKERS) {
    const paragraph = waitingParagraph(name);
    const opening = sentencesOf(paragraph)[0];
    assert.match(opening, /`run_in_background: true` and `timeout` set to its expected run plus a margin, at most 7200000 ms \(2 h\)/, name);
    assert.match(paragraph, /Set `timeout` for every background command: in an unattended run \(`-p`, Agent SDK, CI, cloud\) one without it stops after 30 min \(10 min for a text `-p` prompt\)\./, name);
    assert.match(paragraph, /A run over 2 h is split, or started in an interactive session, where background commands have no limit\./, name);
    assert.doesNotMatch(paragraph, /cannot finish within 600000/, name);
  }
});

test('each Waiting line names watch.mjs only for waiting on a session or an agent, never as the way to run or bound a command', () => {
  for (const name of WORKERS) {
    const paragraph = waitingParagraph(name);
    const naming = sentencesOf(paragraph).filter((sentence) => /watch\.mjs/.test(sentence));
    assert.equal(naming.length, 1, name);
    assert.match(naming[0], /waits on a session or an agent only: it never runs or bounds a command/, name);
    assert.doesNotMatch(paragraph, /bounded wait/, name);
  }
});

test('the runner timeout line sends a longer command to run_in_background with timeout up to the 2-h maximum', () => {
  const line = sentencesOf(waitingParagraph('runner')).find((sentence) => sentence.startsWith('Pass an explicit Bash `timeout`'));
  assert.ok(line, 'runner: no explicit-timeout line');
  assert.match(line, /a longer command runs with `run_in_background: true` and `timeout` up to 7200000 ms \(2 h\)/);
  assert.match(waitingParagraph('runner'), /cannot finish within 2 h, say so in your report/);
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
