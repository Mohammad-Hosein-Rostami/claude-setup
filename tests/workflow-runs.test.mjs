// Tests for the status line's workflow lines: home/tools/estimate/lib/workflow-runs.mjs (live runs read from the session's workflow
// journals) and lib/progress-line.mjs (the job bar and the run lines). Journals are synthetic files in a temp session folder laid out as
// Claude Code 2.1.326 writes them (probe P3): <session>/subagents/workflows/<runId>/journal.jsonl, <session>/workflows/<runId>.json
// for a finished run, <session>/workflows/scripts/<name>-<runId>.js for the script copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { progressLines } from '../home/tools/estimate/lib/progress-line.mjs';
import { liveRuns } from '../home/tools/estimate/lib/workflow-runs.mjs';

const NOW = 1_800_000_000_000;
const MIN_MS = 60_000;
const META = "export const meta = { name: 'build', description: 'a { brace } in text', phases: [{ title: 'Plan' }, { title: 'Build', detail: 'x' }, { title: 'Review' }, { title: 'Land' }] };\nawait agent('x');\n";
const entry = (type, agentId, label, phase) => JSON.stringify({ type, agentId, label, phase });

/** A session folder: returns the transcript path the status line gets and helpers to add journals, summaries and script copies. */
async function session() {
  const root = await mkdtemp(join(tmpdir(), 'workflow-runs-'));
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
  entry('launched', 'a1', 'impl-a:plan', 'Plan'), entry('started', 'a1', 'impl-a:plan', 'Plan'), entry('result', 'a1', 'impl-a:plan', 'Plan'),
  ...['b1', 'b2', 'b3', 'b4'].flatMap((id) => [entry('launched', id, 'impl-a:review', 'Review'), entry('started', id, 'impl-a:review', 'Review')]),
  entry('result', 'b1', 'impl-a:review', 'Review'), entry('result', 'b2', 'impl-a:review', 'Review'),
  entry('launched', 'b5', 'impl-a:fix', 'Review'),
];

test('a live run: its name, the row of the newest agent, the phase with its place in the script\'s phases, and agents done of agents seen', async () => {
  const s = await session();
  s.journal('wf_a', REVIEW_LINES);
  s.script('wf_a');
  assert.deepEqual(liveRuns(s.transcriptPath, NOW), [
    { runId: 'wf_a', name: 'build', row: 'impl-a', phase: 'Review', phaseIndex: 3, phaseTotal: 4, started: 5, done: 2 },
  ]);
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
  s.journal('wf_a', [entry('launched', 'a1', 'Review security', 'Review')]);
  s.journal('wf_b', [JSON.stringify({ type: 'launched', agentId: 'z', label: 'impl-b:x' })]);
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
  s.journal('wf_a', ['{not json', '[]', '"text"', 'null', JSON.stringify({ type: 'surprise', agentId: 'q', label: 'x:y', phase: 'P' }), JSON.stringify({ type: 'started', agentId: 5, label: 7 }), entry('started', 'a1', 'r:s', 'Plan')]);
  assert.deepEqual(liveRuns(s.transcriptPath, NOW).map((run) => [run.row, run.phase, run.started, run.done]), [['r', 'Plan', 1, 0]]);
  s.journal('wf_b', ['{not json', '', '[1]']);
  s.journal('wf_c', []);
  assert.deepEqual(liveRuns(s.transcriptPath, NOW).map((run) => run.runId), ['wf_a']);
});

test('control characters and over-long text in a label, a phase or a script name never reach the line', async () => {
  const s = await session();
  s.journal('wf_a', [entry('started', 'a1', `ro\u001b[31mw${'x'.repeat(100)}:step`, 'Pha\u0007se\n2')]);
  s.script('wf_a', "export const meta = { name: 'na\u001bme', phases: [{ title: 'Phase' }] };\n");
  const [run] = liveRuns(s.transcriptPath, NOW);
  for (const text of [run.name, run.row, run.phase]) assert.doesNotMatch(text, /[\u0000-\u001f\u007f-\u009f]/);
  assert.ok(run.row.length <= 24 && run.row.startsWith('ro'), run.row);
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
  const filler = (phase, count) => Array.from({ length: count }, (_, k) => entry('result', `f${k}`, `old:${k}`, phase));
  s.journal('wf_big', [...filler('Plan', 60_000), ...REVIEW_LINES.slice(3)]); // about 6 MB: Plan lines, then the Review lines
  s.script('wf_big');
  assert.deepEqual(liveRuns(s.transcriptPath, NOW).map((run) => [run.phase, run.started, run.done]), [['Review', 5, 2]]);
  s.journal('wf_flat', filler('Review', 60_000)); // the whole tail is one phase: its start is out of sight
  assert.deepEqual(liveRuns(s.transcriptPath, NOW).map((run) => run.runId), ['wf_big']);
});

test('a 10 MB journal is read in under 100 ms of CPU time (p95 of 20 reads; CPU time, so a busy machine does not fail it)', async () => {
  const s = await session();
  const lines = Array.from({ length: 100_000 }, (_, k) => entry('result', `f${k}`, `old:${k}`, k < 99_990 ? 'Plan' : 'Review'));
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

const BAR_PROGRESS = { pct: 54, approx: false, rowsDone: 5, rowsTotal: 9, leftMin: 30, tag: null };
const RUN = { runId: 'wf_a', name: 'build', row: 'impl-a', phase: 'Review', phaseIndex: 3, phaseTotal: 4, started: 7, done: 5 };
const lines = (progress, runs, columns, color = false) => progressLines(progress, runs, { columns, color });

test('the job bar: 12 cells from 100 columns, 8 from 70, text only below; the percent, rows and tag follow', () => {
  assert.deepEqual(lines(BAR_PROGRESS, [], 120), ['######------ 54% · 5/9 rows · 30 min left']);
  assert.deepEqual(lines(BAR_PROGRESS, [], 80), ['####---- 54% · 5/9 rows']);
  assert.deepEqual(lines(BAR_PROGRESS, [], 60), ['54% · 5/9 rows']);
  assert.deepEqual(lines({ ...BAR_PROGRESS, approx: true, leftMin: null, tag: 'overdue' }, [], 120), ['######------ ~54% · 5/9 rows · overdue']);
  assert.deepEqual(lines({ ...BAR_PROGRESS, tag: '+rows' }, [], 60), ['54% · 5/9 rows · +rows']);
  assert.deepEqual(lines({ ...BAR_PROGRESS, pct: 100, rowsDone: 9, leftMin: 0 }, [], 120), ['############ 100% · 9/9 rows']);
  assert.deepEqual(lines({ ...BAR_PROGRESS, pct: 0, rowsDone: 0 }, [], 80), ['-------- 0% · 0/9 rows']);
  assert.equal(lines({ ...BAR_PROGRESS, pct: 99, leftMin: 1 }, [], 120)[0].slice(0, 12), '###########-', 'a full bar means 100%');
});

test('with color the glyphs are blocks and the line is green, yellow when moved or rows were added, red when overdue', () => {
  assert.equal(lines(BAR_PROGRESS, [], 120, true)[0], '\u001b[32m██████░░░░░░ 54% · 5/9 rows · 30 min left\u001b[0m');
  assert.match(lines({ ...BAR_PROGRESS, tag: 'moved' }, [], 120, true)[0], /^\u001b\[33m/);
  assert.match(lines({ ...BAR_PROGRESS, tag: '+rows' }, [], 120, true)[0], /^\u001b\[33m/);
  assert.match(lines({ ...BAR_PROGRESS, tag: 'overdue' }, [], 120, true)[0], /^\u001b\[31m/);
  assert.doesNotMatch(lines(BAR_PROGRESS, [], 120)[0], /[█░\u001b]/, 'no color: ASCII only');
});

test('a run line: workflow, row, phase with its place, agents done of agents seen; at most two runs, one line each', () => {
  assert.deepEqual(lines(null, [RUN], 120), ['wf build impl-a · Review (3/4) · 5/7 agents']);
  assert.deepEqual(lines(null, [{ ...RUN, row: null, phaseTotal: null, phaseIndex: 2 }], 120), ['wf build · Review (2/?) · 5/7 agents']);
  assert.deepEqual(lines(null, [{ ...RUN, phase: null, phaseIndex: 0 }], 120), ['wf build impl-a · 5/7 agents']);
  assert.deepEqual(lines(BAR_PROGRESS, [RUN, { ...RUN, runId: 'wf_b', name: 'review' }, { ...RUN, runId: 'wf_c', name: 'land' }], 120).slice(1), [
    'wf build impl-a · Review (3/4) · 5/7 agents', 'wf review impl-a · Review (3/4) · 5/7 agents',
  ]);
  assert.deepEqual(lines(null, [], 120), []);
});

test('no line is wider than the terminal at 120, 80 and 60 columns, with the longest texts', () => {
  const long = { ...RUN, name: 'x'.repeat(16), row: 'y'.repeat(24), phase: 'z'.repeat(24), phaseIndex: 12, phaseTotal: 12, started: 1000, done: 999 };
  const widest = { pct: 99, approx: true, rowsDone: 229, rowsTotal: 230, leftMin: 12_345, tag: '+rows' };
  for (const columns of [120, 80, 60, 20]) {
    for (const line of lines(widest, [long, long], columns)) assert.ok([...line].length <= columns, `${columns}: ${line}`);
    for (const line of lines(widest, [long, long], columns, true)) assert.ok([...line.replace(/\u001b\[\d+m/g, '')].length <= columns, `${columns} color: ${line}`);
  }
});
