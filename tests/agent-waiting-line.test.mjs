// Tests that every agent that runs long commands carries the one way to wait that the guard's sleep-loop advice names
// (lib/wait-advice.mjs): start the command with run_in_background and a timeout of at most 2 h in the start form, then wait in one
// foreground call with the wait loop; that no agent text or advice promises a wake-up; and that docs/catalog.md describes the guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WAIT_ADVICE, WAIT_CALL, WAIT_START_FORM } from '../home/hooks/lib/wait-advice.mjs';

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
const oneLine = (text) => text.replace(/\s+/g, ' ');
// The agents that run builds, tests or loops that can pass 3 minutes.
const LONG_RUNNERS = ['dev', 'dev-ui', 'dev-pixel', 'dev-debug', 'dev-run', 'tess', 'pixel-qa'];
// A background command of a foreground subagent stops when that agent's run ends and nobody is woken (Claude Code tools reference, Bash
// tool), so no text may tell an agent that it will be woken.
const WAKE_UP_PROMISE = /you are woken|woken (at|when)|you (are|will be|get) notified|wakes you|reported when it ends/i;

test('each long-running agent starts a long command in the background with a timeout of at most 2 h, in the guard\'s start form', () => {
  for (const name of LONG_RUNNERS) {
    const text = oneLine(read(`home/agents/${name}.md`));
    assert.match(text, /over 3 minutes/, name);
    assert.match(text, /`run_in_background: true` and a `timeout` \([^)]*at most 2 h\)/, name);
    assert.ok(text.includes(`\`${WAIT_START_FORM}\``), `${name}: the start form`);
  }
});

test('each long-running agent waits in one foreground call with the guard\'s wait loop, and never ends its turn early', () => {
  for (const name of LONG_RUNNERS) {
    const text = oneLine(read(`home/agents/${name}.md`));
    assert.ok(text.includes(`one foreground call (\`timeout\` 180000): \`${WAIT_CALL}\``), `${name}: the wait call`);
    assert.match(text, /Never end your turn while it runs/, name);
  }
});

test('no agent text and no guard advice promises a wake-up: a foreground subagent never gets one', () => {
  for (const name of LONG_RUNNERS) assert.doesNotMatch(read(`home/agents/${name}.md`), WAKE_UP_PROMISE, name);
  assert.doesNotMatch(WAIT_ADVICE, WAKE_UP_PROMISE);
  assert.match(WAIT_ADVICE, /A command that ends within 3 min runs in the foreground with an explicit timeout\./);
  assert.match(WAIT_ADVICE, /one foreground call \(timeout 180000\) that ends by itself in 160 s \(a background subagent's foreground command is moved to the background after 3 min\)/);
  assert.match(WAIT_ADVICE, /Never end your turn while the command runs: a background command of a foreground subagent stops when that agent's run ends and nobody is woken/);
});

test('dev-run runs each command once: no watcher, poller or dev server, and no re-run until it passes', () => {
  const text = oneLine(read('home/agents/dev-run.md'));
  assert.match(text, /Run each command once\. Never start a watcher, a poller or a dev server, and never re-run a command until it passes\./);
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
