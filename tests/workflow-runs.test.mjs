// Tests for the live workflow runs: home/tools/estimate/lib/workflow-runs.mjs (live runs read from the session's workflow
// journals). Journals are synthetic files in a temp session folder laid out as
// Claude Code 2.1.326 writes them (probe P3): <session>/subagents/workflows/<runId>/journal.jsonl, <session>/workflows/<runId>.json
// for a finished run, <session>/workflows/scripts/<name>-<runId>.js for the script copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { liveRuns } from '../home/tools/estimate/lib/workflow-runs.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const NOW = 1_800_000_000_000;
const MIN_MS = 60_000;
const META = "export const meta = { name: 'build', description: 'a { brace } in text', phases: [{ title: 'Plan' }, { title: 'Build', detail: 'x' }, { title: 'Review' }, { title: 'Land' }] };\nawait agent('x');\n";
// The shapes Claude Code 2.1.326 writes (real journal wf_08afbeb5-043): only `started` carries label and phase; `result` has just the agent
// id (and its result text); `launched` has no agent at all.
const started = (agentId, label, phase) => JSON.stringify({ type: 'started', key: `v2:${agentId}`, agentId, label, phase });
const result = (agentId) => JSON.stringify({ type: 'result', key: `v2:${agentId}`, agentId, result: 'text', remoteControlDeviceReport: false, toolsUsed: ['Bash'] });
const LAUNCHED = JSON.stringify({ type: 'launched' });

/** A session folder: returns the transcript path the status line gets and helpers to add journals, summaries and script copies. */
async function session() {
  const root = makeTempDir('workflow-runs-');
  const dir = join(root, 'proj', 'sess-1');
  const journalOf = (runId) => join(dir, 'subagents', 'workflows', runId, 'journal.jsonl');
  return {
    transcriptPath: join(root, 'proj', 'sess-1.jsonl'),
    dir,
    journal(runId, lines, ageMin = 1) {
      mkdirSync(join(dir, 'subagents', 'workflows', runId), { recursive: true });
      writeFileSync(journalOf(runId), `${lines.join('\n')}\n`);
      utimesSync(journalOf(runId), new Date(NOW - ageMin * MIN_MS), new Date(NOW - ageMin * MIN_MS));
    },
    summary(runId) {
      mkdirSync(join(dir, 'workflows'), { recursive: true });
      writeFileSync(join(dir, 'workflows', `${runId}.json`), JSON.stringify({ runId, status: 'completed' }));
    },
    script(runId, text = META, name = 'build') {
      mkdirSync(join(dir, 'workflows', 'scripts'), { recursive: true });
      writeFileSync(join(dir, 'workflows', 'scripts', `${name}-${runId}.js`), text);
    },
    append: (runId, lines) => appendFileSync(journalOf(runId), `${lines.join('\n')}\n`),
    journalOf,
  };
}

const REVIEW_LINES = [
  LAUNCHED, started('a1', 'impl-a:plan', 'Plan'), result('a1'),
  ...['b1', 'b2', 'b3', 'b4'].map((id) => started(id, 'impl-a:review', 'Review')),
  result('b1'), result('b2'),
  started('b5', 'impl-a:fix', 'Review'),
];

test('a live run: its name, the row of the newest agent, the phase with its place in the script\'s phases, and agents done of agents seen', async () => {
  const s = await session();
  s.journal('wf_a', REVIEW_LINES);
  s.script('wf_a');
  assert.deepEqual(liveRuns(s.transcriptPath, NOW), [
    { runId: 'wf_a', name: 'build', row: 'impl-a', phase: 'Review', phaseIndex: 3, phaseTotal: 4, started: 5, done: 2 },
  ]);
});

test('result lines carry no label or phase: they count in the phase and row of the agent that started', async () => {
  const s = await session();
  s.journal('wf_a', [started('a1', 'impl-a:plan', 'Plan'), ...['b1', 'b2', 'b3', 'b4'].map((id) => started(id, `impl-${id}:review`, 'Review')), result('b1'), result('b2')]);
  s.script('wf_a');
  assert.deepEqual(liveRuns(s.transcriptPath, NOW), [
    { runId: 'wf_a', name: 'build', row: 'impl-b2', phase: 'Review', phaseIndex: 3, phaseTotal: 4, started: 4, done: 2 },
  ]);
});

test('a journal as Claude Code wrote it (wf_08afbeb5-043, results cut short): the phase and row come from the started lines', async () => {
  const s = await session();
  const real = [
    '{"type":"launched"}',
    '{"type":"started","key":"v2:fa56","agentId":"adbfd59422c35558d","label":"g1:c","phase":"G1"}',
    '{"type":"started","key":"v2:e924","agentId":"a51b4d53810c5b96e","label":"g1:a","phase":"G1"}',
    '{"type":"started","key":"v2:c118","agentId":"a953c02d717531869","label":"g1:b","phase":"G1"}',
    '{"type":"result","key":"v2:c118","agentId":"a953c02d717531869","result":"exit code: 0","remoteControlDeviceReport":false,"toolsUsed":["Bash"]}',
    '{"type":"result","key":"v2:fa56","agentId":"adbfd59422c35558d","result":"exit code: 0","remoteControlDeviceReport":false,"toolsUsed":["Bash"]}',
    '{"type":"result","key":"v2:e924","agentId":"a51b4d53810c5b96e","result":"exit code: 0","remoteControlDeviceReport":false,"toolsUsed":["Bash"]}',
  ];
  s.journal('wf_real', real);
  assert.deepEqual(liveRuns(s.transcriptPath, NOW).map((run) => [run.row, run.phase, run.started, run.done]), [['g1', 'G1', 3, 3]]);
});

test('a result whose agent has no started line in view is ignored, never counted in a made-up phase', async () => {
  const s = await session();
  s.journal('wf_a', [result('gone'), started('a1', 'impl-a:x', 'Plan'), result('a1'), result('gone')]);
  assert.deepEqual(liveRuns(s.transcriptPath, NOW).map((run) => [run.row, run.phase, run.started, run.done]), [['impl-a', 'Plan', 1, 1]]);
});

test('without the script copy the name is "workflow", the phase total is unknown and the place counts the phases seen so far', async () => {
  const s = await session();
  s.journal('wf_a', REVIEW_LINES);
  assert.deepEqual(liveRuns(s.transcriptPath, NOW), [
    { runId: 'wf_a', name: 'workflow', row: 'impl-a', phase: 'Review', phaseIndex: 2, phaseTotal: null, started: 5, done: 2 },
  ]);
});

test('a script copy whose meta has no phases, or whose meta cannot be read, gives no total; the name comes from the copy\'s file name', async () => {
  const s = await session();
  s.journal('wf_a', REVIEW_LINES);
  s.script('wf_a', "export const meta = { name: 'x' };\n", 'land');
  assert.equal(liveRuns(s.transcriptPath, NOW)[0].phaseTotal, null);
  assert.equal(liveRuns(s.transcriptPath, NOW)[0].name, 'x');
  s.script('wf_a', 'throw new Error("not a meta");', 'land');
  const [run] = liveRuns(s.transcriptPath, NOW);
  assert.deepEqual([run.name, run.phaseTotal], ['land', null]);
});

test('a label without a colon names no row; a run with no phase has none', async () => {
  const s = await session();
  s.journal('wf_a', [started('a1', 'Review security', 'Review')]);
  s.journal('wf_b', [JSON.stringify({ type: 'started', agentId: 'z', label: 'impl-b:x' })]);
  const runs = Object.fromEntries(liveRuns(s.transcriptPath, NOW).map((run) => [run.runId, run]));
  assert.equal(runs.wf_a.row, null);
  assert.deepEqual([runs.wf_b.row, runs.wf_b.phase, runs.wf_b.phaseIndex], ['impl-b', null, 0]);
});

test('a finished run (its summary json exists) and a journal untouched for 30 minutes are not live', async () => {
  const s = await session();
  s.journal('wf_done', REVIEW_LINES);
  s.summary('wf_done');
  s.journal('wf_old', REVIEW_LINES, 31);
  s.journal('wf_edge', REVIEW_LINES, 29);
  assert.deepEqual(liveRuns(s.transcriptPath, NOW).map((run) => run.runId), ['wf_edge']);
});

test('the newest journal comes first when several runs are live', async () => {
  const s = await session();
  s.journal('wf_a', REVIEW_LINES, 5);
  s.journal('wf_b', REVIEW_LINES, 1);
  s.journal('wf_c', REVIEW_LINES, 3);
  assert.deepEqual(liveRuns(s.transcriptPath, NOW).map((run) => run.runId), ['wf_b', 'wf_c', 'wf_a']);
});

test('garbage never shows: bad JSON lines, wrong shapes and unknown types are skipped; a journal with nothing usable is no run', async () => {
  const s = await session();
  s.journal('wf_a', ['{not json', '[]', '"text"', 'null', JSON.stringify({ type: 'surprise', agentId: 'q', label: 'x:y', phase: 'P' }), JSON.stringify({ type: 'started', agentId: 5, label: 7 }), started('a1', 'r:s', 'Plan')]);
  assert.deepEqual(liveRuns(s.transcriptPath, NOW).map((run) => [run.row, run.phase, run.started, run.done]), [['r', 'Plan', 1, 0]]);
  s.journal('wf_b', ['{not json', '', '[1]']);
  s.journal('wf_c', []);
  assert.deepEqual(liveRuns(s.transcriptPath, NOW).map((run) => run.runId), ['wf_a']);
});

test('control characters and over-long text in a label, a phase or a script name never reach the line', async () => {
  const s = await session();
  s.journal('wf_a', [started('a1', `ro\u001b[31mw${'x'.repeat(100)}:step`, 'Pha\u0007se\n2')]);
  s.script('wf_a', "export const meta = { name: 'na\u001bme', phases: [{ title: 'Phase' }] };\n");
  const [run] = liveRuns(s.transcriptPath, NOW);
  for (const text of [run.name, run.row, run.phase]) assert.doesNotMatch(text, /[\u0000-\u001f\u007f-\u009f]/);
  assert.ok(run.row.length <= 24 && run.row.startsWith('ro'), run.row);
});

const LONG_NAME = 'remove-modes-delta-review-pass'; // 30 characters: the screenshot's names were cut at 16 mid-word
const WIDEST_READER_NAME = 40; // agent-rows.mjs WIDE_RUN_NAME_CHARS: a stored name over this lets the reader mark its cut
const MAX_STORED_NAME = 64;

test('a 30-character workflow name is kept whole, from the script meta and from the script file name; one of 41 to 64 is kept whole too (a reader marks its cut); a longer one is cut at 64', async () => {
  assert.equal(LONG_NAME.length, 30);
  const s = await session();
  s.journal('wf_a', REVIEW_LINES);
  s.script('wf_a', `export const meta = { name: '${LONG_NAME}', phases: [{ title: 'Review' }] };\n`);
  assert.equal(liveRuns(s.transcriptPath, NOW)[0].name, LONG_NAME);
  s.script('wf_a', "export const meta = { phases: [{ title: 'Review' }] };\n", LONG_NAME);
  assert.equal(liveRuns(s.transcriptPath, NOW)[0].name, LONG_NAME);
  for (const length of [WIDEST_READER_NAME, WIDEST_READER_NAME + 1, MAX_STORED_NAME]) {
    s.script('wf_a', `export const meta = { name: '${'n'.repeat(length)}' };\n`);
    assert.equal(liveRuns(s.transcriptPath, NOW)[0].name.length, length);
  }
  s.script('wf_a', `export const meta = { name: '${'n'.repeat(100)}' };\n`);
  assert.equal(liveRuns(s.transcriptPath, NOW)[0].name.length, MAX_STORED_NAME);
});

test('no or odd transcript path, a missing session folder, a run id that is no plain name: nothing, never a throw', async () => {
  const s = await session();
  for (const path of [undefined, null, 5, '', 'relative/x.jsonl', join(s.dir, 'x.txt'), s.transcriptPath]) assert.deepEqual(liveRuns(path, NOW), [], String(path));
  s.journal('..', REVIEW_LINES);
  s.journal('a b', REVIEW_LINES);
  assert.deepEqual(liveRuns(s.transcriptPath, NOW), []);
});

test('a journal over 256 KB is read from its tail: right counts when the tail shows the phase began in it, nothing when it cannot', async () => {
  const s = await session();
  const filler = (phase, count) => Array.from({ length: count }, (_, k) => [started(`f${k}`, `old:${k}`, phase), result(`f${k}`)]).flat();
  s.journal('wf_big', [...filler('Plan', 30_000), ...REVIEW_LINES.slice(3)]); // about 8 MB: Plan lines, then the Review lines
  s.script('wf_big');
  assert.deepEqual(liveRuns(s.transcriptPath, NOW).map((run) => [run.phase, run.started, run.done]), [['Review', 5, 2]]);
  s.journal('wf_flat', filler('Review', 30_000)); // the whole tail is one phase: its start is out of sight
  assert.deepEqual(liveRuns(s.transcriptPath, NOW).map((run) => run.runId), ['wf_big']);
});

test('a 10 MB journal is read in under 100 ms of CPU time (p95 of 20 reads; CPU time, so a busy machine does not fail it)', async () => {
  const s = await session();
  const lines = Array.from({ length: 50_000 }, (_, k) => [started(`f${k}`, `old:${k}`, k < 49_990 ? 'Plan' : 'Review'), result(`f${k}`)]).flat();
  s.journal('wf_big', lines);
  const times = Array.from({ length: 20 }, () => {
    const from = process.cpuUsage();
    liveRuns(s.transcriptPath, NOW);
    const { user, system } = process.cpuUsage(from);
    return (user + system) / 1000;
  }).sort((a, b) => a - b);
  assert.ok(times[18] < 100, `p95 ${times[18]} ms`);
  assert.equal(liveRuns(s.transcriptPath, NOW)[0].started, 10);
});
