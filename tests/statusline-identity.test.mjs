// Tests for the identity colours (spec-tui-3, "which is where"): each work item (an agent or a lane branch) keeps one hue for its
// name, an agent placed on a lane branch shares that branch's hue with its branch row, the 16-colour and NO_COLOR fallbacks, names
// cut at a boundary, and the render time from fixtures. Since RC5 (2026-11-22) the hues are drawn only by `/where`
// (home/tools/board/lib/tree.mjs whereTree); the status line (render.mjs statusRows, pure, no I/O) has dim labels and no hue.
import test from 'node:test';
import assert from 'node:assert/strict';
import { statusRows } from '../home/tools/board/lib/render.mjs';
import { whereTree } from '../home/tools/board/lib/tree.mjs';
import { agentNamed, lookFor, NO_COLOR_ENV, NOW, placedWriterBoard, screenshotBoard, TERM_16, TERM_256, viewOf } from './statusline-identity-fixture.mjs';

const MARKERS = ['●', '◆', '▲'];
const SAMPLE_NAMES = ['remove-modes', 'road-gate', 'sync-remote', 'status-colours', 'build', 'review']; // short: an agent name column is 16 to 22 wide
const RENDERS_TIMED = 21;
const MAX_MEDIAN_MS = 100;
const ESCAPE = '\u001b';

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rowsOf = (board, env, columns) => statusRows(viewOf(board, NOW, env), lookFor(env, columns));
/** The `/where` lines of a board (the agent and git rows that carry the identity hues). */
const whereOf = (board, env, columns) => whereTree({ segment: null, board, asking: null, limits: [], lastSeen: null, nowMs: NOW, timeZone: 'UTC' }, lookFor(env, columns));
const plain = (row) => (row ?? '').replaceAll(/\u001b\[[0-9;]*m/g, '');
const rowWith = (rows, lead, name) => rows.find((row) => new RegExp(`${lead} \\S ${escapeRe(name)}`).test(plain(row)));

/** The identity look of an item on a row: the escape codes before its marker, and the marker (`⎇ ◆ name` branch row, ` ├ ● name` agent row). */
function identityOn(row, name) {
  const codes = '((?:\\u001b\\[[0-9;]*m)*)';
  const match = new RegExp(`${codes}⎇ (\\S) ${escapeRe(name)}`).exec(row ?? '') ?? new RegExp(`[├└] ${codes}(\\S) ${escapeRe(name)}`).exec(row ?? '');
  return match === null ? null : { codes: match[1], marker: match[2] };
}

const boardOfAgents = (names) => ({
  ...screenshotBoard(), agents: names.map((name) => agentNamed(name)),
  repo: { ...screenshotBoard().repo, worktrees: screenshotBoard().repo.worktrees.filter((wt) => wt.main) },
});

test('a name keeps its hue in every render whatever the order, and the six sample names get six different hues', () => {
  const hues = (names) => {
    const rows = whereOf(boardOfAgents(names), TERM_256, 160);
    return new Map(names.map((name) => [name, identityOn(rows.find((row) => plain(row).includes(` ${name}`)), name)?.codes]));
  };
  const first = hues(SAMPLE_NAMES);
  for (const [name, codes] of first) assert.match(codes ?? '', /^\u001b\[38;5;\d+m$/, `${name} has a 256-colour hue`);
  assert.equal(new Set(first.values()).size, SAMPLE_NAMES.length);
  assert.deepEqual(hues([...SAMPLE_NAMES].reverse()), first);
  assert.deepEqual(hues(SAMPLE_NAMES), first);
});




test('`/where`: main is bold in the default colour and the counts lead with a dim Σ; the status line: dim labels, healthy values plain', () => {
  const where = whereOf(screenshotBoard(), TERM_256, 160);
  assert.ok(where.some((row) => row.startsWith('\u001b[1m⎇ claude-setup:main')), 'main row: bold ⎇ and name, no hue');
  assert.ok(where.some((row) => row.startsWith('\u001b[2mΣ \u001b[0m\u001b[36m4 agents')), 'counts row: a dim Σ');
  const rows = rowsOf(screenshotBoard(), TERM_256, 160);
  assert.ok(rows.some((row) => row.startsWith('\u001b[2mALL    \u001b[0m')), 'job row: a dim ALL label column');
  assert.ok(rows.some((row) => row.startsWith('\u001b[2magents \u001b[0m4 running')), 'agents row: a dim label, the count plain');
  assert.ok(rows.at(-1).startsWith('\u001b[2mgit    \u001b[0mmain ✓'), 'last row: a dim git label');
  assert.ok(rows.at(-1).includes('\u001b[2mctx\u001b[0m 25%'), 'session block: a dim ctx label, a healthy value in the default colour');
  assert.ok(rows.at(-1).includes('\u001b[2macct\u001b[0m work'), 'session block: a dim acct label');
});

test('a 16-colour terminal gets no 256-colour codes and tells items apart by bold, underline or plain with the marker', () => {
  const rows = whereOf(placedWriterBoard(), TERM_16, 160);
  assert.ok(rows.every((row) => !row.includes('38;5;')));
  const lane = identityOn(rowWith(rows, '⎇', 'remove-modes'), 'remove-modes');
  assert.match(lane?.codes ?? 'none', /^(\u001b\[1m|\u001b\[4m|)$/);
  assert.ok(rows.some((row) => row.includes(`${lane.codes}${lane.marker} implementer`)), 'the agent placed in the lane has the lane look');
  const six = whereOf(boardOfAgents(SAMPLE_NAMES), TERM_16, 160);
  const sixLooks = SAMPLE_NAMES.map((name) => identityOn(six.find((row) => plain(row).includes(` ${name}`)), name)).map((look) => `${look?.codes}|${look?.marker}`);
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
