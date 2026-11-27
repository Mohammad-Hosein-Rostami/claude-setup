// Tests for scripts/agent-usage.mjs: the per-agent table (means, a median for report words), repeated message ids, empty and missing
// transcript folders, flag errors, the --project and --since filters, bad lines and unreadable files, --json, counts only, and the
// background tasks of rule M7. Every transcript is built in a temp config dir (CLAUDE_CONFIG_DIR); the real ~/.claude is never read.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cleanEnv } from './clean-env.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/agent-usage.mjs', import.meta.url));
const USAGE_LINE = 'usage: node scripts/agent-usage.mjs [--since <iso>] [--project <key>] [--json]';
const USAGE_EXIT = 2;
const LONG_AGO = '2020-01-01T00:00:00.000Z'; // before every fixture file, so --since never hides one
const TURN_STAMP = '2026-01-01T00:00:00.000Z'; // one instant for all turns: no cache gap
const TURN_CONTEXT = 10_000; // input + cache creation + cache read of one turn
const TURN_USAGE = { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 7000 };
const BRIEF = 'Do the task.';
const SECRET_MARKER = 'SECRET-MARKER-123';
const ANSI_RED = '\u001b[31m';
const TABLE_ROW = /^[\w()-]+ \| \d+ \| /; // a data row; the header starts `type | runs`
const OLD_MTIME = new Date('2021-01-01T00:00:00Z');
const NEW_MTIME = new Date('2024-01-01T00:00:00Z');
const SINCE_BETWEEN = '2022-01-01T00:00:00.000Z';
const RULE_IDS = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10'];
const JSON_KEYS = ['bossRules', 'project', 'rules', 'runs', 'since', 'skippedLines', 'unreadable'];
const cannotChmod = process.platform === 'win32' || process.getuid?.() === 0 ? 'a file cannot be made unreadable here' : false;

const userLine = (content) => ({ type: 'user', message: { role: 'user', content } });
const toolResultLine = (text) => userLine([{ type: 'tool_result', tool_use_id: 'toolu_1', content: text }]);
const assistantLine = (id, content, usage = TURN_USAGE) => ({
  type: 'assistant', timestamp: TURN_STAMP, message: { id, role: 'assistant', usage, content },
});
const textBlock = (text) => ({ type: 'text', text });
const bashBlock = (command = 'ls') => ({ type: 'tool_use', name: 'Bash', input: { command } });
const words = (count) => Array.from({ length: count }, (_, index) => `w${index}`).join(' ');

/** One agent run: `turns` distinct assistant turns, all `bash` Bash calls in the first, a last text of `wordCount` words. */
function runLines({ turns, bash = 0, wordCount = 1 }) {
  const lines = [userLine(BRIEF)];
  for (let turn = 1; turn <= turns; turn += 1) {
    const content = [];
    if (turn === 1) content.push(...Array.from({ length: bash }, () => bashBlock()));
    if (turn === turns) content.push(textBlock(words(wordCount)));
    lines.push(assistantLine(`msg-${turn}`, content));
  }
  return lines;
}

const jsonl = (lines) => `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;

/** A config dir to read, with its env; `agent` and `boss` write transcripts under <config>/projects. */
function makeWorld() {
  const root = makeTempDir('agent-usage-');
  const config = join(root, 'config');
  const home = join(root, 'home');
  mkdirSync(home);
  mkdirSync(config);
  const env = cleanEnv({ CLAUDE_CONFIG_DIR: config, HOME: home, USERPROFILE: home, TMPDIR: root });
  let count = 0;
  return {
    config,
    /** An agent transcript with its .meta.json; `raw` replaces the serialised lines. Returns the transcript path. */
    agent({ type, lines = [], raw, project = 'proj', session = 'session-1', mtime }) {
      count += 1;
      const dir = join(config, 'projects', project, session, 'subagents');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `agent-${count}.jsonl`);
      writeFileSync(file, raw ?? jsonl(lines));
      writeFileSync(join(dir, `agent-${count}.meta.json`), JSON.stringify({ agentType: type }));
      if (mtime) utimesSync(file, mtime, mtime);
      return file;
    },
    /** A main-session (boss) transcript. */
    boss({ lines, project = 'proj', session = 'session-1' }) {
      mkdirSync(join(config, 'projects', project), { recursive: true });
      writeFileSync(join(config, 'projects', project, `${session}.jsonl`), jsonl(lines));
    },
    run(args) {
      const result = spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8' });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    },
    /** `--json` of a run that must exit 0. */
    report(args = []) {
      const result = this.run(['--since', LONG_AGO, '--json', ...args]);
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    },
  };
}

const rowsOf = (stdout) => stdout.split('\n').filter((line) => TABLE_ROW.test(line));
const rowOf = (stdout, type) => rowsOf(stdout).find((line) => line.startsWith(`${type} | `));

test('the table has one row per agent type with per-run columns as means, not sums or medians', () => {
  const world = makeWorld();
  // turns 2 and 4: mean 3 (sum 6, upper median 4); context 20k and 40k: mean 30k; Bash 1 and 3: mean 2
  world.agent({ type: 'dev', lines: runLines({ turns: 2, bash: 1, wordCount: 5 }) });
  world.agent({ type: 'dev', lines: runLines({ turns: 4, bash: 3, wordCount: 5 }) });
  world.agent({ type: 'tess', lines: runLines({ turns: 1, wordCount: 1 }) });
  world.boss({ lines: runLines({ turns: 7 }) });
  const result = world.run(['--since', LONG_AGO]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /: 3 runs, 0 unreadable lines skipped$/m);
  assert.equal(rowsOf(result.stdout).length, 2, 'the boss session is no table row');
  assert.equal(rowOf(result.stdout, 'dev'), 'dev | 2 | 10.0k | 30.0k | 3 | 2 | 0 | 0 | 0 | 5');
  assert.equal(rowOf(result.stdout, 'tess'), 'tess | 1 | 10.0k | 10.0k | 1 | 0 | 0 | 0 | 0 | 1');
});

test('report words are a median over the runs of a type, not a mean', () => {
  const world = makeWorld();
  // 1, 2 and 9 words: median 2, mean 4
  for (const wordCount of [1, 2, 9]) world.agent({ type: 'tess-write', lines: runLines({ turns: 1, wordCount }) });
  const row = rowOf(world.run(['--since', LONG_AGO]).stdout, 'tess-write');
  assert.equal(row, 'tess-write | 3 | 10.0k | 10.0k | 1 | 0 | 0 | 0 | 0 | 2');
});

test('one message id repeated over several lines counts as one turn and its usage once', () => {
  const world = makeWorld();
  // Claude Code writes one line per content block of a turn, each repeating the message id and its usage
  world.agent({
    type: 'dev',
    lines: [
      userLine(BRIEF),
      assistantLine('msg-1', [bashBlock()]),
      assistantLine('msg-1', [textBlock('thinking aloud')]),
      assistantLine('msg-1', [bashBlock()]),
      assistantLine('msg-2', [textBlock('done')]),
      assistantLine('msg-2', [textBlock('done')]),
    ],
  });
  const [dev] = world.report().runs;
  assert.equal(dev.turnsPerRun, 2);
  assert.equal(dev.contextPerRun, 2 * TURN_CONTEXT);
  assert.equal(dev.coldStart, TURN_CONTEXT);
});

test('an empty projects folder gives a zero table and `no runs since <iso>`, never a percentage', () => {
  const world = makeWorld();
  mkdirSync(join(world.config, 'projects'));
  const result = world.run(['--since', LONG_AGO]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /: 0 runs, 0 unreadable lines skipped$/m);
  assert.match(result.stdout, new RegExp(`^no runs since ${LONG_AGO}$`, 'm'));
  assert.deepEqual(rowsOf(result.stdout), []);
  assert.doesNotMatch(result.stdout, /\b0%/);
});

test('a missing projects folder gives a zero table and `no runs since <iso>`, never a percentage', () => {
  const world = makeWorld();
  const result = world.run(['--since', LONG_AGO]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^no runs since ${LONG_AGO}$`, 'm'));
  assert.deepEqual(rowsOf(result.stdout), []);
  assert.doesNotMatch(result.stdout, /\b0%/);
  assert.equal(result.stderr, '');
});

const BAD_FLAGS = [
  ['--since nope', ['--since', 'nope']],
  ['--since with no value', ['--since']],
  ['an unknown flag', ['--bogus']],
  ['--project ../x', ['--project', '../x']],
  ['--project ..', ['--project', '..']],
  ['--project a/b', ['--project', 'a/b']],
  ['an unknown project', ['--project', 'no-such-project']],
];
for (const [name, args] of BAD_FLAGS) {
  test(`${name} exits 2 with the usage line and prints no report`, () => {
    const world = makeWorld();
    world.agent({ type: 'dev', lines: runLines({ turns: 1 }) });
    // folders the traversal keys would reach if they were accepted
    mkdirSync(join(world.config, 'x'));
    mkdirSync(join(world.config, 'projects', 'a', 'b'), { recursive: true });
    const result = world.run(args);
    assert.equal(result.status, USAGE_EXIT, result.stderr);
    assert.match(result.stderr, /^agent-usage: /);
    assert.ok(result.stderr.split('\n').includes(USAGE_LINE), result.stderr);
    assert.equal(result.stdout, '');
  });
}

test('--project limits the rows to that project', () => {
  const world = makeWorld();
  world.agent({ type: 'dev', project: 'alpha', lines: runLines({ turns: 1 }) });
  world.agent({ type: 'tess', project: 'beta', lines: runLines({ turns: 1 }) });
  const all = world.report();
  assert.deepEqual(all.runs.map(({ type }) => type).sort(), ['dev', 'tess']);
  const alpha = world.report(['--project', 'alpha']);
  assert.equal(alpha.project, 'alpha');
  assert.deepEqual(alpha.runs.map(({ type }) => type), ['dev']);
});

test('--since skips a transcript last written before it', () => {
  const world = makeWorld();
  world.agent({ type: 'dev', lines: runLines({ turns: 1 }), mtime: OLD_MTIME });
  world.agent({ type: 'dev', lines: runLines({ turns: 3 }), mtime: NEW_MTIME });
  const result = world.run(['--since', SINCE_BETWEEN, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const { since, runs } = JSON.parse(result.stdout);
  assert.equal(since, SINCE_BETWEEN);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runs, 1);
  assert.equal(runs[0].turnsPerRun, 3, 'only the newer run is read');
});

test('a non-JSON line and a truncated last line are skipped and counted, and the rest is still read', () => {
  const world = makeWorld();
  const valid = runLines({ turns: 2 });
  const raw = `${JSON.stringify(valid[0])}\nthis is not json\n${valid.slice(1).map((line) => JSON.stringify(line)).join('\n')}\n`
    + '{"type":"assistant","message":{"id":"cut","usage":{"input_tokens":5';
  world.agent({ type: 'dev', raw });
  const result = world.run(['--since', LONG_AGO]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /: 1 runs, 2 unreadable lines skipped$/m);
  const report = world.report();
  assert.equal(report.skippedLines, 2);
  assert.equal(report.runs[0].turnsPerRun, 2);
});

test('an unreadable file is named on stderr and counted in `unreadable`, and the other runs are still read', { skip: cannotChmod }, (t) => {
  const world = makeWorld();
  const locked = world.agent({ type: 'dev', lines: runLines({ turns: 1 }) });
  world.agent({ type: 'tess', lines: runLines({ turns: 1 }) });
  chmodSync(locked, 0o000);
  t.after(() => chmodSync(locked, 0o600));
  const result = world.run(['--since', LONG_AGO, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, new RegExp(`^agent-usage: cannot read ${locked.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`, 'm'));
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.unreadable, [locked]);
  assert.ok(report.runs.some(({ type }) => type === 'tess'), 'the readable run is counted');
});

test('--json parses and has the keys since, project, runs, rules, bossRules, skippedLines and unreadable', () => {
  const world = makeWorld();
  world.agent({ type: 'dev', lines: runLines({ turns: 2 }) });
  const report = world.report();
  assert.deepEqual(Object.keys(report).sort(), JSON_KEYS);
  assert.equal(report.since, LONG_AGO);
  assert.equal(report.project, null);
  assert.ok(Array.isArray(report.runs));
  assert.deepEqual(Object.keys(report.rules), RULE_IDS);
  assert.equal(report.skippedLines, 0);
  assert.deepEqual(report.unreadable, []);
});

test('only counts are printed: a tool result and a last text holding a marker and an escape never reach stdout or stderr', () => {
  const world = makeWorld();
  world.agent({
    type: 'dev',
    lines: [
      userLine(`${BRIEF} ${SECRET_MARKER}`),
      assistantLine('msg-1', [bashBlock(`echo ${SECRET_MARKER}`)]),
      toolResultLine(`${ANSI_RED}${SECRET_MARKER}`),
      assistantLine('msg-2', [textBlock(`${ANSI_RED}${SECRET_MARKER} verdict: ok`)]),
    ],
  });
  world.boss({ lines: [userLine(SECRET_MARKER), assistantLine('msg-1', [textBlock(`${ANSI_RED}${SECRET_MARKER}`)])] });
  for (const flags of [[], ['--json']]) {
    const result = world.run(['--since', LONG_AGO, ...flags]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('dev'), 'the transcript was read');
    for (const stream of [result.stdout, result.stderr]) {
      assert.equal(stream.includes(SECRET_MARKER), false);
      assert.equal(stream.includes('\u001b'), false);
    }
  }
});

/** A dev run that starts background task `abc123` (a Bash result's own words), then `after` lines. */
function backgroundRun(after = []) {
  return [
    userLine(BRIEF),
    assistantLine('msg-1', [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test', run_in_background: true } }]),
    toolResultLine('Command running in background with ID: abc123. Output is being written to a file.'),
    ...after,
    assistantLine('msg-2', [textBlock('reported')]),
  ];
}

const leftRunning = (world) => world.report().rules.M7.runs;

test('M7: a background task with no end notice and no TaskStop counts as left running', () => {
  const world = makeWorld();
  world.agent({ type: 'dev', lines: backgroundRun() });
  assert.equal(leftRunning(world), 1);
});

test('M7: a background task whose <task-id> notice arrived later does not count as left running', () => {
  const world = makeWorld();
  world.agent({ type: 'dev', lines: backgroundRun([userLine('<task-notification><task-id>abc123</task-id> completed</task-notification>')]) });
  assert.equal(leftRunning(world), 0);
  assert.equal(world.report().runs[0].runs, 1, 'the run itself is counted');
});

test('M7: a background task ended by TaskStop does not count as left running', () => {
  const world = makeWorld();
  const stop = assistantLine('msg-stop', [{ type: 'tool_use', name: 'TaskStop', input: { task_id: 'abc123' } }]);
  world.agent({ type: 'dev', lines: backgroundRun([stop]) });
  assert.equal(leftRunning(world), 0);
  assert.equal(world.report().runs[0].taskStops, 1);
});

test('M7: a notice for another task id does not end the task', () => {
  const world = makeWorld();
  world.agent({ type: 'dev', lines: backgroundRun([userLine('<task-id>zzz999</task-id>')]) });
  assert.equal(leftRunning(world), 1);
});
