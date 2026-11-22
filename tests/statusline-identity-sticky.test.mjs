// Tests for the sticky identity hues (spec-tui-3 fix round 1): a work item keeps its hue while it is live whatever joins or leaves, a
// new item takes a hue no live item uses, the saved assignment (hue-store.mjs) survives a bad file, and the identity ties of
// workflows with finished, read-only and isolated-worktree agents. Pure identity.mjs calls, the saved file under a temp HOME, and
// one run of home/statusline.mjs end to end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSessionFile } from '../home/hooks/lib/session-store.mjs';
import { fitParts, HUE_CODES, hueState, lookOf, paint, STATE } from '../home/tools/board/lib/cells.mjs';
import { identityOf } from '../home/tools/board/lib/hue-store.mjs';
import { agentKey, boardIdentity, hueOf, itemKey, worktreeKey } from '../home/tools/board/lib/identity.mjs';
import { agentRow, runHeader } from '../home/tools/board/lib/agent-rows.mjs';
import { repoRows } from '../home/tools/board/lib/git-rows.mjs';
import { workRows } from '../home/tools/board/lib/layout.mjs';
import { lookFor, NO_COLOR_ENV, NOW, screenshotBoard, TERM_256 } from './statusline-identity-fixture.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const STATUSLINE = fileURLToPath(new URL('../home/statusline.mjs', import.meta.url));
const MIN_MS = 60_000;
const SESSION = 'sticky-session-1';
const CTX = { nowMs: NOW, timeZone: 'UTC', at: NOW };

const runsOf = (names) => names.map((name, index) => ({ runId: `wf_${index}_${name}`, name, state: 'run' }));
const boardOfNames = (names) => ({ runs: runsOf(names), agents: [], repo: null, repos: [] });
const hueOfName = (identity, name) => hueOf(identity, name);
const huesOf = (identity, names) => Object.fromEntries(names.map((name) => [name, hueOfName(identity, name)]));
const plain = (row) => row.replaceAll(/\u001b\[[0-9;]*m/g, '');

/** The identity of a board after a series of steps, each `{ names, atMin }`, the saved assignment carried from one to the next. */
function walk(steps) {
  let store = null;
  return steps.map(({ names, atMin }) => {
    const identity = boardIdentity(boardOfNames(names), store, NOW + atMin * MIN_MS);
    store = identity.store ?? store;
    return identity;
  });
}

test('a name keeps its hue when other items join or leave', () => {
  const first = ['zeta', 'alpha', 'road-gate'];
  const joined = [...first, 'newcomer-1', 'newcomer-2', 'newcomer-3'];
  const [start, more, back] = walk([{ names: first, atMin: 0 }, { names: joined, atMin: 1 }, { names: ['zeta'], atMin: 2 }]);
  assert.deepEqual(huesOf(more, first), huesOf(start, first), 'three items joined');
  assert.equal(hueOfName(back, 'zeta'), hueOfName(start, 'zeta'), 'five items left');
});

test('with six items or fewer no two live items share a hue, however the names hash', () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f'];
  for (let count = 1; count <= names.length; count += 1) {
    const [identity] = walk([{ names: names.slice(0, count), atMin: 0 }]);
    assert.equal(new Set(names.slice(0, count).map((name) => hueOfName(identity, name))).size, count);
  }
  for (const order of [names, [...names].reverse()]) {
    const steps = order.map((_, count) => ({ names: order.slice(0, count + 1), atMin: count }));
    const identity = walk(steps).at(-1);
    assert.equal(new Set(names.map((name) => hueOfName(identity, name))).size, names.length, `joined one by one: ${order}`);
  }
});

test('the seventh live item shares a hue and every item keeps its hue from then on', () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const steps = names.map((_, count) => ({ names: names.slice(0, count + 1), atMin: count }));
  const identities = walk(steps);
  const final = identities.at(-1);
  assert.ok(HUE_CODES.length < names.length);
  assert.equal(new Set(names.map((name) => hueOfName(final, name))).size, HUE_CODES.length, 'six hues for seven items');
  assert.deepEqual(huesOf(final, names.slice(0, 6)), huesOf(identities[5], names.slice(0, 6)), 'the first six did not move');
  const [again, fewer] = walk([...steps, { names, atMin: 10 }, { names: names.slice(0, 6), atMin: 11 }]).slice(-2);
  assert.deepEqual(huesOf(again, names), huesOf(final, names));
  assert.deepEqual(huesOf(fewer, names.slice(0, 6)), huesOf(final, names.slice(0, 6)), 'when the seventh leaves nothing moves');
});

test('a new item takes the first hue from its home that no live item uses, and a lone name gets the same hue on every board', () => {
  const alone = (names) => hueOfName(boardIdentity(boardOfNames(names)), 'lone-name');
  assert.equal(alone(['lone-name']), alone(['lone-name']));
  const [start, later] = walk([{ names: ['lone-name'], atMin: 0 }, { names: ['lone-name', 'other-1'], atMin: 1 }]);
  assert.equal(hueOfName(later, 'lone-name'), hueOfName(start, 'lone-name'));
  assert.notEqual(hueOfName(later, 'other-1'), hueOfName(later, 'lone-name'));
});

test('an item gone for more than 30 minutes is forgotten and one back sooner has its hue again', () => {
  const [start, away, soon] = walk([{ names: ['keeper', 'x1', 'x2'], atMin: 0 }, { names: ['x1', 'x2', 'x3', 'x4', 'x5'], atMin: 10 }, { names: ['keeper', 'x1', 'x2'], atMin: 20 }]);
  assert.ok(away.store.items.some((item) => item.name === 'keeper'), 'remembered while away');
  assert.equal(hueOfName(soon, 'keeper'), hueOfName(start, 'keeper'));
  const gone = walk([{ names: ['keeper'], atMin: 0 }, { names: ['x1'], atMin: 1 }, { names: ['x1'], atMin: 40 }])[2];
  assert.ok(!gone.store.items.some((item) => item.name === 'keeper'), 'forgotten after 30 minutes');
});

test('a steady board asks for no new save, a changed one does, and the saved items stay few and plain', () => {
  const [first, steady] = walk([{ names: ['a', 'b'], atMin: 0 }, { names: ['a', 'b'], atMin: 1 }]);
  assert.ok(first.store !== null);
  assert.equal(steady.store, null);
  const many = boardIdentity(boardOfNames(Array.from({ length: 200 }, (_, index) => `item-${index}`)), null, NOW);
  assert.ok(many.store.items.length <= 64);
  const long = boardIdentity(boardOfNames(['n'.repeat(500)]), null, NOW);
  assert.equal(long.store?.items?.length ?? 0, 0, 'a name too long to store is not stored');
  assert.ok(Number.isInteger(hueOfName(long, 'n'.repeat(500))));
});

test('a bad saved assignment starts fresh and never throws', () => {
  const board = boardOfNames(['a', 'b', 'c']);
  const fresh = huesOf(boardIdentity(board), ['a', 'b', 'c']);
  const bad = [undefined, 'text', 5, [], {}, { v: 2, items: [] }, { v: 1, items: 'x' }, { v: 1, items: [null, 5, 'x', { name: 'a' }, { name: 'a', hue: 99, seenMs: 0, sinceMs: 0 }, { name: 'a', hue: 1.5, seenMs: 0, sinceMs: 0 }, { name: 'b', hue: 1, seenMs: 'x', sinceMs: 0 }] }];
  for (const store of bad) assert.deepEqual(huesOf(boardIdentity(board, store, NOW), ['a', 'b', 'c']), fresh, JSON.stringify(store));
});

test('names that are no strings count as none and never throw', () => {
  const odd = { runs: [{ runId: 5, name: { toString: null } }, { runId: 'wf_x', name: null }, null, 'x'], agents: [{ name: { toString: null }, runId: 'wf_x', wt: 5, branch: {} }, null], repos: [{ worktrees: [{ name: 5, branch: {} }] }], repo: 'x' };
  const identity = boardIdentity(odd, null, NOW);
  assert.equal(itemKey(identity, odd.runs[0]), '?');
  assert.equal(itemKey(identity, odd.runs[1]), 'wf_x');
  assert.equal(agentKey(identity, odd.agents[0]), 'wf_x');
  assert.equal(worktreeKey(identity, odd.repos[0].worktrees[0]), '?');
  assert.ok(Number.isInteger(hueOf(identity, { toString: null })));
});

test('the saved hues live in the board cache under a temp HOME, are updated only when something changed, and a planted or broken file starts fresh', () => {
  const env = { HOME: makeTempDir('hue-store-home-') };
  const file = join(env.HOME, '.claude', 'state', 'board-cache', `${SESSION}-hues.json`);
  const first = identityOf(SESSION, boardOfNames(['a', 'b', 'c']), { env, nowMs: NOW });
  assert.ok(existsSync(file));
  const saved = readFileSync(file, 'utf8');
  assert.deepEqual(JSON.parse(saved).items.map((item) => item.name).sort(), ['a', 'b', 'c']);
  const next = identityOf(SESSION, boardOfNames(['a', 'b', 'c', 'd', 'e']), { env, nowMs: NOW + MIN_MS });
  assert.deepEqual(huesOf(next, ['a', 'b', 'c']), huesOf(first, ['a', 'b', 'c']));
  identityOf(SESSION, boardOfNames(['a', 'b', 'c', 'd', 'e']), { env, nowMs: NOW + 2 * MIN_MS });
  const seenOfA = () => JSON.parse(readFileSync(file, 'utf8')).items.find((item) => item.name === 'a').seenMs;
  assert.equal(seenOfA(), NOW, 'no rewrite for a steady board');
  identityOf(SESSION, boardOfNames(['a', 'b', 'c', 'd', 'e']), { env, nowMs: NOW + 3 * MIN_MS });
  assert.equal(seenOfA(), NOW + 3 * MIN_MS, 'the last-seen time moves on once it is a few minutes old');
  writeFileSync(file, '{ not json', { mode: 0o600 });
  const fresh = identityOf(SESSION, boardOfNames(['a', 'b', 'c']), { env, nowMs: NOW });
  assert.deepEqual(huesOf(fresh, ['a', 'b', 'c']), huesOf(first, ['a', 'b', 'c']), 'a broken file: the same fresh hues');
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).items.length === 3, 'and the file is whole again');
  for (const session of [undefined, null, 'a/b', '../x', 'x'.repeat(120)]) assert.ok(identityOf(session, boardOfNames(['a']), { env, nowMs: NOW }) !== undefined);
  assert.deepEqual(identityOf(SESSION, { runs: 'x', get agents() { throw new Error('hostile getter'); } }, { env }), null, 'a board that throws gives null, the renderer works it out');
});

/** A statusline.mjs run for one session: the board file in a temp HOME, the 256-colour terminal; returns the work rows' hue codes by name. */
function statuslineRun(home, runNames) {
  const board = { ...boardOfNames(runNames), session: SESSION, at: Date.now(), stale: null, refreshStartedAt: null, asking: null, git: null, road: null, trend: null };
  writeSessionFile(join(home, '.claude', 'state', 'board'), SESSION, JSON.stringify(board));
  const env = { ...process.env, HOME: home, USERPROFILE: home, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8', COLUMNS: '160', LINES: '36', NO_COLOR: '' };
  const out = spawnSync(process.execPath, [STATUSLINE], { input: JSON.stringify({ session_id: SESSION, model: { display_name: 'Opus 5.5' } }), env, encoding: 'utf8' }).stdout;
  return Object.fromEntries(runNames.map((name) => [name, new RegExp(`((?:\\u001b\\[[0-9;]*m)*)(?:▸) \\S ${name}`).exec(out)?.[1]]));
}

test('the status line keeps a workflow\'s colour from one run to the next while others start (home/statusline.mjs, temp HOME)', () => {
  const home = makeTempDir('sticky-statusline-');
  const first = statuslineRun(home, ['wf-one', 'wf-two']);
  for (const codes of Object.values(first)) assert.match(codes ?? '', /^\u001b\[38;5;\d+m$/);
  const later = statuslineRun(home, ['wf-three', 'wf-two', 'wf-one', 'wf-four']);
  assert.equal(later['wf-one'], first['wf-one']);
  assert.equal(later['wf-two'], first['wf-two']);
  assert.ok(existsSync(join(home, '.claude', 'state', 'board-cache', `${SESSION}-hues.json`)));
});

/** A run of the screenshot board whose agents are `agents`, and the rows the status line draws for it. */
function rowsFor(board, env = TERM_256, columns = 160) {
  const look = lookFor(env, columns);
  const identity = boardIdentity(board);
  const ctx = { ...CTX, repo: board.repo, repos: [board.repo], identity };
  return { look, ctx, identity, plain: (rows) => rows.map(plain), header: (run, agents) => runHeader(run, agents, ctx, look) };
}

test('a finished agent counts for no lane: the run says `on` the lane of its running agents, and none when all are finished', () => {
  const board = screenshotBoard();
  const run = board.runs[0];
  const wt = (name) => ({ ...board.repo.worktrees[1], name, branch: name });
  board.repo.worktrees.push(wt('old-lane'));
  const onLane = (name, state) => ({ ...board.agents[0], runId: run.runId, wt: name, branch: name, state });
  board.agents = [onLane('old-lane', 'done'), onLane('old-lane', 'done'), onLane('remove-modes', 'run')];
  const { header } = rowsFor(board);
  assert.match(plain(header(run, [])), / on remove-modes /);
  assert.doesNotMatch(plain(header(run, [])), /old-lane/);
  board.agents = [onLane('old-lane', 'done')];
  assert.doesNotMatch(plain(rowsFor(board).header(run, [])), / on /, 'only a finished agent: no lane');
});

test('a workflow with isolated worktree agents shows no temp branch, and its agents, worktrees and row share the workflow\'s hue and marker', () => {
  const board = screenshotBoard();
  const run = board.runs[0];
  const isolated = [1, 2, 3].map((n) => `worktree-${run.runId}-${n}`);
  board.repo.worktrees.push(...isolated.map((name) => ({ ...board.repo.worktrees[1], name, branch: name, agents: ['implementer:opus'] })));
  board.agents = isolated.map((name, index) => ({ ...board.agents[0], id: `iso${index}`, runId: run.runId, wt: name, branch: name }));
  const { look, ctx, identity, header } = rowsFor(board);
  const runRow = header(run, []);
  assert.doesNotMatch(plain(runRow), /worktree-wf/, 'no temp branch on the workflow row');
  assert.doesNotMatch(plain(runRow), / on /);
  const runCodes = /((?:\u001b\[[0-9;]*m)*)▸ (\S) /.exec(runRow);
  const gitRows = repoRows(board, Infinity, ctx, look);
  for (const name of isolated) {
    const gitRow = gitRows.find((row) => plain(row).includes(`⎇ `) && plain(row).includes(name.slice(0, 20)));
    assert.ok(gitRow, `${name} has a git row`);
    const git = /((?:\u001b\[[0-9;]*m)*)⎇ (\S) /.exec(gitRow);
    assert.deepEqual([git[1], git[2]], [runCodes[1], runCodes[2]], `${name}: hue and marker of the workflow`);
  }
  for (const agent of board.agents) {
    const row = agentRow(agent, { ...ctx, prefix: ' ' }, look);
    assert.ok(row.includes(`${runCodes[1]}${runCodes[2]} `), `agent ${agent.id}: the workflow's hue and marker`);
  }
  assert.equal(new Set([...isolated.map((name) => worktreeKey(identity, { name, branch: name })), itemKey(identity, run)]).size, 1);
});

test('the read-only agents of a workflow take the workflow\'s hue; with no placed writer the row names no lane and the lane\'s own git row keeps its own hue', () => {
  const board = screenshotBoard();
  board.agents = [{ ...board.agents[1], id: 'r1', runId: board.runs[0].runId }, { ...board.agents[1], id: 'r2', runId: board.runs[0].runId }];
  const { look, ctx, header } = rowsFor(board);
  const runRow = header(board.runs[0], []);
  const runLook = /((?:\u001b\[[0-9;]*m)*)▸ (\S) /.exec(runRow);
  assert.doesNotMatch(plain(runRow), / on /, 'no sure placement, so no lane is claimed (repos.mjs placeAgents; a name match would be a guess)');
  for (const agent of board.agents) assert.ok(agentRow(agent, { ...ctx, prefix: ' ' }, look).includes(`${runLook[1]}${runLook[2]} `));
});

test('the strip row cuts a workflow name at a boundary with the cut mark and leads it with its marker', () => {
  const board = screenshotBoard();
  const long = 'statusline-identity-colours-delta-review';
  board.runs = board.runs.map((run, index) => (index === 1 ? { ...run, name: long } : run));
  for (const env of [TERM_256, NO_COLOR_ENV]) {
    const look = lookFor(env, 120);
    const identity = boardIdentity(board);
    const rows = workRows(board, 2, { ...CTX, repo: board.repo, repos: [board.repo], identity }, look).map(plain);
    assert.match(rows[0], /^[●◆▲] remove-mode… /, `cut name, marker first: ${rows[0]}`);
    assert.match(rows[0], /[●◆▲] statusline… /, 'cut at the `-`');
    assert.doesNotMatch(rows[0], /statusline-i/);
  }
  const ascii = workRows(board, 2, { ...CTX, repo: board.repo, repos: [board.repo], identity: boardIdentity(board) }, lookFor({ ...NO_COLOR_ENV, CLAUDE_STATUS_ASCII: '1' }, 120));
  assert.match(ascii[0], /^[*+o] remove\.\.\. /);
});

test('a workflow name over 40 characters is cut with the cut mark on the row and a 40-character one is whole', () => {
  const forty = 'n'.repeat(19) + '-' + 'm'.repeat(20);
  const board = { ...screenshotBoard(), agents: [], repo: null };
  board.runs = [{ ...board.runs[0], name: forty }, { ...board.runs[1], name: `${forty}-2` }];
  const { look, ctx } = rowsFor(board);
  const [whole, cut] = board.runs.map((run) => plain(runHeader(run, [], { ...ctx, identity: boardIdentity(board) }, look)));
  assert.ok(whole.includes(` ${forty} `), whole);
  assert.ok(cut.includes(` ${forty.slice(0, 39)}… `), cut);
  assert.doesNotMatch(cut, /-2/);
});

test('the identity hues are 256-colour cube indexes no state code uses, distinct, and read on both a dark and a white background', () => {
  const look = lookOf(TERM_256, 'darwin', 100);
  const stateCodes = new Set(['\u001b[32m', '\u001b[36m', '\u001b[33m', '\u001b[31m', '\u001b[35m', '\u001b[2m', '\u001b[34m', '\u001b[1m']);
  assert.equal(new Set(HUE_CODES).size, HUE_CODES.length);
  HUE_CODES.forEach((code, index) => {
    assert.ok(code >= 16 && code < 232, `${code} is a colour-cube index`);
    const codes = /^(\u001b\[[0-9;]*m)/.exec(paint('x', hueState(index), look));
    assert.equal(codes[1], `\u001b[38;5;${code}m`);
    assert.ok(!stateCodes.has(codes[1]));
  });
  const channel = (value) => { const level = value / 255; return level <= 0.03928 ? level / 12.92 : ((level + 0.055) / 1.055) ** 2.4; };
  const cube = [0, 95, 135, 175, 215, 255];
  const luminance = (code) => { const n = code - 16; const [r, g, b] = [Math.floor(n / 36), Math.floor(n / 6) % 6, n % 6].map((step) => channel(cube[step])); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const dark = channel(30); // #1e1e1e: the three channels are equal, so the luminance is the channel's
  const measured = HUE_CODES.flatMap((code) => [ratio(luminance(code), dark), ratio(luminance(code), 1)]);
  assert.ok(Math.min(...measured) >= 3.795 && Math.min(...measured) < 3.805, `lowest ${Math.min(...measured)}: README says 3.80`);
  assert.ok(Math.max(...measured) > 4.385 && Math.max(...measured) <= 4.395, `highest ${Math.max(...measured)}: README says 4.39`);
});

test('256 colours from TERM alone, COLORTERM alone, or WT_SESSION alone (Windows Terminal), and not for a plain TERM or NO_COLOR', () => {
  const has = (env, platform = 'linux') => lookOf(env, platform, 80).colors256;
  assert.equal(has({ TERM: 'xterm-256color' }), true);
  assert.equal(has({ COLORTERM: 'truecolor' }), true);
  assert.equal(has({ COLORTERM: '24bit' }), true);
  assert.equal(has({ WT_SESSION: '1b2e-0001' }, 'win32'), true);
  assert.equal(has({ TERM: 'xterm' }), false);
  assert.equal(has({}), false);
  assert.equal(has({ WT_SESSION: '1b2e-0001', NO_COLOR: '1' }, 'win32'), false);
  assert.equal(has({ WT_SESSION: '1b2e-0001', TERM: 'dumb' }, 'win32'), false);
});

test('a part with spans that is cut keeps the state of the spans it still shows', () => {
  const look = lookOf(TERM_256, 'darwin', 12);
  const part = { text: 'ALL no job linked', spans: [{ text: 'ALL', state: STATE.strong }, { text: ' no job linked' }] };
  assert.equal(fitParts([part], look), '\u001b[1mALL\u001b[0m no job …');
  const split = { text: 'abcdefghijklmnopq', spans: [{ text: 'abcdef', state: hueState(0) }, { text: 'ghijklmnopq', state: STATE.dim }] };
  assert.equal(fitParts([split], look), `${paint('abcdef', hueState(0), look)}${paint('ghijk', STATE.dim, look)}…`);
  assert.equal(fitParts([{ text: 'x' }, { ...part, join: ' ' }], lookOf(TERM_256, 'darwin', 3)), 'x …');
});
