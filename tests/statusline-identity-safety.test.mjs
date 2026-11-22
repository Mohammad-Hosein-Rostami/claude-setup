// Tests for untrusted names on the rows the identity colours rewrote (P5, spec-tui-3 fix round 1): an agent, branch,
// worktree, repository, operation or account name holding escape codes, C1 controls, a hyperlink, a bidi override, a line
// separator or a newline reaches no row as anything but plain text, in every form of the status line and in `/where`; and the
// branch behind `on <branch>` is cut at its width. Each outside text on those rows goes through cleanText: removing any one of
// those calls puts a raw control character on a row here and fails the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { statusRows } from '../home/tools/board/lib/render.mjs';
import { whereTree } from '../home/tools/board/lib/tree.mjs';
import { boardIdentity } from '../home/tools/board/lib/identity.mjs';
import { lookFor, NO_COLOR_ENV, NOW, placedWriterBoard, screenshotBoard, TERM_256, viewOf } from './statusline-identity-fixture.mjs';

const ESC = '\u001b';
/** A name that opens a hyperlink, a C1 control, a bidi override, a line separator and a newline before its visible letters. */
const hostile = (label) => `${ESC}]8;;x\u0007\u009b\u202e\u2028\n${label}`;
const BAD = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/u;
const ASCII_ENV = { ...NO_COLOR_ENV, CLAUDE_STATUS_ASCII: '1' };
const COLUMNS = [60, 80, 120, 160];
const LINES = ['3', '12', '24', '36'];
const ownCodes = (row) => row.replaceAll(/\u001b\[[0-9;]*m/g, '');

/** The screenshot board with a hostile text in every field of the rewritten rows that holds an outside text; noMain: no main worktree. */
function hostileBoard({ noMain = false } = {}) {
  const board = screenshotBoard();
  board.git = { branch: hostile('git-branch'), ahead: 0, behind: 0, changed: 0 };
  const wtName = hostile('lane-a');
  board.agents = [
    { ...board.agents[0], name: hostile('agent-a'), type: hostile('type'), phase: hostile('phase'), row: hostile('row'), wt: wtName, branch: hostile('branch-a'), doing: hostile('doing') },
    { ...board.agents[1], name: hostile('agent-b'), unplaced: `${hostile('folder')} · ${hostile('why')}` },
    { ...board.agents[2], id: 'plain', name: hostile('plain'), branch: null, wt: null, unplaced: null, doing: hostile('doing-plain') },
  ];
  board.repo = {
    ...board.repo, name: hostile('repo'), base: hostile('base'),
    worktrees: [
      ...(noMain ? [] : [{ ...board.repo.worktrees[0], name: hostile('main'), op: hostile('main-op') }]),
      { ...board.repo.worktrees[1], name: wtName, branch: hostile('branch-a'), op: hostile('rebase'), agents: [hostile('agent-a'), hostile('agent-b')] },
      { ...board.repo.worktrees[2], name: hostile('lane-b'), branch: hostile('branch-b') },
    ],
  };
  return board;
}

/** Every row of the status line in every form (rows given by LINES) for one terminal and width, and `/where`. */
function rowsOf(env, columns) {
  return [{}, { noMain: true }].flatMap((variant) => {
    const board = hostileBoard(variant);
    const asking = { kind: 'question', count: 1, expiresAt: NOW + 2 * 60_000 }; // the alert row takes the room, so git rides on the session row
    const status = [null, asking].flatMap((waiting) => LINES.flatMap((lines) => statusRows(
      { ...viewOf(board, NOW, { ...env, LINES: lines }), account: hostile('acct'), asking: waiting }, lookFor(env, columns),
    )));
    const where = whereTree({ segment: null, board, asking: null, limits: [], lastSeen: null, nowMs: NOW, timeZone: 'UTC' }, lookFor(env, columns));
    return [...status, ...where];
  });
}

test('hostile names reach no row as a control, format or line-break character, in the status line and `/where`, at every width and terminal', () => {
  let checked = 0;
  for (const env of [TERM_256, NO_COLOR_ENV, ASCII_ENV]) {
    for (const columns of COLUMNS) {
      for (const row of rowsOf(env, columns)) {
        const shown = ownCodes(row);
        assert.doesNotMatch(shown, BAD, JSON.stringify(shown));
        assert.ok([...shown].length <= columns - 5, `${columns}: ${shown}`);
        if (env === ASCII_ENV) assert.doesNotMatch(row, /[^ -~]/, row);
        if (env !== TERM_256) assert.ok(!row.includes(ESC), 'no escape code without colour');
        checked += 1;
      }
    }
  }
  assert.ok(checked > 200, `${checked} rows checked`);
});

test('the hostile names do show up (as plain text), so the check above is not passing on empty rows', () => {
  const rows = rowsOf(NO_COLOR_ENV, 160).map(ownCodes).join('\n');
  for (const word of ['agent', 'main-op', 'rebase', 'repo', 'acct']) assert.match(rows, new RegExp(word), word);
});

