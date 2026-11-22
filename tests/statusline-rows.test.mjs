// Tests that pin the rows' cuts and colours (C11-1 of the delta-1 review, RC8, then R18's RC14 and RC18 of 2026-11-22): every state
// of the approved mockups (final-round/statusline/mockups.html) gives the mockup's text at 80, 100 and 120 columns; the status
// line's kind colours (branch, bar, time, session) on the dark, light and 16-colour palettes; the agent and git rows `/where` draws
// (name column, branch cut, the one-row git form) with no colour for an agent or a branch, ASCII mode, spans, the render time, and
// `/where` as plain text whatever the terminal: from whereTree (pure) and from home/tools/board/board.mjs under a temp HOME (F1 a
// 256-colour TERM, F3 a left-over hue file, F4 no board, F5 a hostile branch, F6 a Windows worktree path).
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
import { lookOf } from '../home/tools/board/lib/cells.mjs';
import { lookFor, mockupStates, MOCKUP_HOME, NO_COLOR_ENV, NOW, placedWriterBoard, screenshotBoard, TERM_256, viewOf } from './statusline-board-fixture.mjs';
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
  const sep = paint(' · ', STATE.dim, lookFor(TERM_256, 200)); // R18: the separators are dim
  assert.ok(row.startsWith(`⎇ remove-modes${sep}${shown}${sep}`), `no colour code on the name or the branch: ${JSON.stringify(row)}`);
});

test('the one-row git form names each worktree in the default colour, with no marker', () => {
  const board = placedWriterBoard();
  const [row] = repoRows(board, 1, ctxOf(board), lookFor(TERM_256, 200));
  for (const name of ['remove-modes', 'road-gate-landed-row', 'sync-remote-path']) {
    assert.match(row, new RegExp(`[│·] \u001b\\[0m${name} `), `${name}: plain, right after its dim separator`);
  }
  assert.doesNotMatch(plain(row), /[●◆▲] (remove|road|sync)/);
});

test('the git row cuts a long branch at a word at 24 characters, its repository name kept', () => {
  const board = { ...screenshotBoard(), agents: [] };
  board.repo = { ...board.repo, worktrees: board.repo.worktrees.map((wt) => (wt.main ? { ...wt, name: LONG_BRANCH, branch: LONG_BRANCH } : wt)) };
  const row = rowsOf(board, NO_COLOR_ENV, 200).map(plain).find((entry) => entry.startsWith('git '));
  assertCutAtWord(/^git +claude-setup {2}(feature\S*…)/.exec(row)?.[1], LONG_BRANCH, 24);
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

test('the status line: dim labels, counts in the default colour, the repository bold, the branch and session values in their kind colour', () => {
  const rows = rowsOf(screenshotBoard(), TERM_256, 160);
  assert.ok(rows.some((row) => row.startsWith('\u001b[2magents  \u001b[0m4 running')), 'agents row: a dim label, the count plain');
  assert.ok(rows.some((row) => row.startsWith('\u001b[2mgit     \u001b[0m\u001b[1mclaude-setup\u001b[0m  \u001b[38;5;35mmain\u001b[0m')), 'git row: dim label, bold repository, green branch');
  assert.ok(rows.at(-1).startsWith('\u001b[2msession \u001b[0m\u001b[38;5;103mOpus 5.5 high\u001b[0m'), 'session row: a dim label, the model in the session colour');
  assert.ok(rows.at(-1).includes('\u001b[2mcontext\u001b[0m\u001b[38;5;103m 25%'), 'a dim context label, a calm value in the session colour');
  assert.ok(rows.at(-1).includes('\u001b[2macct\u001b[0m\u001b[38;5;103m work'), 'a dim acct label');
});

test('ASCII mode prints no byte above 0x7E, on the status line and in `/where`', () => {
  const env = { ...NO_COLOR_ENV, CLAUDE_STATUS_ASCII: '1' };
  for (const columns of [80, 120, 160]) {
    const rows = [...rowsOf(screenshotBoard(), env, columns), ...whereTree(whereView(placedWriterBoard()), lookFor(env, columns))];
    for (const row of rows) assert.doesNotMatch(row, /[^ -~]/, row);
  }
});

test('the road label has no colour and the active step is in the bar colour (`run` is progress, R18)', () => {
  const clock = { nowMs: NOW, timeZone: 'UTC' };
  const look = lookFor(TERM_256, 160);
  const road = roadRow({ name: 'p9', step: 1, steps: 3 }, null, clock, look);
  assert.ok(road.startsWith(`road p9${paint(' · ', STATE.dim, look)}\u001b[38;5;37mstep 1/3`), road);
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

/** The rows of a mockup state on a terminal with this environment, `columns` wide. */
const mockupRows = (state, env, columns) => {
  const full = { ...TERM_256, HOME: MOCKUP_HOME, ...state.env, ...env };
  return statusRows({ ...state.view, env: full }, lookOf(full, 'darwin', columns - 5));
};

test('RC18: every mockup state gives the mockup\'s exact text at each width it shows, and fits COLUMNS - 5 at 80, 100 and 120', () => {
  let compared = 0;
  for (const state of mockupStates()) {
    for (const columns of [80, 100, 120]) {
      const rows = mockupRows(state, {}, columns).map(plain);
      if (state.expected[columns]) {
        assert.deepEqual(rows, state.expected[columns], `${state.name} at ${columns}`);
        compared += 1;
      }
      for (const row of rows) assert.ok([...row].length <= columns - 5, `${state.name} ${columns}: ${row}`);
    }
  }
  assert.equal(compared, 13, 'every mockup copy (11 at 100 columns, one at 80, one at 120) is compared');
});

/** Each coloured text of a row with its SGR code (bold dropped): [code, text]. */
function colouredTexts(row) {
  const found = [];
  for (const match of row.matchAll(/\u001b\[([0-9;]+)m((?:\u001b\[[0-9;]+m)*)([^\u001b]*)/g)) {
    const code = [match[1], ...[...match[2].matchAll(/\u001b\[([0-9;]+)m/g)].map((inner) => inner[1])].filter((sgr) => sgr !== '1' && sgr !== '0').at(-1);
    if (code !== undefined && match[3] !== '') found.push([code, match[3]]);
  }
  return found;
}

// P1: each kind's colour is on that kind of text only (branch names, bars and their counts, durations and clocks, session values).
const KIND_TEXT = {
  branch: /^(main|r1[78]-[a-z]+|feat\/auth-i18n)$/,
  bar: /^([█░]+|\d+(\/| of )\d+ (rows done|lanes landed|lanes))$/,
  time: /^(\d+ min|\d+ h \d\d|\d\d:\d\d)$/,
  session: /^(Opus 5\.5 high| \d+%| \d+% left| mine)$/,
};
const PALETTE_CODES = {
  dark: { branch: '38;5;35', bar: '38;5;37', time: '38;5;33', session: '38;5;103' },
  light: { branch: '38;5;28', bar: '38;5;30', time: '38;5;25', session: '38;5;60' },
  16: { branch: '32', bar: '36', time: '34', session: '37' },
};
const PALETTE_ENV = { dark: {}, light: { CLAUDE_STATUS_THEME: '', COLORFGBG: '0;15' }, 16: { TERM: 'xterm', COLORTERM: '' } };

test('P1 RC14 RC20: one colour per kind on the dark, light (COLORFGBG) and 16-colour palettes; yellow, red, magenta and dim only as reserved', () => {
  for (const [palette, codes] of Object.entries(PALETTE_CODES)) {
    const kindOf = new Map(Object.entries(codes).map(([kind, code]) => [code, kind]));
    const seen = new Set();
    for (const state of mockupStates().filter((entry) => !entry.env.CLAUDE_STATUS_THEME)) {
      for (const row of mockupRows(state, PALETTE_ENV[palette], 100)) {
        for (const [code, text] of colouredTexts(row)) {
          const kind = kindOf.get(code);
          if (kind === undefined) {
            assert.ok(['2', '31', '33', '35'].includes(code), `${palette} ${state.name}: SGR ${code} on ${JSON.stringify(text)}`);
            continue;
          }
          assert.match(text, KIND_TEXT[kind], `${palette} ${state.name}: ${kind} colour on ${JSON.stringify(text)}`);
          seen.add(kind);
        }
      }
    }
    assert.deepEqual([...seen].sort(), Object.keys(codes).sort(), `${palette}: every kind is drawn`);
  }
  const light = mockupStates().find((entry) => entry.name === 'job-running-light');
  assert.ok(mockupRows(light, {}, 100).join('').includes('\u001b[38;5;28mmain'), 'CLAUDE_STATUS_THEME=light gives the light palette');
});

test('the reserved states: late yellow, past the 85 % margin red, a failed check red, to pull and needs rebase yellow, the question magenta', () => {
  const byName = Object.fromEntries(mockupStates().map((state) => [state.name, state]));
  const has = (name, text) => assert.ok(mockupRows(byName[name], {}, 100).join('\n').includes(text), `${name}: ${JSON.stringify(text)}`);
  has('job-late', '\u001b[33m, 25 min late\u001b[0m\u001b[33m: 3 rows added');
  has('past-p85', '\u001b[31m, 1 h 10 late\u001b[0m\u001b[31m: R18.git slow');
  has('past-p85', '\u001b[31mcheck failed: tests');
  has('job-late', '\u001b[33m↓1 to pull');
  has('idle-lanes', '\u001b[33m ↓5 needs rebase');
  has('several-repos', '\u001b[33mrebase 3/7');
  has('question', '\u001b[1m\u001b[35m? ANSWER NEEDED');
  const idleReserved = mockupRows(byName['idle-in-repo'], {}, 100).flatMap(colouredTexts).filter(([code]) => ['31', '33', '35'].includes(code));
  assert.deepEqual(idleReserved, [['33', ', empty ~22:32']], 'idle: the only reserved colour is the 5 h pace');
});
