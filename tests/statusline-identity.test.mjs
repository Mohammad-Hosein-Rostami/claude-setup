// Tests for the status line's identity colours (spec-tui-3, "which is where"): each work item keeps one hue for its name, a
// workflow on a lane branch shares that branch's hue with its git row, the 16-colour and NO_COLOR fallbacks, names cut at a
// boundary, and the render time from fixtures. Renders through home/tools/board/lib/render.mjs statusRows (pure, no I/O).
import test from 'node:test';
import assert from 'node:assert/strict';
import { statusRows } from '../home/tools/board/lib/render.mjs';
import { lookFor, NO_COLOR_ENV, NOW, screenshotBoard, TERM_16, TERM_256, viewOf } from './statusline-identity-fixture.mjs';

const MARKERS = ['●', '◆', '▲'];
const SAMPLE_NAMES = ['remove-modes', 'road-gate-landed-row', 'sync-remote-path', 'statusline-identity-colours', 'build', 'review'];
const RENDERS_TIMED = 21;
const MAX_MEDIAN_MS = 100;
const ESCAPE = '\u001b';

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rowsOf = (board, env, columns) => statusRows(viewOf(board, NOW, env), lookFor(env, columns));
const rowWith = (rows, lead, name) => rows.find((row) => new RegExp(`${lead} \\S ${escapeRe(name)}`).test(row.replaceAll(/\u001b\[[0-9;]*m/g, '')));

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

test('a workflow whose agents work in a lane worktree shows `on <branch>` and shares the branch git row\'s hue and marker', () => {
  const rows = rowsOf(screenshotBoard(), TERM_256, 160);
  for (const [workflow, branch] of [['remove-modes-delta-review', 'remove-modes'], ['road-gate-landed-row', 'road-gate-landed-row']]) {
    const runRow = rowWith(rows, '▸', workflow);
    const gitRow = rowWith(rows, '⎇', branch);
    assert.ok(runRow && gitRow, `${workflow} and the ${branch} git row are shown`);
    assert.deepEqual(identityOn(runRow, workflow), identityOn(gitRow, branch));
    assert.ok(runRow.includes(`${identityOn(runRow, workflow).codes}on ${branch}`), `on ${branch} in its hue`);
  }
  const unplaced = rowWith(rows, '▸', 'statusline-identity-colours');
  assert.ok(unplaced && !/ on /.test(unplaced), 'a workflow on no known worktree names no branch');
  assert.notDeepEqual(identityOn(unplaced, 'statusline-identity-colours'), identityOn(rowWith(rows, '⎇', 'sync-remote-path'), 'sync-remote-path'));
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
  const rows = rowsOf(screenshotBoard(), TERM_16, 160);
  assert.ok(rows.every((row) => !row.includes('38;5;')));
  const names = ['remove-modes-delta-review', 'statusline-identity-colours', 'road-gate-landed-row'];
  const looks = names.map((name) => identityOn(rowWith(rows, '▸', name), name));
  for (const look of looks) assert.match(look?.codes ?? 'none', /^(\u001b\[1m|\u001b\[4m|)$/);
  assert.equal(new Set(looks.map((look) => `${look.codes}|${look.marker}`)).size, names.length);
  assert.deepEqual(identityOn(rowWith(rows, '⎇', 'remove-modes'), 'remove-modes'), looks[0]);
});

test('NO_COLOR prints no escape code and keeps the marker shapes, the same on a workflow row and its branch row', () => {
  const rows = rowsOf(screenshotBoard(), NO_COLOR_ENV, 120);
  assert.ok(rows.every((row) => !row.includes(ESCAPE)));
  const runLook = identityOn(rowWith(rows, '▸', 'remove-modes-delta-review'), 'remove-modes-delta-review');
  assert.ok(MARKERS.includes(runLook?.marker));
  assert.equal(identityOn(rowWith(rows, '⎇', 'remove-modes'), 'remove-modes')?.marker, runLook.marker);
  assert.ok(MARKERS.includes(identityOn(rowWith(rows, '⎇', 'sync-remote-path'), 'sync-remote-path')?.marker));
  const runMarkers = ['remove-modes-delta-review', 'statusline-identity-colours', 'road-gate-landed-row'].map((name) => identityOn(rowWith(rows, '▸', name), name)?.marker);
  assert.equal(new Set(runMarkers).size, 3, `three items on screen get three marker shapes: ${runMarkers}`);
});

test('ASCII mode prints no byte above 0x7E with the new glyphs', () => {
  const env = { ...NO_COLOR_ENV, CLAUDE_STATUS_ASCII: '1' };
  for (const columns of [80, 120, 160]) for (const row of rowsOf(screenshotBoard(), env, columns)) assert.doesNotMatch(row, /[^ -~]/, row);
});

test('a workflow name is cut at a `-` boundary with …, and at 80 columns the whole name wins over the phase word', () => {
  const long = 'remove-modes-delta-review-of-every-lane-in-round-nine';
  const rows = rowsOf(boardOfRuns([long]), NO_COLOR_ENV, 80);
  const shown = /▸ \S (\S+)…/.exec(rows.find((row) => row.startsWith('▸')) ?? '')?.[1];
  assert.ok(shown && long.startsWith(`${shown}-`), `cut at a boundary: ${shown}`);
  const whole = rowsOf(screenshotBoard(), NO_COLOR_ENV, 80);
  for (const name of ['remove-modes-delta-review', 'statusline-identity-colours', 'road-gate-landed-row']) {
    assert.ok(rowWith(whole, '▸', name), `${name} whole at 80 columns`);
  }
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
