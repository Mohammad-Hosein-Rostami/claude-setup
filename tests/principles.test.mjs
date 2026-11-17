// Round 5 lane A text checks: the principle table P1-P13, the architect's contract block and self-attack list, the
// agent timeout / no-poll / no-full-suite lines, and the home/CLAUDE.md gate, long-command and workflow lines.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

const PRINCIPLE_IDS = Array.from({ length: 13 }, (_, index) => `P${index + 1}`);

/** Rows of the principle table: `id | areas | principle | yes/no question | mechanical check`. */
function principleRows() {
  return read('home/rules/principles.md')
    .split('\n')
    .filter((line) => /^P\d+ \|/.test(line))
    .map((line) => line.split(' | ').map((cell) => cell.trim()));
}

test('principles.md has one row per principle P1-P13, in order, with all five cells filled', () => {
  const rows = principleRows();
  assert.deepEqual(rows.map((row) => row[0]), PRINCIPLE_IDS);
  for (const row of rows) {
    assert.equal(row.length, 5, `${row[0]} needs id, areas, principle, question, check`);
    assert.ok(row.every((cell) => cell.length > 0), `${row[0]} has an empty cell`);
    assert.match(row[3], /\?$/, `${row[0]} question must be a yes/no question`);
  }
});

test('principles.md states the header and who reads the table', () => {
  const text = read('home/rules/principles.md');
  assert.match(text, /id \| areas \| principle \| yes\/no question \| mechanical check/);
  assert.match(text, /a no is a finding/i);
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
    P11: /worktree-wf_/,
    P12: /wall-clock/i,
    P13: /--add-class audit/,
  };
  for (const [id, pattern] of Object.entries(expected)) assert.match(byId[id], pattern, `${id} text`);
});

test('architect.md asks for a Contract block per lane with every field the build workflow reads', () => {
  const text = read('home/agents/architect.md');
  assert.match(text, /\*\*Contract\*\*/);
  for (const field of ['`files`', '`principles`', '`checkpoints`', '`exit`', '`kind`', '`addClasses`', '`appendOnly`']) {
    assert.ok(text.includes(field), `architect.md must name ${field}`);
  }
  for (const kind of ['red-first', 'keeps-working']) assert.ok(text.includes(kind), `architect.md must name ${kind}`);
  assert.match(text, /changes an interface[^.]*`keeps-working`[^.]*callers/i);
  assert.match(text, /about 120 tool calls/);
  assert.match(text, /no (two lanes share a|shared) file/i);
  assert.match(text, /gate[^.]*`addClasses`/i);
  assert.match(text, /never drop/i);
});

test('architect.md carries the critic-class self-attack list and the probe-first rule', () => {
  const text = read('home/agents/architect.md');
  const selfAttack = text.split('\n').filter((line) => /^\s*\d+\. /.test(line) && /\?/.test(line));
  assert.ok(selfAttack.length >= 8, `self-attack list needs 8 questions, found ${selfAttack.length}`);
  for (const topic of [/remove a check/i, /measurement/i, /unprobed platform/i, /owner'?s? (real )?layout/i, /writer-supplied/i, /empty input/i, /aggregate/i, /fix regression/i]) {
    assert.match(selfAttack.join('\n'), topic, `self-attack list must cover ${topic}`);
  }
  assert.match(text, /probe[^.]*before (you )?(design|decid)/i);
});

const LANE_AGENTS = ['implementer', 'test-writer', 'ui-implementer'];

test('lane agents: Bash timeout 600000 for suite and commit, 60000 for probes, no polling, no fixed sleep loop', () => {
  for (const agent of [...LANE_AGENTS, 'runner']) {
    const text = read(`home/agents/${agent}.md`);
    assert.match(text, /timeout.{0,40}600000/s, `${agent}.md names the 600000 timeout`);
    assert.match(text, /60000/, `${agent}.md names the 60000 probe timeout`);
    assert.match(text, /never poll/i, `${agent}.md forbids polling`);
    assert.doesNotMatch(text, /until <test>; do sleep/, `${agent}.md drops the sleep-loop recipe`);
    assert.doesNotMatch(text, /Start long commands in the background/, `${agent}.md no longer backgrounds long commands`);
  }
});

test('lane agents never run the full suite inside a lane', () => {
  for (const agent of LANE_AGENTS) {
    assert.match(read(`home/agents/${agent}.md`), /never run the full suite/i, `${agent}.md`);
  }
});

test('implementer: a locked contract file is never edited, the dispute line is written instead', () => {
  const text = read('home/agents/implementer.md');
  assert.match(text, /contract-dispute: <file>: <why>/);
  assert.match(text, /never edit/i);
});

test('home/CLAUDE.md Reviews line: waived lane audit after land, sync and push wait for audit-log gate', () => {
  const claude = read('home/CLAUDE.md');
  const line = claude.split('\n').find((candidate) => candidate.startsWith('- Reviews:')) ?? '';
  assert.match(line, /risky, `gate` and hooks[^;.]*Opus max/);
  assert.match(line, /waived lane[^.]*post-land audit/);
  assert.match(line, /every waived lane is audited/i);
  assert.match(line, /audit-log gate/);
  assert.match(line, /`rework:` row/);
  assert.match(line, /audit-log resolve/);
});

test('home/CLAUDE.md: long-command line says ~5 min, not ~2 min', () => {
  const claude = read('home/CLAUDE.md');
  assert.match(claude, /A command over ~5 min runs in background with a timeout and `watch\.mjs`/);
  assert.doesNotMatch(claude, /A command over ~2 min/);
});

test('home/CLAUDE.md Workflows line: contract first, probes beside lanes, repos apart, one critic round, one sync', () => {
  const claude = read('home/CLAUDE.md');
  const line = claude.split('\n').find((candidate) => candidate.startsWith('- Workflows always')) ?? '';
  assert.match(line, /contract first/i);
  assert.match(line, /probes (run )?beside (the )?lanes/i);
  assert.match(line, /independent repos[^.;]*separate workflows/i);
  assert.match(line, /one critic round[^.;]*delta check/i);
  assert.match(line, /sync once per job/i);
});

test('docs/catalog.md lists principles.md among the rules', () => {
  assert.match(read('docs/catalog.md'), /\| `principles\.md` \|/);
});
