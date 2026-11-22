// Tests that pin the rows' cuts and colours (C11-1 of the delta-1 review, then RC5 and RC8 of 2026-11-22): the agent and git rows
// `/where` draws (name column, branch cut, the one-row git form) with no colour for an agent or a branch, the status line's dim
// labels, ASCII mode, spans, the render time, and `/where` as plain text whatever the terminal: from whereTree (pure) and from
// home/tools/board/board.mjs under a temp HOME (F1 a 256-colour TERM, F3 a left-over hue file, F4 no board, F5 a hostile branch,
// F6 a Windows worktree path).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSessionFile } from '../home/hooks/lib/session-store.mjs';
import { fitParts, paint, STATE } from '../home/tools/board/lib/cells.mjs';
import { agentRow } from '../home/tools/board/lib/agent-rows.mjs';
import { repoRows } from '../home/tools/board/lib/git-rows.mjs';
import { sessionRow, statusRows } from '../home/tools/board/lib/render.mjs';
import { roadRow } from '../home/tools/board/lib/stat-rows.mjs';
import { whereTree } from '../home/tools/board/lib/tree.mjs';
import { lookFor, NO_COLOR_ENV, NOW, placedWriterBoard, screenshotBoard, TERM_256, viewOf } from './statusline-board-fixture.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const BOARD_CLI = fileURLToPath(new URL('../home/tools/board/board.mjs', import.meta.url));
const ESC = '\u001b';
const BOLD = '\u001b[1m';
const LONG_BRANCH = 'feature-long-branch-name-with-many-words-in-it';
const RENDERS_TIMED = 21;
const MAX_MEDIAN_MS = 100;
const plain = (row) => row.replaceAll(/\u001b\[[0-9;]*m/g, '');
const ctxOf = (board) => ({ nowMs: NOW, timeZone: 'UTC', at: NOW, repo: board.repo, repos: [board.repo] });
const whereView = (board) => ({ segment: null, board, asking: null, limits: [], lastSeen: null, nowMs: NOW, timeZone: 'UTC' });
const rowsOf = (board, env, columns) => statusRows(viewOf(board, NOW, env), lookFor(env, columns));
/** The part of a cut text before its cut mark: it must be a whole-word start of the original, at most `max` characters with the mark. */
const assertCutAtWord = (shown, original, max) => {
  assert.ok(shown.endsWith('…'), `cut mark: ${shown}`);
  assert.ok([...shown].length <= max && [...shown].length > 12, `between 13 and ${max} characters: ${shown}`);
  assert.match(original.slice(shown.length - 1), /^[ -]/, `cut at a word or - boundary: ${shown}`);
};

/** A board.mjs `where` run for a session whose board file (when given) is in a temp HOME, on a 256-colour terminal. */
function whereRun(home, session, board, columns = 160) {
  if (board) writeSessionFile(join(home, '.claude', 'state', 'board'), session, JSON.stringify({ ...board, session, at: Date.now() }));
  const env = { ...process.env, ...TERM_256, HOME: home, USERPROFILE: home, NO_COLOR: '', CLAUDE_CODE_SESSION_ID: session };
  return spawnSync(process.execPath, [BOARD_CLI, 'where', '--session', session, '--columns', String(columns), '--project', home], { env, encoding: 'utf8' });
}

test('an agent\'s name column is 16 characters (22 wide), the name cut inside it, in the default colour', () => {
  const board = placedWriterBoard();
  const agent = { ...board.agents[0], name: 'an-agent-name-that-is-far-too-long-for-its-column' };
  const rowAt = (columns) => agentRow(agent, { ...ctxOf(board), prefix: ' ' }, lookFor(TERM_256, columns));
  assert.equal(plain(rowAt(85)).indexOf('█'), 1 + 16 + 1, 'prefix, the 16-character column, a space');
  assert.equal(plain(rowAt(165)).indexOf('█'), 1 + 22 + 1 + 16 + 1, 'prefix, the 22-character column, a space and the 16-character type, a space');
  assert.ok(rowAt(85).startsWith(' an-agent-name… '), `no marker and no colour before the name: ${JSON.stringify(rowAt(85))}`);
});

test('a worktree row cuts its branch (when it differs from the folder) at a word at 32 characters, name and branch in the default colour', () => {
  const board = placedWriterBoard();
  board.repo.worktrees[1] = { ...board.repo.worktrees[1], branch: LONG_BRANCH };
  const row = repoRows(board, Infinity, ctxOf(board), lookFor(TERM_256, 200)).find((entry) => plain(entry).includes(' remove-modes'));
  const shown = /remove-modes · (feature[^·]*…) /.exec(plain(row))?.[1];
  assertCutAtWord(shown, LONG_BRANCH, 32);
  assert.ok(row.startsWith(`⎇ remove-modes · ${shown} `), `no colour code on the name or the branch: ${JSON.stringify(row)}`);
});

test('the one-row git form names each worktree in the default colour, with no marker', () => {
  const board = placedWriterBoard();
  const [row] = repoRows(board, 1, ctxOf(board), lookFor(TERM_256, 200));
  for (const name of ['remove-modes', 'road-gate-landed-row', 'sync-remote-path']) {
    assert.match(row, new RegExp(`[│·] ${name} `), `${name}: plain, right after its separator`);
  }
  assert.doesNotMatch(plain(row), /[●◆▲] (remove|road|sync)/);
});

test('the last row\'s git part (one summary, RC8) cuts a long main branch at a word at 24 characters', () => {
  const board = { ...screenshotBoard(), agents: [] };
  board.repo = { ...board.repo, worktrees: board.repo.worktrees.map((wt) => (wt.main ? { ...wt, name: LONG_BRANCH, branch: LONG_BRANCH } : wt)) };
  const row = plain(sessionRow(viewOf(board, NOW, NO_COLOR_ENV), lookFor(NO_COLOR_ENV, 200)));
  assertCutAtWord(/^git +(feature\S*…)/.exec(row)?.[1], LONG_BRANCH, 24);
});

test('`/where` is plain text on a 256-colour terminal (RC8), names each placed agent\'s lane, and cuts its foot line\'s branch at a word', () => {
  const board = placedWriterBoard();
  const lines = whereTree(whereView(board), lookFor(TERM_256, 160));
  assert.ok(lines.every((line) => !line.includes(ESC)), lines.join('\n'));
  assert.ok(lines.some((line) => line.startsWith('⎇ claude-setup:main')), 'main first, no bold code');
  assert.ok(lines.some((line) => line.startsWith('Σ 4 agents')), 'the counts row, no dim code');
  assert.ok(lines.some((line) => /implementer:opus .*remove-modes 7↑/.test(line)), 'the agent row names its lane');
  const foot = whereTree(whereView({ ...board, git: { branch: LONG_BRANCH, changed: 0 } }), lookFor(TERM_256, 160)).find((line) => line.includes('waiting on you'));
  assertCutAtWord(/git (feature[^,]*…),/.exec(foot)?.[1], LONG_BRANCH, 32);
});

test('the status line: dim labels, healthy values in the default colour', () => {
  const rows = rowsOf(screenshotBoard(), TERM_256, 160);
  assert.ok(rows.some((row) => row.startsWith('\u001b[2mALL    \u001b[0m')), 'job row: a dim ALL label column');
  assert.ok(rows.some((row) => row.startsWith('\u001b[2magents \u001b[0m4 running')), 'agents row: a dim label, the count plain');
  assert.ok(rows.at(-1).startsWith('\u001b[2mgit    \u001b[0mmain ✓'), 'last row: a dim git label');
  assert.ok(rows.at(-1).includes('\u001b[2mctx\u001b[0m 25%'), 'session block: a dim ctx label, a healthy value in the default colour');
  assert.ok(rows.at(-1).includes('\u001b[2macct\u001b[0m work'), 'session block: a dim acct label');
});

test('ASCII mode prints no byte above 0x7E, on the status line and in `/where`', () => {
  const env = { ...NO_COLOR_ENV, CLAUDE_STATUS_ASCII: '1' };
  for (const columns of [80, 120, 160]) {
    const rows = [...rowsOf(screenshotBoard(), env, columns), ...whereTree(whereView(placedWriterBoard()), lookFor(env, columns))];
    for (const row of rows) assert.doesNotMatch(row, /[^ -~]/, row);
  }
});

test('the road label has no colour (RC5: colour only for a state) and the active step is cyan', () => {
  const clock = { nowMs: NOW, timeZone: 'UTC' };
  const look = lookFor(TERM_256, 160);
  const road = roadRow({ name: 'p9', step: 1, steps: 3 }, null, clock, look);
  assert.ok(road.startsWith(`road p9 · ${paint('step 1/3', STATE.run, look)}`), road);
});

test('a part with spans keeps bold on each span and when cut, and is cut with no span room only as plain text', () => {
  const look = lookFor(TERM_256, 25);
  const part = { text: 'abcdefghij klmnop', spans: [{ text: 'abcdef', state: STATE.warn }, { text: 'ghij klmnop' }], bold: true };
  assert.equal(fitParts([part], look), `${BOLD}\u001b[33mabcdef\u001b[0mghij klmnop`);
  const cut = fitParts([part], lookFor(TERM_256, 15));
  assert.equal(cut, `${BOLD}\u001b[33mabcdef\u001b[0mghi…`, 'cut: still bold');
  const tight = fitParts([{ text: 'xxxxxxxx', state: STATE.dim }, { text: 'abcdef', spans: [{ text: 'abcdef', state: STATE.warn }], join: '' }], lookFor(TERM_256, 13));
  assert.equal(plain(tight), 'xxxxxxxx', 'no room even for the cut mark: nothing of the next part');
});

test('a part with spans that is cut keeps the state of the spans it still shows', () => {
  const look = lookFor(TERM_256, 17);
  const part = { text: 'ALL no job linked', spans: [{ text: 'ALL', state: STATE.strong }, { text: ' no job linked' }] };
  assert.equal(fitParts([part], look), '\u001b[1mALL\u001b[0m no job …');
  const split = { text: 'abcdefghijklmnopq', spans: [{ text: 'abcdef', state: STATE.warn }, { text: 'ghijklmnopq', state: STATE.dim }] };
  assert.equal(fitParts([split], look), `${paint('abcdef', STATE.warn, look)}${paint('ghijk', STATE.dim, look)}…`);
  assert.equal(fitParts([{ text: 'x' }, { ...part, join: ' ' }], lookFor(TERM_256, 8)), 'x …');
});

test('the limit labels `5h` and `7d` of the session row are dim and their value keeps its state colour', () => {
  const view = viewOf(screenshotBoard(), NOW, TERM_256);
  view.input = { ...view.input, rate_limits: { five_hour: { used_percentage: 40, resets_at: NOW / 1000 + 3600 }, seven_day: { used_percentage: 10, resets_at: NOW / 1000 + 86_400 } } };
  const row = sessionRow(view, lookFor(TERM_256, 200));
  assert.ok(row.includes('\u001b[2m5h\u001b[0m') && row.includes('\u001b[2m7d\u001b[0m'), row);
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

test('F1 F3: `board.mjs where` on a 256-colour terminal prints no escape byte, and a left-over hue file is neither read nor changed', () => {
  const home = makeTempDir('where-plain-');
  const session = 'where-session-1';
  const cache = join(home, '.claude', 'state', 'board-cache');
  writeSessionFile(cache, `${session}-hues`, JSON.stringify({ v: 1, items: [{ name: 'implementer:opus', hue: 3, seenMs: 1, sinceMs: 1 }] }));
  const hueFile = join(cache, `${session}-hues.json`);
  const before = { text: readFileSync(hueFile, 'utf8'), mtimeMs: statSync(hueFile).mtimeMs };
  const run = whereRun(home, session, placedWriterBoard());
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.includes(ESC), false, JSON.stringify(run.stdout.slice(0, 400)));
  assert.match(run.stdout, /implementer:opus .*remove-modes 7↑/, 'the agent rows are there, in plain text');
  assert.deepEqual({ text: readFileSync(hueFile, 'utf8'), mtimeMs: statSync(hueFile).mtimeMs }, before, 'the old hue file is untouched');
  assert.deepEqual(readdirSync(cache), [`${session}-hues.json`], 'no colour file written');
});

test('F4: `board.mjs where` with no board file and no estimate prints its `not seen yet` lines and exits 0', () => {
  const home = makeTempDir('where-empty-');
  const run = whereRun(home, 'where-empty-1', null, 120);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^ALL {2}no job linked/m);
  assert.match(run.stdout, /^cost: not seen yet/m);
  assert.equal(run.stdout.includes(ESC), false);
});

test('F5 F6: a branch named `\\u001b[31mmain` prints cleaned, not coloured; a Windows worktree path still gives the branch, cut at a word', () => {
  const board = placedWriterBoard();
  board.git = { branch: '\u001b[31mmain', ahead: 0, behind: 0, changed: 0 };
  board.repo.worktrees[3] = { ...board.repo.worktrees[3], name: 'lane-x', path: 'C:\\Users\\me\\wt\\lane-x', branch: `windows/${LONG_BRANCH}` };
  const run = whereRun(makeTempDir('where-hostile-'), 'where-hostile-1', board);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.includes(ESC), false, JSON.stringify(run.stdout));
  assert.match(run.stdout, /git \[31mmain, clean/, 'the escape byte dropped (a blank, trimmed), the rest plain');
  const shown = /⎇ lane-x · (windows\/[^·]*…) /.exec(run.stdout)?.[1];
  assertCutAtWord(shown, `windows/${LONG_BRANCH}`, 32);
  assert.equal(run.stdout.includes('C:\\'), false, 'the row names the worktree, not its path');
});
