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

/** One step a minute from minute `from` to `to` (the status line draws every few seconds, so a live item is seen all the time). */
const minutes = (names, from, to) => Array.from({ length: to - from + 1 }, (_, index) => ({ names, atMin: from + index }));

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
  for (const seventh of ['g', 'h', 'i', 'j', 'k', 'l']) {
    const six = names.slice(0, 6);
    const joined = walk([...six.map((_, count) => ({ names: six.slice(0, count + 1), atMin: count })), { names: [...six, seventh], atMin: 6 }]).at(-1);
    assert.equal(hueOfName(joined, seventh), hueOfName(boardIdentity(boardOfNames([seventh])), seventh), `${seventh} takes its home hue`);
  }
  for (const leaving of names.slice(0, 6)) {
    const rest = names.filter((name) => name !== leaving);
    const after = walk([...steps, ...minutes(names, 7, 10), { names: rest, atMin: 11 }]).at(-1);
    assert.deepEqual(huesOf(after, rest), huesOf(final, rest), `${leaving} left: nobody else moved, the shared hue stays shared`);
  }
});

test('an item back after more than 5 minutes whose hue a newcomer took meanwhile gets another free hue, and a returning one with a free hue keeps it', () => {
  const alone = (name) => hueOfName(boardIdentity(boardOfNames([name])), name);
  const taken = alone('returning');
  const newcomer = Array.from({ length: 200 }, (_, index) => `new-${index}`).find((name) => alone(name) === taken);
  assert.ok(newcomer, 'a name whose home hue is the returning one\'s');
  const [first, away, back] = walk([{ names: ['returning'], atMin: 0 }, ...minutes([newcomer], 10, 19), { names: ['returning', newcomer], atMin: 20 }]).filter((_, index, all) => [0, 1, all.length - 1].includes(index));
  assert.equal(hueOfName(first, 'returning'), taken);
  assert.equal(hueOfName(away, newcomer), taken, 'the free hue was taken while it was away');
  assert.equal(hueOfName(back, newcomer), taken, 'the item that stayed keeps its hue');
  assert.notEqual(hueOfName(back, 'returning'), taken, 'two live items never share while a hue is free');
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
  const bad = [undefined, 'text', 5, [], {}, { v: 2, items: [] }, { v: 2, items: [{ name: 'a', hue: (fresh.a + 1) % HUE_CODES.length, seenMs: NOW, sinceMs: NOW }] }, { v: 1, items: 'x' }, { v: 1, items: [null, 5, 'x', { name: 'a' }, { name: 'a', hue: 99, seenMs: 0, sinceMs: 0 }, { name: 'a', hue: 1.5, seenMs: 0, sinceMs: 0 }, { name: 'b', hue: 1, seenMs: 'x', sinceMs: 0 }] }];
  for (const store of bad) assert.deepEqual(huesOf(boardIdentity(board, store, NOW), ['a', 'b', 'c']), fresh, JSON.stringify(store));
});

test('a run\'s phase over 16 characters is cut at a word with the cut mark', () => {
  const board = { ...screenshotBoard(), agents: [], repo: null };
  board.runs = [{ ...board.runs[0], phase: 'Delta review of every lane' }];
  const { look, ctx } = rowsFor(board);
  assert.match(plain(runHeader(board.runs[0], [], ctx, look)), /phase 1\/1 Delta review of… /);
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

test('a finished agent counts only when no running agent is placed: the run says `on` the lane of its running agents, else of its finished ones', () => {
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
  assert.match(plain(rowsFor(board).header(run, [])), / on old-lane /, 'only a finished agent: its lane stays while no running agent is placed (SA3)');
});

test('a workflow keeps its lane and its hue after its implementer finishes, while read-only reviewers run (SA3)', () => {
  const board = screenshotBoard();
  const run = board.runs[0];
  const writer = { ...board.agents[0], runId: run.runId, state: 'done', doneMs: NOW - MIN_MS };
  const reader = (id) => ({ ...board.agents[1], id, runId: run.runId, state: 'run' });
  board.agents = [writer, reader('r1'), reader('r2')];
  const { look, ctx, header } = rowsFor(board);
  const runRow = header(run, []);
  assert.match(plain(runRow), / on remove-modes /);
  const gitRow = repoRows(board, Infinity, ctx, look).find((row) => plain(row).includes('⎇ ') && plain(row).includes(' remove-modes'));
  const [runLook, gitLook] = [runRow, gitRow].map((row) => /((?:\u001b\[[0-9;]*m)*)(?:▸|⎇) (\S) /.exec(row).slice(1, 3));
  assert.deepEqual(runLook, gitLook, 'the workflow row and the lane row keep one hue and marker');
  board.agents = [writer, { ...writer, id: 'w2', wt: 'road-gate-landed-row', branch: 'road-gate-landed-row' }, { ...writer, id: 'w3', state: 'run', wt: 'road-gate-landed-row', branch: 'road-gate-landed-row' }];
  assert.match(plain(rowsFor(board).header(run, [])), / on road-gate-landed-row /, 'a running writer on one lane beats finished ones on another');
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

const homeOf = (name) => hueOfName(boardIdentity(boardOfNames([name])), name);
/** A name (not `not`) whose home hue is the given hue. */
const nameHomedAt = (hue, not = []) => Array.from({ length: 400 }, (_, index) => `new-${index}`).find((name) => homeOf(name) === hue && !not.includes(name));

test('an item back within 5 minutes keeps its hue and a newcomer that came meanwhile gets another one (N1, RISK-8)', () => {
  const newcomer = nameHomedAt(homeOf('returning'));
  assert.ok(newcomer);
  for (const awayMin of [1, 2, 4]) {
    const [first, , back] = walk([{ names: ['returning'], atMin: 0 }, { names: [newcomer], atMin: awayMin }, { names: ['returning', newcomer], atMin: awayMin + 1 }]);
    assert.equal(hueOfName(back, 'returning'), hueOfName(first, 'returning'), `gone ${awayMin} min: the returning item keeps its hue`);
    assert.notEqual(hueOfName(back, newcomer), hueOfName(back, 'returning'), `gone ${awayMin} min: no two live items share`);
  }
});

test('an item the store marks as away that comes back while a live item holds its hue moves to a free hue; two live items that stayed keep sharing', () => {
  const held = 2;
  const item = (name, seenMs, extra = {}) => ({ name, hue: held, seenMs, sinceMs: seenMs - MIN_MS, ...extra });
  const store = { v: 1, items: [item('older', NOW - 2 * MIN_MS, { away: true }), item('newer', NOW - MIN_MS)] };
  const identity = boardIdentity(boardOfNames(['older', 'newer']), store, NOW);
  assert.equal(hueOfName(identity, 'newer'), held);
  assert.notEqual(hueOfName(identity, 'older'), held);
  assert.equal(identity.store.items.find((entry) => entry.name === 'older').away, undefined, 'back among the live: no longer away');
  const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((name, index) => ({ name, hue: index, seenMs: NOW, sinceMs: NOW - MIN_MS }));
  const shared = boardIdentity(boardOfNames(['a', 'b', 'c', 'd', 'e', 'f', 'g']), { v: 1, items: [...six, { name: 'g', hue: 3, seenMs: NOW, sinceMs: NOW }] }, NOW);
  assert.equal(hueOfName(shared, 'g'), 3, 'all six hues held and a seventh item sharing: nothing moves');
  assert.equal(hueOfName(shared, 'd'), 3);
  const fewer = boardIdentity(boardOfNames(['b', 'c', 'd', 'e', 'f', 'g']), { v: 1, items: [...six, { name: 'g', hue: 3, seenMs: NOW, sinceMs: NOW }] }, NOW);
  assert.deepEqual([hueOfName(fewer, 'd'), hueOfName(fewer, 'g')], [3, 3], 'items that stayed live do not move when another leaves');
  const gone = boardIdentity(boardOfNames(['b']), { v: 1, items: six }, NOW).store.items;
  assert.ok(gone.find((entry) => entry.name === 'a').away === true && gone.find((entry) => entry.name === 'b').away === undefined);
});

test('for 3000 random steps with at most six live items no two share a hue, and an item live in two steps in a row keeps its hue', () => {
  const pool = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
  let seed = 20_261_122;
  const random = (limit) => { seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0; return seed % limit; };
  let store = null;
  let atMin = 0;
  let before = null;
  for (let step = 0; step < 3000; step += 1) {
    atMin += [1, 1, 1, 2, 3, 7][random(6)];
    const names = pool.filter(() => random(100) < 55).slice(0, 6);
    const identity = boardIdentity(boardOfNames(names), store, NOW + atMin * MIN_MS);
    store = identity.store ?? store;
    const hues = Object.fromEntries(names.map((name) => [name, hueOfName(identity, name)]));
    assert.equal(new Set(Object.values(hues)).size, names.length, `step ${step}: ${JSON.stringify(hues)}`);
    if (before !== null) for (const name of names) if (name in before.hues && before.atMin + 1 === atMin) assert.equal(hues[name], before.hues[name], `step ${step}: ${name} moved`);
    before = { hues, atMin };
  }
});

/** A board of workflow `wf-a` (and `extra` runs), three lane worktrees and plain agents. */
const laneBoard = (agents, runNames) => ({
  runs: runsOf(runNames), agents, repo: null, repos: [{ name: 'r', worktrees: ['lane-1', 'lane-2', 'lane-3'].map((name) => ({ name, branch: name, main: false })) }],
});
const scout = (name, state, doneMs = null) => ({ id: name, name, state, doneMs });

test('a finished agent the rows no longer show holds no hue: a new workflow takes a hue none of the items on screen has (RISK-1)', () => {
  const running = laneBoard([scout('scout-1', 'run'), scout('scout-2', 'run')], ['wf-a']);
  const first = boardIdentity(running, null, NOW);
  assert.equal(new Set(['wf-a', 'lane-1', 'lane-2', 'lane-3', 'scout-1', 'scout-2'].map((name) => hueOfName(first, name))).size, 6);
  const newcomer = nameHomedAt(hueOfName(first, 'wf-a'));
  const onScreen = ['wf-a', 'lane-1', 'lane-2', 'lane-3'];
  const hidden = laneBoard([scout('scout-1', 'done', NOW), scout('scout-2', 'done', NOW)], ['wf-a', newcomer]);
  const later = boardIdentity(hidden, first.store, NOW + MIN_MS);
  assert.ok(!onScreen.some((name) => hueOfName(later, name) === hueOfName(later, newcomer)), 'a minute after they finished the agents are not drawn');
  assert.deepEqual(huesOf(later, onScreen), huesOf(first, onScreen), 'nothing on screen moved');
  const shown = laneBoard([scout('scout-1', 'done', NOW + MIN_MS - 10_000), scout('scout-2', 'run')], ['wf-a', newcomer]);
  const soon = boardIdentity(shown, first.store, NOW + MIN_MS);
  assert.equal(hueOfName(soon, newcomer), hueOfName(soon, 'wf-a'), 'ten seconds after, the finished agent is still drawn, so all six hues are held');
  assert.equal(hueOfName(soon, 'scout-1'), hueOfName(first, 'scout-1'));
});

test('a workflow run the rows hide holds no hue', () => {
  const runs = [{ runId: 'wf_1', name: 'stopped-run', state: 'stopped?' }, { runId: 'wf_2', name: 'live-run', state: 'run' }];
  const board = { runs, agents: [], repo: null, repos: [] };
  assert.deepEqual([...boardIdentity(board, null, NOW).hues.keys()], ['live-run']);
  board.agents = [{ id: 'x', name: 'x', runId: 'wf_1', state: 'run' }];
  assert.ok(boardIdentity(board, null, NOW).hues.has('stopped-run'), 'shown while it has an agent');
});
