// Tests that the one way to wait that the guard's sleep-loop advice names (lib/wait-advice.mjs) lives in home/agents/dev-run.md only:
// a command over 3 min starts with run_in_background and a timeout of at most 2 h in the start form, its completion notice (or a
// Monitor) is the wait, and every background command and monitor is stopped before the final report. Every other long-running agent
// points to dev-run.md instead of carrying a copy; no agent text tells an agent to poll or sleep-loop or promises a wake-up; and
// docs/catalog.md describes the guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WAIT_ADVICE, WAIT_START_FORM } from '../home/hooks/lib/wait-advice.mjs';

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
const oneLine = (text) => text.replace(/\s+/g, ' ');
const sentencesOf = (text) => text.split(/(?<=\.)\s+/);
const AGENT_FILES = readdirSync(fileURLToPath(new URL('../home/agents/', import.meta.url))).filter((file) => file.endsWith('.md'));
const agentText = (name) => oneLine(read(`home/agents/${name}.md`));
// The agents that run builds, tests or loops that can pass 3 minutes.
const LONG_RUNNERS = ['dev', 'dev-part', 'dev-ui', 'dev-pixel', 'dev-debug', 'dev-run', 'tess', 'tess-write', 'tess-edge', 'pixel-qa'];
const RECIPE_HOLDER = 'dev-run';
const RECIPE_POINTER = 'started and waited for as `~/.claude/agents/dev-run.md` says';
// A shell still running at the final report keeps the agent listed as running (lib/wait-advice.mjs), so the agents and the advice
// say the same line.
const STOP_BEFORE_REPORT = 'Never end your turn or report while a background command or monitor you started still runs: wait on its notice, or stop it with TaskStop (load it with ToolSearch select:TaskStop if it is not loaded).';
// The helpers that hold Bash and do not load the global CLAUDE.md, so the stop line must be in their own file.
const OWN_RULE_HELPERS = ['dev-run', 'dev-part', 'tess-edge', 'tess-simple'];
// A background command of a foreground subagent stops when that agent's run ends and nobody is woken (Claude Code tools reference, Bash
// tool), so no text may tell an agent that it will be woken.
const WAKE_UP_PROMISE = /you are woken|woken (at|when)|you (are|will be|get) notified|wakes you|reported when it ends/i;

/** @returns {{tools: string[], omitClaudeMd: boolean}} the two frontmatter fields this file reads */
function frontmatterOf(name) {
  const [, block = ''] = /^---\n([\s\S]*?)\n---/.exec(read(`home/agents/${name}.md`).replace(/\r\n/g, '\n')) ?? [];
  const field = (key) => new RegExp(`^${key}: *(.*)$`, 'm').exec(block)?.[1] ?? '';
  return { tools: field('tools').split(/, */), omitClaudeMd: field('omitClaudeMd') === 'true' };
}

test('each long-running agent starts a command over 3 minutes in the background with a timeout of at most 2 h', () => {
  for (const name of LONG_RUNNERS) {
    const text = agentText(name);
    assert.match(text, /over 3 minutes/, name);
    assert.match(text, /`run_in_background: true` and a `timeout` \([^)]*at most 2 h\)/, name);
  }
});

test('the guard\'s start form is in dev-run.md, and every other long-running agent points to dev-run.md instead of a copy', () => {
  assert.ok(agentText(RECIPE_HOLDER).includes(`at most 2 h) as \`${WAIT_START_FORM}\``), 'dev-run: the start form');
  for (const name of LONG_RUNNERS.filter((runner) => runner !== RECIPE_HOLDER)) {
    const text = agentText(name);
    assert.ok(text.includes(RECIPE_POINTER), `${name}: the pointer to dev-run.md`);
    assert.ok(!text.includes(WAIT_START_FORM), `${name}: no copy of the start form`);
  }
});

test('dev-run.md holds the wait recipe: the completion notice, a Monitor for anything else, no poll, and the foreground case', () => {
  const text = agentText(RECIPE_HOLDER);
  assert.match(text, /A command that may run over 3 minutes, while you have other work, runs with `run_in_background: true`/);
  assert.match(text, /Keep working while it runs, wait on its completion notice, then read the log once\./);
  assert.match(text, /To wait for anything else \(a file, a log line, a server\), use the Monitor tool with a command that prints a line on success and on failure and then exits, or send the check loop itself with `run_in_background: true`: its exit is the notice\./);
  assert.match(text, /Never poll the log or wait in a sleep loop\./);
  assert.match(text, /A command whose result is all that is left runs in the foreground with `timeout` 600000 instead; one that needs longer is reported as not run\./);
});

test('the wait recipe is in dev-run.md only: no other agent file carries a second copy of a wait loop', () => {
  const others = AGENT_FILES.filter((file) => file !== `${RECIPE_HOLDER}.md`);
  assert.ok(others.length >= LONG_RUNNERS.length, 'the agent files were read');
  for (const file of others) {
    const text = oneLine(read(`home/agents/${file}`));
    assert.ok(!text.includes('<log>.exit'), `${file}: no exit-file wait`);
    assert.ok(!text.includes('wait on its completion notice'), `${file}: no copy of the notice wait`);
    assert.ok(!text.includes('Monitor tool with a command'), `${file}: no copy of the Monitor wait`);
  }
});

test('no agent text tells an agent to poll or sleep-loop: each sentence that names one forbids it, and no sleep command is written out', () => {
  let named = 0;
  for (const file of AGENT_FILES) {
    const text = oneLine(read(`home/agents/${file}`));
    assert.doesNotMatch(text, /\bsleep \d|\$\(seq\b/, `${file}: a written-out sleep or seq loop`);
    for (const sentence of sentencesOf(text).filter((line) => /\bpoll|\bsleep/i.test(line))) {
      named += 1;
      assert.match(sentence, /\bnever\b/i, `${file}: ${sentence}`);
    }
  }
  assert.ok(named > 0, 'the agents still name polling as forbidden');
});

test('each Bash-holding helper that does not load the global CLAUDE.md stops every background command before its final report', () => {
  const helpers = AGENT_FILES.map((file) => file.replace(/\.md$/, '')).filter((name) => {
    const { tools, omitClaudeMd } = frontmatterOf(name);
    return omitClaudeMd && tools.includes('Bash');
  });
  for (const name of OWN_RULE_HELPERS) assert.ok(helpers.includes(name), `${name}: holds Bash and omits CLAUDE.md`);
  for (const name of helpers) assert.ok(agentText(name).includes(STOP_BEFORE_REPORT), `${name}: the stop-before-report line`);
});

test('no agent text and no guard advice promises a wake-up: a foreground subagent never gets one', () => {
  for (const name of [...LONG_RUNNERS, ...OWN_RULE_HELPERS]) assert.doesNotMatch(read(`home/agents/${name}.md`), WAKE_UP_PROMISE, name);
  assert.doesNotMatch(WAIT_ADVICE, WAKE_UP_PROMISE);
});

test('the guard advice names the notice wait, the Monitor tool, the foreground case and the stop before the final report', () => {
  assert.match(WAIT_ADVICE, /A command that ends within 3 min runs in the foreground with an explicit timeout\./);
  assert.ok(WAIT_ADVICE.includes(`started as ${WAIT_START_FORM}. Do so only while you have other work: keep working while it runs, wait on its completion notice, then read the log once.`), 'the start form, then the notice');
  assert.match(WAIT_ADVICE, /To wait for anything else \(a file, a log line, a server\), use the Monitor tool with a command that prints a line on success and on failure and then exits, or send the check loop itself with run_in_background: true: its exit is the notice\./);
  assert.match(WAIT_ADVICE, /A command whose result is all that is left runs in the foreground with timeout 600000 instead\./);
  assert.ok(WAIT_ADVICE.includes(STOP_BEFORE_REPORT), 'the stop-before-report line, as the agents say it');
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

// The watch tool was removed (lex-dev-tess plan): the advice row no longer names it at all.
test('the catalog rows name timeout with the 2-h maximum, and the advice row names the notice wait, Monitor, the stop before the report and no removed watcher tool', () => {
  const rows = read('docs/catalog.md').split('\n');
  const guardRow = rows.find((text) => text.startsWith('| `pre-bash-guard.mjs`'));
  const adviceRow = rows.find((text) => text.startsWith('| `lib/wait-advice.mjs`'));
  assert.ok(adviceRow, 'wait-advice row');
  for (const row of [guardRow, adviceRow]) {
    assert.match(row, /`run_in_background: true` (and|with) `timeout`[^.;]*7200000 ms/);
    assert.doesNotMatch(row, /bounded wait/);
  }
  assert.match(adviceRow, /unattended run \(`-p`, Agent SDK, CI, cloud\)[^.]*30 min \(10 min for a text `-p` prompt\)/);
  assert.doesNotMatch(adviceRow, /watch\.mjs/, 'the watch tool was removed');
  assert.ok(adviceRow.includes(`started as \`${WAIT_START_FORM}\`, only while the agent has other work: it keeps working and waits on the completion notice, then reads the log once`), 'the row names the start form, then the notice');
  assert.match(adviceRow, /anything else \(a file, a log line, a server\) is waited for with Claude Code's `Monitor` tool/);
  assert.match(adviceRow, /An agent never ends its turn or reports while a background command or monitor it started still runs: it waits on the notice or stops it with TaskStop/);
  assert.match(adviceRow, /The agents that run long commands point to the same recipe in `home\/agents\/dev-run\.md`\./);
  assert.match(adviceRow, /`\$\(\.\.\.\)` and backtick bodies are not looked into/);
});
