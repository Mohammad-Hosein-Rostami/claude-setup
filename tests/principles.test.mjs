// Text checks of the guidance files: the principle table P1-P16, lex's plan lists and self-attack, the long-command and timeout
// lines of the agents that run commands, dev's contract-dispute line, and the home/CLAUDE.md long-command line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
const flat = (text) => text.replace(/\s+/g, ' ');

const PRINCIPLE_IDS = Array.from({ length: 16 }, (_, index) => `P${index + 1}`);

/** Rows of the principle table: `id | areas | principle | question to ask yourself`. */
function principleRows() {
  return read('home/rules/principles.md')
    .split('\n')
    .filter((line) => /^P\d+ \|/.test(line))
    .map((line) => line.split(' | ').map((cell) => cell.trim()));
}

test('principles.md has one row per principle P1-P16, in order, with all four cells filled', () => {
  const rows = principleRows();
  assert.deepEqual(rows.map((row) => row[0]), PRINCIPLE_IDS);
  for (const row of rows) {
    assert.equal(row.length, 4, `${row[0]} needs id, areas, principle, question`);
    assert.ok(row.every((cell) => cell.length > 0), `${row[0]} has an empty cell`);
    assert.match(row[3], /\?$/, `${row[0]} question must be a question`);
  }
});

test('principles.md states the header and who reads the table', () => {
  const text = read('home/rules/principles.md');
  assert.match(text, /id \| areas \| principle \| question to ask yourself/);
  assert.match(text, /plain design guidance/i);
  assert.match(text, /nothing is\s+answered back at hand-off/i);
});

test('each principle keeps the words of the replay it was written from', () => {
  const byId = Object.fromEntries(principleRows().map((row) => [row[0], row.join(' | ')]));
  const expected = {
    P1: /deadline.*timeout|timeout.*deadline/i,
    P2: /patch-id/,
    P3: /fail closed/i,
    P4: /allowlist/i,
    P5: /untrusted/i,
    P6: /size cap/i,
    P7: /namespace/i,
    P8: /--state-dir/,
    P9: /back off/i,
    P10: /UNCONFIRMED/,
    P11: /worktree-agent-/,
    P12: /wall-clock/i,
    P13: /probed and cited/i,
    P14: /trust boundary[\s\S]*unvalidated/i,
    P15: /uninstall[\s\S]*every exit path/i,
    P16: /stale, crash and old-reader/i,
  };
  for (const [id, pattern] of Object.entries(expected)) assert.match(byId[id], pattern, `${id} text`);
});

test('lex.md plans tasks that share no file, with the two lists, acceptance commands and the callers of a changed interface', () => {
  const text = flat(read('home/agents/lex.md'));
  for (const list of ['**Reuse inventory**', '**Contract facts**', '**Unconfirmed**']) assert.ok(text.includes(list), `lex.md names ${list}`);
  assert.match(text, /no two tasks share a file/i);
  assert.match(text, /each a command with the exit it must return/i);
  assert.match(text, /every caller of a changed interface/i);
  assert.match(text, /Edge cases dev must keep in mind: the trust boundary, two runs at once/);
});

test('lex.md attacks its own plan once and probes a platform fact before deciding on it', () => {
  const text = flat(read('home/agents/lex.md'));
  const attack = text.slice(text.indexOf('Attack your own plan once'));
  assert.ok(attack.length > 0, 'lex.md has the self-attack step');
  for (const topic of [/no measurement/i, /unprobed platform fact/i, /owner's real layout/i, /empty input counted as clean/i, /hides a failed part/i]) {
    assert.match(attack, topic, `the self-attack covers ${topic}`);
  }
  assert.match(text, /Probe a platform fact[^.]*with a command or the installed docs/);
});

const COMMAND_AGENTS = ['dev', 'dev-run', 'tess', 'tess-write'];

test('agents that run commands: Bash timeout 600000 for installs and long runs, 60000 for probes, no polling, no wake-up promise', () => {
  for (const agent of COMMAND_AGENTS) {
    const text = flat(read(`home/agents/${agent}.md`));
    assert.match(text, /runs in the foreground with an explicit Bash `timeout`: 600000 for an install or a long run, 60000 for a probe/, agent);
    assert.match(text, /Never end your turn while it runs/, `${agent}.md never ends the turn while a background command runs`);
    assert.doesNotMatch(text, /dies when you reply/, agent);
    assert.doesNotMatch(text, /you are woken|woken (at|when)|you (are|will be|get) notified|wakes you|reported when it ends/i, `${agent}.md promises no wake-up`);
    assert.doesNotMatch(text, /until <test>; do sleep/, `${agent}.md has no sleep-loop recipe`);
  }
  assert.match(flat(read('home/agents/dev.md')), /Never poll in a loop of your own/);
  assert.match(flat(read('home/agents/dev-run.md')), /Never start a watcher, a poller or a dev server/);
});

test('dev: a design conflict with the plan is reported as a contract-dispute line', () => {
  assert.match(read('home/agents/dev.md'), /contract-dispute: <step> <why>/);
});

test('the long-command line: over 3 minutes runs in the background with a timeout of at most 2 h; P10 keeps its fix', () => {
  for (const agent of COMMAND_AGENTS) {
    assert.match(flat(read(`home/agents/${agent}.md`)), /over 3 minutes[^.]*`run_in_background: true` and a `timeout` \([^)]*at most 2 h\)/, agent);
  }
  assert.doesNotMatch(read('docs/daily-use.md'), /over about 2 minutes|with a timeout and `watch\.mjs`/, 'the daily-use page says the same as the rule');
  assert.match(read('home/rules/principles.md'), /Enter never acts as a click/);
  assert.doesNotMatch(read('home/rules/principles.md'), /never consent/);
});

// The 3-min mark is a background subagent's limit: its foreground command is moved to the background after 3 min.
test('home/CLAUDE.md: long-command line says over 3 min, with a timeout, no polling and no turn end while it runs', () => {
  const claude = read('home/CLAUDE.md');
  assert.match(claude, /A command that may run over 3 min runs with `run_in_background: true` and its `timeout` set \(at most 2 h\)\. Never poll or\s+sleep-loop, and never end your turn while it runs/);
  assert.doesNotMatch(claude, /watch\.mjs/, 'watch.mjs is removed and never a way to run or bound a command');
  assert.doesNotMatch(claude, /A command over ~2 min/);
});

test('docs/catalog.md lists principles.md among the rules', () => {
  assert.match(read('docs/catalog.md'), /\| `principles\.md` \|/);
});
