// Tests for the status line's identity colours (spec-tui-3, "which is where"): each work item keeps one hue for its name, a
// workflow on a lane branch shares that branch's hue with its git row, the 16-colour and NO_COLOR fallbacks, names cut at a
// boundary, and the render time from fixtures. Renders through home/tools/board/lib/render.mjs statusRows (pure, no I/O).
import test from 'node:test';
import assert from 'node:assert/strict';
import { statusRows } from '../home/tools/board/lib/render.mjs';
import { lookFor, NO_COLOR_ENV, NOW, placedWriterBoard, screenshotBoard, TERM_16, TERM_256, viewOf } from './statusline-identity-fixture.mjs';

const MARKERS = ['●', '◆', '▲'];
const SAMPLE_NAMES = ['remove-modes', 'road-gate-landed-row', 'sync-remote-path', 'statusline-identity-colours', 'build', 'review'];
const RENDERS_TIMED = 21;
const MAX_MEDIAN_MS = 100;
const ESCAPE = '\u001b';

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rowsOf = (board, env, columns) => statusRows(viewOf(board, NOW, env), lookFor(env, columns));
const plain = (row) => (row ?? '').replaceAll(/\u001b\[[0-9;]*m/g, '');
const rowWith = (rows, lead, name) => rows.find((row) => new RegExp(`${lead} \\S ${escapeRe(name)}`).test(plain(row)));

/** The identity look of an item on a row: the escape codes before its row glyph, and its marker (`▸ ● name`, `⎇ ◆ name`). */
function identityOn(row, name) {
  const match = new RegExp(`((?:\\u001b\\[[0-9;]*m)*)(?:▸|⎇) (\\S) ${escapeRe(name)}`).exec(row ?? '');
  return match === null ? null : { codes: match[1], marker: match[2] };
}

const boardOfRuns = (names) => ({
  ...screenshotBoard(), agents: [],
  runs: names.map((name, index) => ({ ...screenshotBoard().runs[0], runId: `wf_${index}`, name })),
  repo: { ...screenshotBoard().repo, worktrees: screenshotBoard().repo.worktrees.filter((wt) => wt.main) },
});

test('a name keeps its hue in every render whatever the order, and the six sample names get six different hues', () => {
  const hues = (names) => {
    const rows = rowsOf(boardOfRuns(names), TERM_256, 160);
    return new Map(names.map((name) => [name, identityOn(rowWith(rows, '▸', name), name)?.codes]));
  };
  const first = hues(SAMPLE_NAMES);
  for (const [name, codes] of first) assert.match(codes ?? '', /^\u001b\[38;5;\d+m$/, `${name} has a 256-colour hue`);
  assert.equal(new Set(first.values()).size, SAMPLE_NAMES.length);
  assert.deepEqual(hues([...SAMPLE_NAMES].reverse()), first);
  assert.deepEqual(hues(SAMPLE_NAMES), first);
});




test('main is bold in the default colour, and the section labels lead their rows', () => {
  const rows = rowsOf(screenshotBoard(), TERM_256, 160);
  assert.ok(rows.some((row) => row.startsWith('\u001b[1m⎇ claude-setup:main')), 'main row: bold ⎇ and name, no hue');
  assert.ok(rows.some((row) => row.startsWith('\u001b[1mALL')), 'job row: ALL in bold');
  assert.ok(rows.some((row) => row.startsWith('\u001b[32mchecks: test types')), 'checks row: the categories on in green');
  assert.ok(rows.some((row) => row.startsWith('\u001b[2mΣ \u001b[0m\u001b[36m3 workflows')), 'counts row: a dim Σ');
  assert.ok(rows.at(-1).includes('\u001b[2mctx\u001b[0m\u001b[32m 99k'), 'session row: a dim ctx label, the value in its gradient colour');
  assert.ok(rows.at(-1).includes('\u001b[2macct\u001b[0m work'), 'session row: a dim acct label');
});

test('a 16-colour terminal gets no 256-colour codes and tells items apart by bold, underline or plain with the marker', () => {
  const rows = rowsOf(placedWriterBoard(), TERM_16, 160);
  assert.ok(rows.every((row) => !row.includes('38;5;')));
  const names = ['remove-modes-delta-review', 'statusline-identity-colours', 'road-gate-landed-row'];
  const looks = names.map((name) => identityOn(rowWith(rows, '▸', name), name));
  for (const look of looks) assert.match(look?.codes ?? 'none', /^(\u001b\[1m|\u001b\[4m|)$/);
  assert.equal(new Set(looks.map((look) => `${look.codes}|${look.marker}`)).size, names.length);
  assert.deepEqual(identityOn(rowWith(rows, '⎇', 'remove-modes'), 'remove-modes'), looks[0]);
  const six = rowsOf(boardOfRuns(SAMPLE_NAMES), TERM_16, 160);
  const sixLooks = SAMPLE_NAMES.map((name) => identityOn(rowWith(six, '▸', name), name)).map((look) => `${look?.codes}|${look?.marker}`);
  assert.equal(new Set(sixLooks).size, SAMPLE_NAMES.length, 'six items, six looks from style and shape');
});


test('ASCII mode prints no byte above 0x7E with the new glyphs', () => {
  const env = { ...NO_COLOR_ENV, CLAUDE_STATUS_ASCII: '1' };
  for (const columns of [80, 120, 160]) for (const row of rowsOf(screenshotBoard(), env, columns)) assert.doesNotMatch(row, /[^ -~]/, row);
});



test(`a render from the fixture takes at most ${MAX_MEDIAN_MS} ms (median of ${RENDERS_TIMED})`, () => {
  const board = screenshotBoard();
  const times = Array.from({ length: RENDERS_TIMED }, () => {
    const start = performance.now();
    rowsOf(board, TERM_256, 160);
    return performance.now() - start;
  }).sort((a, b) => a - b);
  assert.ok(times[Math.floor(RENDERS_TIMED / 2)] <= MAX_MEDIAN_MS, `median ${times[Math.floor(RENDERS_TIMED / 2)]} ms`);
});
