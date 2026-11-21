// Tests that the five long-running worker agents carry the "Waiting" line (lane r7-waits): run long commands with
// run_in_background and a timeout of at most 2 h, never a sleep/poll loop, a run over 2 h is split or started in an interactive session,
// watch.mjs is only for waiting on a session or an agent; and that docs/catalog.md describes the guard behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WAIT_ADVICE, WAIT_CALL, WAIT_START_FORM } from '../home/hooks/lib/wait-advice.mjs';

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
const WORKERS = ['implementer', 'ui-implementer', 'runner', 'test-writer', 'deep-debugger'];
// A background command of a foreground subagent stops when that agent's run ends and nobody is woken (Claude Code tools reference, Bash
// tool), so no text may tell an agent that it will be woken.
const WAKE_UP_PROMISE = /you are woken|woken (at|when)|you (are|will be|get) notified|wakes you|reported when it ends/i;

// r9-dedupe part 2: the Waiting paragraph is stated once, in home/CLAUDE.md "Agents (workers)", which loads in every worker.
const WAITING_HOME = 'home/CLAUDE.md';

test('each long-running worker agent has a Waiting line naming background runs, a timeout and no polling', () => {
  for (const name of WORKERS) {
    assert.match(read(`home/agents/${name}.md`), /CLAUDE\.md "Agents \(workers\)"/, `${name}: points to the worker lines`);
    const line = read(WAITING_HOME).split('\n').find((text) => /waiting/i.test(text) && /run_in_background/.test(text));
    assert.ok(line, `${name}: no Waiting line with run_in_background`);
    assert.match(line, /watch\.mjs|timeout/, name);
    assert.match(line, /poll|sleep/i, name);
  }
});

/** An agent's Waiting paragraph as one line: from the line that opens it to the next bullet or blank line. */
function waitingParagraph(name) {
  const lines = read(WAITING_HOME).split('\n');
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

test('each Waiting line gives the one way to wait that holds for a foreground and a background subagent, with the commands the guard text names', () => {
  for (const name of WORKERS) {
    const paragraph = waitingParagraph(name);
    assert.ok(paragraph.includes(`started as \`${WAIT_START_FORM}\``), `${name}: the start form`);
    assert.ok(paragraph.includes(`one foreground call (\`timeout\` 180000) that ends by itself in 160 s: \`${WAIT_CALL}\``), `${name}: the wait call`);
    assert.match(paragraph, /send it again until `<log>\.exit` is there/, name);
    assert.match(paragraph, /a command that may run over 3 min is not held by a foreground `timeout`: it runs with `run_in_background: true`/, name);
    assert.match(paragraph, /a background subagent's limit: its foreground command is moved to the background after 3 min, whatever its `timeout`\./, name);
    assert.match(paragraph, /moved to the background all the same, return a status that names it instead of starting it again\./, name);
    assert.doesNotMatch(paragraph, /within 10 min|10-min foreground/, `${name}: a background subagent's foreground command does not run 10 min`);
    assert.match(paragraph, /Never end your turn while the command runs: a background command of a foreground subagent stops when that agent's run ends and nobody is woken; only the main session's or a background subagent's keeps running/, name);
    assert.match(paragraph, /`<log>\.exit` is still missing once the `timeout` you set has passed, stop waiting: either way return a status to your caller that names the command and what is left\./, name);
  }
});

test('no Waiting line and no guard advice promises a wake-up: a foreground subagent never gets one', () => {
  for (const name of WORKERS) {
    assert.doesNotMatch(waitingParagraph(name), WAKE_UP_PROMISE, name);
    assert.doesNotMatch(waitingParagraph(name), /dies when you reply/, `${name}: true for a foreground subagent only`);
  }
  assert.doesNotMatch(WAIT_ADVICE, WAKE_UP_PROMISE);
  assert.match(WAIT_ADVICE, /A command that ends within 3 min runs in the foreground with an explicit timeout\./);
  assert.match(WAIT_ADVICE, /one foreground call \(timeout 180000\) that ends by itself in 160 s \(a background subagent's foreground command is moved to the background after 3 min\)/);
  assert.match(WAIT_ADVICE, /Never end your turn while the command runs: a background command of a foreground subagent stops when that agent's run ends and nobody is woken/);
});

test('the runner rule against background loops and re-runs leaves room for the Waiting way', () => {
  const text = read('home/agents/runner.md').replace(/\s+/g, ' ');
  assert.match(text, /never re-run a command until it passes: [^.]*\. A long command started in the background and waited for as the Waiting line of CLAUDE\.md "Agents \(workers\)" says is none of these\./);
});

test('the runner timeout line sends a longer command to run_in_background with timeout up to the 2-h maximum', () => {
  const line = sentencesOf(waitingParagraph('runner')).find((sentence) => sentence.startsWith('A command expected to end within 3 min'));
  assert.ok(line, 'runner: no explicit-timeout line');
  assert.match(waitingParagraph('runner'), /a command that may run over 3 min is not held by a foreground `timeout`: it runs with `run_in_background: true` and `timeout` set to its expected run plus a margin, at most 7200000 ms \(2 h\)/);
  assert.match(waitingParagraph('runner'), /cannot finish within 2 h, say so in your reply/);
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
  assert.ok(adviceRow.includes(`\`${WAIT_START_FORM}\``) && adviceRow.includes(`\`${WAIT_CALL}\``), 'the row names the start form and the wait call');
  assert.match(adviceRow, /`\$\(\.\.\.\)` and backtick bodies are not looked into/);
});
