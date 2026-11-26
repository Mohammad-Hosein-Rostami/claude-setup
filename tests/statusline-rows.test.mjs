// Tests that pin the status line rows' cuts and colours (RC8, R18's RC14 and RC20 of 2026-11-22): the kind colours (branch,
// session) on the dark, light and 16-colour palettes with yellow, red, magenta and dim only as reserved; the git row's branch cut;
// ASCII mode; spans; the render time; the 5 h pace and reset clock of the session row (R33); and git counts that are `unknown`
// (P3). Rows come from home/tools/board/lib/render.mjs statusRows and sessionRow (pure), on the screenshot board of
// statusline-board-fixture.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitParts, lookOf, paint, STATE } from '../home/tools/board/lib/cells.mjs';
import { sessionRow, statusRows } from '../home/tools/board/lib/render.mjs';
import { lookFor, NO_COLOR_ENV, NOW, screenshotBoard, TERM_256, viewOf } from './statusline-board-fixture.mjs';

const BOLD = '\u001b[1m';
const LONG_BRANCH = 'feature-long-branch-name-with-many-words-in-it';
const RENDERS_TIMED = 21;
const MAX_MEDIAN_MS = 100;
const plain = (row) => row.replaceAll(/\u001b\[[0-9;]*m/g, '');
const rowsOf = (board, env, columns) => statusRows(viewOf(board, NOW, env), lookFor(env, columns));
/** The part of a cut text before its cut mark: it must be a whole-word start of the original, at most `max` characters with the mark. */
const assertCutAtWord = (shown, original, max) => {
  assert.ok(shown.endsWith('…'), `cut mark: ${shown}`);
  assert.ok([...shown].length <= max && [...shown].length > 12, `between 13 and ${max} characters: ${shown}`);
  assert.match(original.slice(shown.length - 1), /^[ -]/, `cut at a word or - boundary: ${shown}`);
};

/** Each coloured text of a row with its SGR code (bold dropped): [code, text]. */
function colouredTexts(row) {
  const found = [];
  for (const match of row.matchAll(/\u001b\[([0-9;]+)m((?:\u001b\[[0-9;]+m)*)([^\u001b]*)/g)) {
    const code = [match[1], ...[...match[2].matchAll(/\u001b\[([0-9;]+)m/g)].map((inner) => inner[1])].filter((sgr) => sgr !== '1' && sgr !== '0').at(-1);
    if (code !== undefined && match[3] !== '') found.push([code, match[3]]);
  }
  return found;
}

// P1: each kind's colour is on that kind of text only (branch names, session values, clocks).
const KIND_TEXT = {
  branch: /^(main|remove-modes|road-gate-landed-row|sync-remote-path)$/,
  time: /^\d\d:\d\d$/,
  session: /^(Opus 5\.5 high| \d+%| <?\d+% left| work)$/,
};
const PALETTE_CODES = {
  dark: { branch: '38;5;35', time: '38;5;33', session: '38;5;103' },
  light: { branch: '38;5;28', time: '38;5;25', session: '38;5;60' },
  16: { branch: '32', time: '34', session: '37' },
};
const PALETTE_ENV = { dark: {}, light: { CLAUDE_STATUS_THEME: '', COLORFGBG: '0;15' }, 16: { TERM: 'xterm', COLORTERM: '' } };
const RATE_LIMITS = { five_hour: { used_percentage: 40, resets_at: NOW / 1000 + 3600 }, seven_day: { used_percentage: 10, resets_at: NOW / 1000 + 86_400 } };

/** The rows of the screenshot board with rate limits, on a terminal with this environment, `columns` wide. */
function busyRows(env, columns) {
  const view = viewOf(screenshotBoard(), NOW, env);
  view.input = { ...view.input, rate_limits: RATE_LIMITS };
  return statusRows(view, lookOf(env, 'darwin', columns - 5));
}

test('the git row cuts a long branch at a word at 24 characters, its repository name kept', () => {
  const board = { ...screenshotBoard(), agents: [] };
  board.repo = { ...board.repo, worktrees: board.repo.worktrees.map((wt) => (wt.main ? { ...wt, name: LONG_BRANCH, branch: LONG_BRANCH } : wt)) };
  const row = rowsOf(board, NO_COLOR_ENV, 200).map(plain).find((entry) => entry.startsWith('git '));
  assertCutAtWord(/^git +claude-setup {2}(feature\S*…)/.exec(row)?.[1], LONG_BRANCH, 24);
});

test('the status line: dim labels, counts in the default colour, the repository bold, the branch and session values in their kind colour', () => {
  const rows = rowsOf(screenshotBoard(), TERM_256, 160);
  assert.ok(rows.some((row) => row.startsWith('\u001b[2magents  \u001b[0m4 running')), 'agents row: a dim label, the count plain');
  assert.ok(rows.some((row) => row.startsWith('\u001b[2mgit     \u001b[0m\u001b[1mclaude-setup\u001b[0m  \u001b[38;5;35mmain\u001b[0m')), 'git row: dim label, bold repository, green branch');
  assert.ok(rows.at(-1).startsWith('\u001b[2msession \u001b[0m\u001b[38;5;103mOpus 5.5 high\u001b[0m'), 'session row: a dim label, the model in the session colour');
  assert.ok(rows.at(-1).includes('\u001b[2mcontext\u001b[0m\u001b[38;5;103m 25%'), 'a dim context label, a calm value in the session colour');
  assert.ok(rows.at(-1).includes('\u001b[2macct\u001b[0m\u001b[38;5;103m work'), 'a dim acct label');
});

test('ASCII mode prints no byte above 0x7E on the status line', () => {
  const env = { ...NO_COLOR_ENV, CLAUDE_STATUS_ASCII: '1' };
  for (const columns of [80, 120, 160]) {
    for (const row of rowsOf(screenshotBoard(), env, columns)) assert.doesNotMatch(row, /[^ -~]/, row);
  }
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
  view.input = { ...view.input, rate_limits: RATE_LIMITS };
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

test('P1 RC14 RC20: one colour per kind on the dark, light (COLORFGBG) and 16-colour palettes; yellow, red, magenta and dim only as reserved', () => {
  for (const [palette, codes] of Object.entries(PALETTE_CODES)) {
    const kindOf = new Map(Object.entries(codes).map(([kind, code]) => [code, kind]));
    const seen = new Set();
    for (const columns of [80, 100, 120]) {
      for (const row of busyRows({ ...TERM_256, ...PALETTE_ENV[palette] }, columns)) {
        for (const [code, text] of colouredTexts(row)) {
          const kind = kindOf.get(code);
          if (kind === undefined) {
            assert.ok(['2', '31', '33', '35'].includes(code), `${palette}: SGR ${code} on ${JSON.stringify(text)}`);
            continue;
          }
          assert.match(text, KIND_TEXT[kind], `${palette}: ${kind} colour on ${JSON.stringify(text)}`);
          seen.add(kind);
        }
      }
    }
    assert.ok(seen.has('branch') && seen.has('session'), `${palette}: the branch and session kinds are drawn`);
  }
  assert.ok(busyRows({ ...TERM_256, CLAUDE_STATUS_THEME: 'light' }, 100).join('').includes('\u001b[38;5;28mmain'), 'CLAUDE_STATUS_THEME=light gives the light palette');
});

test('the reserved states: to pull yellow, conflicts red; a lane behind is calm', () => {
  const board = screenshotBoard();
  board.agents = [];
  board.repo.worktrees = board.repo.worktrees.map((wt) => (wt.main ? { ...wt, upBehind: 1, conflicts: 2, staged: 0, changed: 0 }
    : wt.name === 'remove-modes' ? { ...wt, behind: 5 } : wt));
  const view = viewOf(board, NOW, TERM_256);
  const text = statusRows(view, lookFor(TERM_256, 160)).join('\n');
  for (const shown of ['\u001b[33m↓1 to pull', '\u001b[31m2 conflicts']) {
    assert.ok(text.includes(shown), `${JSON.stringify(shown)} in ${JSON.stringify(text)}`);
  }
  // land rebases a lane behind its base, so `behind` is a plain word, never the yellow of `needs a look`
  assert.ok(text.includes(' ↓5 behind'), text);
  assert.ok(!text.includes('\u001b[33m ↓5 behind'), `↓5 behind not yellow in ${JSON.stringify(text)}`);
  assert.doesNotMatch(text, /needs rebase/);
});

test('R33: an empty 5 h window shows its reset clock, never a pace that has already passed', () => {
  const view = viewOf(screenshotBoard(), NOW, NO_COLOR_ENV);
  const resetS = NOW / 1000 + 80 * 60;
  const sample = (t, used) => ({ t, five_hour: { used_percentage: used, resets_at: resetS } });
  // The owner's case: two samples whose pace ran out 45 min ago, the live window now at 100 % used.
  view.limitsFile = { account: 'mine', samples: [sample(NOW - 90 * 60_000, 90), sample(NOW - 60 * 60_000, 95)] };
  view.input = { ...view.input, rate_limits: { five_hour: { used_percentage: 100, resets_at: resetS } } };
  const row = sessionRow(view, lookFor(NO_COLOR_ENV, 200));
  assert.match(row, /5h 0% left, resets 10:20/, row);
  assert.doesNotMatch(row, /empty ~/, row);
});

test('R33: a 5 h pace that already passed gives way to the reset clock while the window is not yet empty', () => {
  const view = viewOf(screenshotBoard(), NOW, NO_COLOR_ENV);
  const resetS = NOW / 1000 + 80 * 60;
  const sample = (t, used) => ({ t, five_hour: { used_percentage: used, resets_at: resetS } });
  view.limitsFile = { account: 'mine', samples: [sample(NOW - 90 * 60_000, 90), sample(NOW - 60 * 60_000, 95)] };
  view.input = { ...view.input, rate_limits: { five_hour: { used_percentage: 99.5, resets_at: resetS } } };
  assert.match(sessionRow(view, lookFor(NO_COLOR_ENV, 200)), /5h <1% left, resets 10:20/);
});

test('R33: with no live 5 h window, an empty last sample shows its reset clock', () => {
  const view = viewOf(screenshotBoard(), NOW, NO_COLOR_ENV);
  const resetS = NOW / 1000 + 80 * 60;
  view.limitsFile = { account: 'mine', samples: [{ t: NOW - 5 * 60_000, five_hour: { used_percentage: 100, resets_at: resetS } }] };
  view.input = { ...view.input, rate_limits: undefined };
  assert.match(sessionRow(view, lookFor(NO_COLOR_ENV, 200)), /5h 0% left, 5 min ago, resets 10:20/);
});

const UNKNOWN = 'unknown'; // git-state.mjs: a count git could not give and no cache held
/** An entry of board.repo.active as git-state.mjs writes it: a clean branch level with the base, unless `fields` say otherwise. */
const activeBranch = (name, fields) => ({
  name, current: false, upstream: null, upAhead: null, upBehind: null, ahead: 0, behind: 0, ageMin: 10, worktree: name, agents: [],
  staged: 0, changed: 0, untracked: null, conflicts: 0, op: null, opStep: null, ...fields,
});
const gitRowsOf = (board, columns) => rowsOf(board, NO_COLOR_ENV, columns).map(plain).filter((row) => /^(git|lanes) /.test(row));

test('P3: unknown counts draw `changes unknown` on the head row and on a lane, never `changes ?`, `clean` or `ready to land`', () => {
  const unknownCounts = { staged: UNKNOWN, changed: UNKNOWN, conflicts: UNKNOWN };
  const board = { ...screenshotBoard(), agents: [] };
  board.repo = { ...board.repo, active: [activeBranch('main', { current: true, worktree: 'main', ...unknownCounts, untracked: UNKNOWN }),
    activeBranch('idle-lane', { ahead: 2, ...unknownCounts })] };
  assert.deepEqual(gitRowsOf(board, 160), ['git     claude-setup  main  changes unknown · last commit 10 min ago', 'lanes   idle-lane ↑2 changes unknown']);
  assert.deepEqual(gitRowsOf(board, 80), ['git main  changes unknown · last commit 10 min ago', 'lanes idle-lane ↑2 changes unknown'], 'narrow rows');
});

test('an old board file with number counts and no `unknown` field draws its counts as before', () => {
  const board = { ...screenshotBoard(), agents: [] };
  board.repo = { ...board.repo, worktrees: board.repo.worktrees.map((wt) => (wt.main ? { ...wt, staged: 1, changed: 3, untracked: 1, conflicts: 0 } : wt)) };
  assert.deepEqual(gitRowsOf(board, 160), ['git     claude-setup  main  ↑44 to push · 1 staged · 3 changed · 1 new · last commit 5 h 40 ago',
    'lanes   remove-modes ↑7 · road-gate-landed-row ↑8 ~2 · sync-remote-path ↑1']);
});
