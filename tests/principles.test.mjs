// Text checks of the guidance files: the principle table P1-P16, lex's plan lists and self-attack, the long-command and timeout
// lines of the agents that run commands, dev's contract-dispute line, the home/CLAUDE.md long-command line, and the owner's
// decisions on the agent cap and Fable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildCatalog } from '../scripts/catalog.mjs';

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
const flat = (text) => text.replace(/\s+/g, ' ');

// P4 (guard exemptions) went with the guard hooks; the other ids keep their numbers.
const REMOVED_PRINCIPLE_ID = 'P4';
const PRINCIPLE_IDS = Array.from({ length: 16 }, (_, index) => `P${index + 1}`).filter((id) => id !== REMOVED_PRINCIPLE_ID);

/** Rows of the principle table: `id | areas | principle | question to ask yourself`. */
function principleRows() {
  return read('home/rules/principles.md')
    .split('\n')
    .filter((line) => /^P\d+ \|/.test(line))
    .map((line) => line.split(' | ').map((cell) => cell.trim()));
}

test('principles.md has one row per principle P1-P16 except the removed P4, in order, with all four cells filled', () => {
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

test('lex.md plans pieces that share no file, with the two lists, acceptance commands and the callers of a changed interface', () => {
  const text = flat(read('home/agents/lex.md'));
  for (const list of ['**Reuse inventory**', '**Contract facts**', '**Unconfirmed**']) assert.ok(text.includes(list), `lex.md names ${list}`);
  assert.match(text, /no two pieces that can run at once share a file/i);
  assert.match(text, /each a command with the exit it must return/i);
  assert.match(text, /every caller of a changed interface/i);
  assert.match(text, /Edge cases dev must keep in mind: the trust boundary, two runs at once/);
});

test('lex.md ends each plan with a ship: line, set only when the owner names a release for real users', () => {
  assert.ok(flat(read('home/agents/lex.md')).includes('End the plan with `ship: <target>` only when the owner\'s request names a release, deploy, publish or showcase for real users, else `ship: no`.'));
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

const COMMAND_AGENTS = ['dev', 'dev-part', 'dev-run', 'tess', 'tess-write', 'tess-edge'];
// Each command agent's own no-polling line: dev-run holds the wait recipe, the others point to it (tess's agents to its copy, tess-run).
const NO_POLL_LINE = {
  dev: 'Never poll in a loop of your own.',
  'dev-part': 'Never poll in a loop of your own.',
  'dev-run': 'Never poll the log or wait in a sleep loop.',
  tess: 'started and waited for as `~/.claude/agents/tess-run.md` says, never polled or sleep-looped.',
  'tess-write': 'started and waited for as `~/.claude/agents/tess-run.md` says, never polled or sleep-looped.',
  'tess-edge': 'Never poll in a loop of your own.',
};
// The command agents that do not load home/CLAUDE.md carry its stop-before-report rule themselves.
const OWN_RULE_AGENTS = ['dev-part', 'dev-run', 'tess-edge'];
const STOP_BEFORE_REPORT = 'Never end your turn or report while a background command or monitor you started still runs: wait on its notice, or stop it with TaskStop (load it with ToolSearch select:TaskStop if it is not loaded).';

test('agents that run commands: Bash timeout 600000 for installs and long runs, 60000 for probes, no polling, stop before the report, no wake-up promise', () => {
  for (const agent of COMMAND_AGENTS) {
    const text = flat(read(`home/agents/${agent}.md`));
    assert.match(text, /runs in the foreground with an explicit Bash `timeout`: 600000 for an install or a long run, 60000 for a probe/, agent);
    assert.ok(text.includes(NO_POLL_LINE[agent]), `${agent}.md forbids polling`);
    if (OWN_RULE_AGENTS.includes(agent)) assert.ok(text.includes(STOP_BEFORE_REPORT), `${agent}.md stops its background commands before the report`);
    else assert.doesNotMatch(read(`home/agents/${agent}.md`), /^omitClaudeMd: true$/m, `${agent}.md loads home/CLAUDE.md, which holds the stop rule`);
    assert.doesNotMatch(text, /dies when you reply/, agent);
    assert.doesNotMatch(text, /you are woken|woken (at|when)|you (are|will be|get) notified|wakes you|reported when it ends/i, `${agent}.md promises no wake-up`);
    assert.doesNotMatch(text, /until <test>; do sleep/, `${agent}.md has no sleep-loop recipe`);
  }
  assert.match(flat(read('home/agents/dev.md')), /Never poll in a loop of your own/);
  assert.match(flat(read('home/agents/dev-run.md')), /Never start a watcher, a poller or a dev server/);
});

test('dev starts dev-docs for a change\'s docs and user text, and never runs two parts on the same files at once', () => {
  const text = flat(read('home/agents/dev.md'));
  assert.ok(text.includes('`dev-docs`: the docs and user-facing text a change needs, started with the code parts from the plan\'s interfaces (a one-line doc change you write yourself); model as dev-part\'s table, `model: "opus"` for migration notes of a breaking change, a public API reference, or security or data-loss text. `dev-codex`: a Codex review of your finished work, only with `codex: yes` (Build). Nothing else.'), 'the dev-docs helper line');
  assert.ok(text.includes('- One file, one writer: each part names the files it owns (`files:`); parts whose files overlap run one after another, never at once.'), 'the one-writer line');
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
test('home/CLAUDE.md: long-command line says over 3 min, background with a timeout, no polling, no turn end or report while it runs, and points to dev-run.md', () => {
  const claude = read('home/CLAUDE.md');
  assert.ok(flat(claude).includes('- A command over 3 min runs in the background (`timeout` at most 2 h), never polled; wait for it before you end your turn or report (`~/.claude/agents/dev-run.md`).'));
  assert.doesNotMatch(claude, /watch\.mjs/, 'watch.mjs is removed and never a way to run or bound a command');
  assert.doesNotMatch(claude, /A command over ~2 min/);
});

const listDir = (path) => readdirSync(fileURLToPath(new URL(`../${path}`, import.meta.url)));
const AGENTS_PER_TYPE = 3; // the owner's cap of running lex, dev, tess and max agents each, as home/CLAUDE.md states it

test('home/CLAUDE.md names the owner\'s cap of 3 lex, 3 dev, 3 tess and 3 max', () => {
  const claude = flat(read('home/CLAUDE.md'));
  const cap = AGENTS_PER_TYPE;
  assert.ok(claude.includes(`- At most ${cap} lex, ${cap} dev, ${cap} tess and ${cap} max run at once; their helpers are not counted.`), `the cap line names ${cap} of each`);
});

test('agent files name Fable only to forbid it, and no hook file names it', () => {
  let named = 0;
  for (const file of listDir('home/agents')) {
    for (const sentence of flat(read(`home/agents/${file}`)).split(/(?<=[.:])\s+/).filter((line) => /fable/i.test(line))) {
      named += 1;
      assert.match(sentence, /never Fable/, `${file}: ${sentence}`);
    }
  }
  assert.ok(named > 0, 'the agents still carry the never-Fable rule');
  const hookFiles = [...listDir('home/hooks'), ...listDir('home/hooks/lib').map((file) => `lib/${file}`)];
  const naming = hookFiles.filter((file) => /\.(mjs|md)$/.test(file) && /fable/i.test(read(`home/hooks/${file}`)));
  assert.deepEqual(naming, [], 'the no-Fable gate hooks are removed: no hook file names Fable');
});

// docs/catalog.md is generated and git-ignored (ADR 0009), so the text is built from the files here, not read from disk.
test('the catalog lists principles.md among the rules', () => {
  assert.match(buildCatalog(fileURLToPath(new URL('../', import.meta.url))).text, /\| `principles\.md` \|/);
});
