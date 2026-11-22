// Tests that pin the identity colours on the rows (C11-1 of the delta-1 review): where each row draws its hue, marker and cut, in the
// work rows, the git rows (long and one-row form), the strip row, the session row, `/where` and the road and checks rows. Rows are
// built by the row functions (pure) and `/where` by home/tools/board/board.mjs under a temp HOME.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSessionFile } from '../home/hooks/lib/session-store.mjs';
import { fitParts, HUE_CODES, hueState, paint, STATE } from '../home/tools/board/lib/cells.mjs';
import { agentRow, runHeader } from '../home/tools/board/lib/agent-rows.mjs';
import { repoRows } from '../home/tools/board/lib/git-rows.mjs';
import { boardIdentity, hueOf, markerOf } from '../home/tools/board/lib/identity.mjs';
import { workRows } from '../home/tools/board/lib/layout.mjs';
import { sessionRow } from '../home/tools/board/lib/render.mjs';
import { checksRow, roadRow } from '../home/tools/board/lib/stat-rows.mjs';
import { whereTree } from '../home/tools/board/lib/tree.mjs';
import { lookFor, NO_COLOR_ENV, NOW, placedWriterBoard, screenshotBoard, TERM_256, viewOf } from './statusline-identity-fixture.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const BOARD_CLI = fileURLToPath(new URL('../home/tools/board/board.mjs', import.meta.url));
const BOLD = '\u001b[1m';
const plain = (row) => row.replaceAll(/\u001b\[[0-9;]*m/g, '');
const ctxOf = (board, identity = boardIdentity(board)) => ({ nowMs: NOW, timeZone: 'UTC', at: NOW, repo: board.repo, repos: [board.repo], identity });
/** The part of a cut text before its cut mark: it must be a whole-word start of the original, at most `max` characters with the mark. */
const assertCutAtWord = (shown, original, max) => {
  assert.ok(shown.endsWith('…'), `cut mark: ${shown}`);
  assert.ok([...shown].length <= max && [...shown].length > 12, `between 13 and ${max} characters: ${shown}`);
  assert.match(original.slice(shown.length - 1), /^[ -]/, `cut at a word or - boundary: ${shown}`);
};

test('a workflow\'s purpose is cut at a word at 32 characters with the cut mark', () => {
  const board = screenshotBoard();
  const purpose = 'tighten the status line colours for every row now';
  const row = plain(runHeader({ ...board.runs[0], purpose }, [], ctxOf(board), lookFor(TERM_256, 200)));
  assertCutAtWord(/ for (tighten[^·]*…) /.exec(row)?.[1], purpose, 32);
});

test('an agent\'s name column is as wide as before the marker (16 characters, 22 wide), the name cut inside it', () => {
  const board = placedWriterBoard();
  const agent = { ...board.agents[0], name: 'an-agent-name-that-is-far-too-long-for-its-column' };
  const barAt = (columns) => plain(agentRow(agent, { ...ctxOf(board), prefix: ' ' }, lookFor(TERM_256, columns))).indexOf('█');
  assert.equal(barAt(85), 1 + 16 + 1, 'prefix, the 16-character column, a space');
  assert.equal(barAt(165), 1 + 22 + 1 + 16 + 1, 'prefix, the 22-character column, a space and the 16-character type, a space');
  assert.match(plain(agentRow(agent, { ...ctxOf(board), prefix: ' ' }, lookFor(TERM_256, 85))), /^ [●◆▲] an-agent-name… /);
});

test('a worktree row cuts its branch (when it differs from the folder) at a word at 32 characters, in the lane\'s hue', () => {
  const board = placedWriterBoard();
  const branch = 'feature-long-branch-name-with-many-words-in-it';
  board.repo.worktrees[1] = { ...board.repo.worktrees[1], branch };
  const look = lookFor(TERM_256, 200);
  const row = repoRows(board, Infinity, ctxOf(board), look).find((entry) => plain(entry).includes('⎇ ') && plain(entry).includes(' remove-modes'));
  assertCutAtWord(/remove-modes · (feature[^·]*…) /.exec(plain(row))?.[1], branch, 32);
  const hue = hueOf(boardIdentity(board), branch);
  assert.ok(row.includes(paint(plain(row).match(/feature[^·]*…/)[0], hueState(hue), look)), 'the branch part in the hue');
});

test('the one-row git form draws each worktree\'s marker and name in its hue', () => {
  const board = placedWriterBoard();
  const look = lookFor(TERM_256, 200);
  const identity = boardIdentity(board);
  const [row] = repoRows(board, 1, ctxOf(board, identity), look);
  for (const name of ['remove-modes', 'road-gate-landed-row', 'sync-remote-path']) {
    const hue = hueOf(identity, name);
    assert.ok(row.includes(paint(`${markerOf(hue, look)} ${name}`, hueState(hue), look)), `${name}: marker and name in its hue`);
  }
});

test('the strip row of workflows draws each in its own item\'s hue (a tied workflow in its lane\'s) with its marker', () => {
  const board = placedWriterBoard();
  const look = lookFor(TERM_256, 125);
  const identity = boardIdentity(board);
  const [strip] = workRows(board, 2, ctxOf(board, identity), look);
  const hue = hueOf(identity, 'remove-modes');
  assert.ok(strip.includes(paint(`${markerOf(hue, look)} remove-mode…`, hueState(hue), look)), 'tied to the lane: the lane\'s hue');
  const own = hueOf(identity, 'statusline-identity-colours');
  assert.notEqual(own, hue);
  assert.ok(strip.includes(paint(`${markerOf(own, look)} statusline…`, hueState(own), look)), 'untied: its own hue');
});

test('the session row\'s git part (no git row has room) cuts the branch at a word at 32 characters', () => {
  const board = { ...screenshotBoard(), repo: null, repos: [], runs: [], agents: [] };
  const branch = 'feature-long-branch-name-with-many-words-in-it';
  board.git = { branch, ahead: 0, behind: 0, changed: 0 };
  const row = plain(sessionRow(viewOf(board, NOW, NO_COLOR_ENV), lookFor(NO_COLOR_ENV, 200)));
  assertCutAtWord(/git (feature[^·,]*…)/.exec(row)?.[1], branch, 32);
});

const whereView = (board, identity) => ({ segment: null, board, asking: null, limits: [], lastSeen: null, nowMs: NOW, timeZone: 'UTC', checks: null, identity });

test('`/where` draws the saved hues it is given, its ties, and cuts the git branch of its foot line at a word', () => {
  const board = placedWriterBoard();
  const look = lookFor(TERM_256, 160);
  const saved = boardIdentity(board, { v: 1, items: [{ name: 'remove-modes', hue: 5, seenMs: NOW, sinceMs: NOW }] }, NOW);
  assert.equal(hueOf(saved, 'remove-modes'), 5);
  const lines = whereTree(whereView(board, saved), look);
  assert.ok(lines.some((line) => line.includes(`\u001b[38;5;${HUE_CODES[5]}m▸`) && plain(line).includes(' on remove-modes')), 'the saved hue and the tie');
  assert.ok(whereTree(whereView(board, null), look).some((line) => plain(line).includes(' on remove-modes')), 'with none given it works the ties out itself');
  const branch = 'feature-long-branch-name-with-many-words-in-it';
  const foot = whereTree(whereView({ ...board, git: { branch, changed: 0 } }, null), look).map(plain).find((line) => line.includes('waiting on you'));
  assertCutAtWord(/git (feature[^,]*…),/.exec(foot)?.[1], branch, 32);
});

test('`board.mjs where` draws the hues saved for the session, from a temp HOME', () => {
  const home = makeTempDir('where-hues-');
  const session = 'where-session-1';
  const board = { ...screenshotBoard(), session, at: Date.now() };
  writeSessionFile(join(home, '.claude', 'state', 'board'), session, JSON.stringify(board));
  const saved = { v: 1, items: [{ name: 'statusline-identity-colours', hue: 3, seenMs: Date.now(), sinceMs: Date.now() }] };
  writeSessionFile(join(home, '.claude', 'state', 'board-cache'), `${session}-hues`, JSON.stringify(saved));
  const env = { ...process.env, ...TERM_256, HOME: home, USERPROFILE: home, NO_COLOR: '', CLAUDE_CODE_SESSION_ID: session };
  const out = spawnSync(process.execPath, [BOARD_CLI, 'where', '--session', session, '--columns', '160', '--project', home], { env, encoding: 'utf8' }).stdout;
  assert.ok(out.includes(`\u001b[38;5;${HUE_CODES[3]}m▸ `), `the saved hue 3 on a workflow row: ${out.slice(0, 400)}`);
});

test('the road label is blue and the checks row says `none` dim when no category is on', () => {
  const clock = { nowMs: NOW, timeZone: 'UTC' };
  const look = lookFor(TERM_256, 160);
  const road = roadRow({ name: 'p9', step: 1, steps: 3 }, null, clock, look);
  assert.ok(road.startsWith(`${STATE.road === 'road' ? '\u001b[34m' : ''}road p9`), road);
  assert.ok(checksRow({ on: [], off: ['test'] }, null, look).startsWith('\u001b[2mchecks: none'));
  assert.ok(checksRow({ on: ['test'], off: [] }, null, look).startsWith('\u001b[32mchecks: test'));
});

test('a part with spans keeps bold on each span and when cut, and is cut with no span room only as plain text', () => {
  const look = lookFor(TERM_256, 25);
  const part = { text: 'abcdefghij klmnop', spans: [{ text: 'abcdef', state: hueState(0) }, { text: 'ghij klmnop' }], bold: true };
  assert.equal(fitParts([part], look), `${BOLD}\u001b[38;5;31mabcdef\u001b[0mghij klmnop`);
  const cut = fitParts([part], lookFor(TERM_256, 15));
  assert.equal(cut, `${BOLD}\u001b[38;5;31mabcdef\u001b[0mghi…`, 'cut: still bold');
  const tight = fitParts([{ text: 'xxxxxxxx', state: STATE.dim }, { text: 'abcdef', spans: [{ text: 'abcdef', state: hueState(0) }], join: '' }], lookFor(TERM_256, 13));
  assert.equal(plain(tight), 'xxxxxxxx', 'no room even for the cut mark: nothing of the next part');
});
