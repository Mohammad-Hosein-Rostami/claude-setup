// Unit tests of the call-window log (home/hooks/lib/call-windows.mjs), the ownership rules (lib/change-owner.mjs), namesPath
// (lib/new-file-size.mjs) and baselineOf (lib/dirty-baseline.mjs): line shapes, closing rules, the usable check, watches, claims.
// Spec: round 9 spec-p1-gates-fix.md 2.2 with the corrections K1', K2', K4', K11'. Every test runs under a temp HOME (P8).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addWatch, MAX_EDGE_LINE_BYTES, MAX_WINDOW_LOG_BYTES, readCallWindows, recordCallEdge } from '../home/hooks/lib/call-windows.mjs';
import { claimed, missingToolUses, ownsInstant, ownsOffset } from '../home/hooks/lib/change-owner.mjs';
import { namesPath } from '../home/hooks/lib/new-file-size.mjs';
import { baselineOf, saveBaseline } from '../home/hooks/lib/dirty-baseline.mjs';
import { CLEAN_ENV, commit, makeRepo } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { edges, leadTranscript, LOG_DIR, logPath, OTHER, readLog, reflogOf, SESSION, sizeOf, writeLog } from './call-windows-helpers.mjs';

const homeEnv = (project) => {
  const home = makeTempDir('call-windows-home-');
  return { home, env: { ...CLEAN_ENV, HOME: home, USERPROFILE: home, ...(project ? { CLAUDE_PROJECT_DIR: project } : {}) } };
};
const pre = (fields) => ({ hook_event_name: 'PreToolUse', session_id: SESSION, ...fields });
const windowsOf = (env, session = SESSION) => readCallWindows(env, session, Date.now() + 1500);
const FAR = 10 ** 12; // an `at` far from any window

test('line shapes: open, close, batch and quiet as the spec table; tools that change nothing and closes without an id write nothing', () => {
  const { home, env } = homeEnv();
  const folder = realpathSync(makeTempDir('no-repo-'));
  assert.equal(recordCallEdge(pre({ tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: '/x' }, cwd: folder }), env), false);
  recordCallEdge(pre({ tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'x', timeout: 5000 }, cwd: folder }), env);
  recordCallEdge(pre({ tool_name: 'Bash', tool_use_id: 'b2', tool_input: { command: 'x', run_in_background: true }, cwd: folder, agent_id: 'a1' }), env);
  recordCallEdge(pre({ tool_name: 'Workflow', tool_use_id: 'w1', tool_input: {}, cwd: folder }), env);
  recordCallEdge(pre({ tool_name: 'Write', tool_use_id: 'e1', tool_input: { file_path: join(folder, 'f.txt') }, cwd: folder }), env);
  recordCallEdge(pre({ tool_name: 'Write', tool_use_id: 'e2', tool_input: { file_path: join(folder, '.git', 'config') }, cwd: folder }), env);
  assert.equal(recordCallEdge({ hook_event_name: 'PostToolUse', session_id: SESSION, tool_name: 'Bash', tool_input: {} }, env), false);
  recordCallEdge({ hook_event_name: 'PostToolUse', session_id: SESSION, tool_name: 'Bash', tool_use_id: 'b1', tool_response: { backgroundTaskId: 't1' } }, env);
  recordCallEdge({ hook_event_name: 'PostToolUseFailure', session_id: SESSION, tool_name: 'Bash', tool_use_id: 'b2', agent_id: 'a1', error: 'x' }, env);
  recordCallEdge({ hook_event_name: 'PostToolBatch', session_id: SESSION, tool_calls: [{ tool_name: 'Bash', tool_use_id: 'b1' }, { tool_name: 'Read', tool_use_id: 'r1' }] }, env);
  recordCallEdge({ hook_event_name: 'Stop', session_id: SESSION }, env);
  recordCallEdge({ hook_event_name: 'Stop', session_id: SESSION, background_tasks: [{ type: 'shell' }, { type: 7 }] }, env);
  const lines = readLog(home);
  assert.deepEqual(lines.map(({ t, id }) => `${t}:${id ?? ''}`), ['open:b1', 'open:b2', 'open:w1', 'open:e1', 'open:e2', 'close:b1', 'close:b2', 'batch:', 'quiet:']);
  const [b1, b2, w1, e1, e2, c1, c2, batch, quiet] = lines;
  assert.deepEqual([b1.agent, b1.tool, b1.bg, b1.lim, typeof b1.at, Array.isArray(b1.b)], ['', 'Bash', false, 5000, 'number', true]);
  assert.deepEqual([b2.agent, b2.bg, w1.bg, e1.path, e2.path], ['a1', true, true, join(folder, 'f.txt'), undefined]);
  assert.deepEqual([c1.bg, c2.bg, c2.agent, batch.ids, quiet.types], [true, false, 'a1', ['b1'], ['shell', 'unknown']]);
});

test('watching: the project repo\'s main reflog is watched at its size and tip, every later line carries its size; a folder line names the top', () => {
  const dir = makeRepo();
  const { home, env } = homeEnv(dir);
  recordCallEdge(pre({ tool_name: 'Bash', tool_use_id: 'b1', tool_input: {}, cwd: makeTempDir('elsewhere-') }), env);
  commit(dir, 'two.txt');
  recordCallEdge({ hook_event_name: 'PostToolUse', session_id: SESSION, tool_name: 'Bash', tool_use_id: 'b1' }, env);
  const lines = readLog(home);
  const watch = lines.find((line) => line.t === 'watch' && line.k === 0);
  assert.equal(watch.reflog, reflogOf(dir, 'main'));
  assert.equal(watch.settled, false);
  assert.match(watch.tip, /^[0-9a-f]{40}$/);
  assert.ok(lines.some((line) => line.t === 'watch' && line.top === dir), 'the worktree folder is named');
  const [open, close] = lines.filter((line) => line.t !== 'watch');
  assert.equal(open.b[0], watch.bytes);
  assert.equal(close.b[0], sizeOf(reflogOf(dir, 'main')));
  assert.ok(close.b[0] > open.b[0]);
  assert.equal(addWatch(env, SESSION, reflogOf(dir, 'main'), true), true, 'a gate adds a settled line for the same index');
  assert.deepEqual(readLog(home).at(-1).k, 0);
});

test('closing rules: close line, else batch, else the quiet line of its agent; the later of close and batch is the edge', () => {
  const { home, env } = homeEnv();
  writeLog(home, SESSION, [
    edges.open('a', 100, [0]), edges.close('a', 200, [10]), edges.batch(['a'], 250, [12]),
    edges.open('b', 300, [12]), edges.batch(['b'], 400, [20]),
    edges.open('c', 500, [20]), edges.open(null, 510, [20]), edges.quiet([], 600, [30]),
    edges.open('d', 700, [30], { agent: 'x1' }), edges.quiet([], 800, [40]),
  ]);
  const { usable, windows } = windowsOf(env);
  assert.equal(usable, true);
  const byId = (id, agent = '') => windows.find((w) => w.id === id && w.agent === agent && w.kind === 'program');
  assert.deepEqual([byId('a').closeAt, byId('a').closeB, byId('a').edge], [250, [12], true]);
  assert.deepEqual([byId('b').closeAt, byId('c').closeAt, byId(null).closeAt, byId('c').edge], [400, 600, 600, false]);
  assert.equal(byId('d', 'x1').closeAt, Infinity, 'a quiet line of another agent does not close it');
});

test('background calls: the lead\'s closes at a quiet line without its kind; an unknown type, a subagent\'s call, or none at all keep it open', () => {
  const { home, env } = homeEnv();
  writeLog(home, SESSION, [
    edges.open('s', 100, [0], { bg: true }), edges.close('s', 110, [0]),
    edges.open('m', 120, [0], { tool: 'Monitor', bg: true }),
    edges.open('sub', 130, [0], { bg: true, agent: 'a1' }),
    edges.quiet(['shell'], 200, [0]), edges.quiet(['local_bash'], 300, [0]), edges.quiet(['monitor'], 400, [0]), edges.quiet([], 500, [0]),
  ]);
  const { windows } = windowsOf(env);
  const w = (id) => windows.find((x) => x.id === id);
  assert.equal(w('s').closeAt, 400, 'not at its close line, not at a quiet line with shell or an unknown type');
  assert.equal(w('m').closeAt, 200, 'no monitor task left at the first quiet line');
  assert.equal(w('sub').closeAt, Infinity);
});

test('a foreground call that ran into its timeout, or whose response has timedOutAfterMs, is a background call', () => {
  const { home, env } = homeEnv();
  writeLog(home, SESSION, [
    edges.open('t', 0, [0], { lim: 120000 }), edges.close('t', 119000, [0]),
    edges.open('u', 200000, [0], { lim: 120000 }), edges.close('u', 200100, [0], { bg: true }),
    edges.open('v', 300000, [0], { lim: 120000 }), edges.close('v', 300100, [0]), edges.quiet([], 400000, [0]),
  ]);
  const { windows } = windowsOf(env);
  const w = (id) => windows.find((x) => x.id === id);
  assert.deepEqual([w('t').closeAt, w('u').closeAt, w('v').closeAt], [400000, 400000, 300100]);
});

test('missed calls are own windows: a close with no open, a quiet line naming shell with no bg window; each quiet line opens a stop-hook window', () => {
  const { home, env } = homeEnv();
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x', timeout: 150 }] }] } }));
  writeLog(home, SESSION, [edges.open('a', 1000, [0]), edges.close('lost', 2000, [5]), edges.quiet([], 3000, [5]), edges.quiet(['shell'], 9000, [5]), edges.quiet([], 20000, [5])]);
  const { windows } = windowsOf(env);
  const lost = windows.find((w) => w.id === 'lost');
  assert.deepEqual([lost.openAt, lost.closeAt, lost.kind], [1000, 2000, 'program']);
  assert.ok(windows.some((w) => w.missed === 'shell' && w.openAt === 3000 && w.closeAt === 20000));
  assert.ok(windows.some((w) => w.stopHook && w.openAt === 3000 && w.closeAt === 3000 + 150000));
  writeFileSync(join(home, '.claude', 'settings.json'), '{');
  assert.ok(windowsOf(env).windows.some((w) => w.stopHook && w.closeAt === 3000 + 600000), 'unreadable settings: the documented 600 s');
});

test('the log is unusable at the cap, with a bad line or an unknown kind, or when it is a link or a FIFO; one line under the cap is usable', () => {
  const { home, env } = homeEnv();
  writeLog(home, SESSION, [edges.open('a', 1, [0])]);
  truncateSync(logPath(home), MAX_WINDOW_LOG_BYTES - MAX_EDGE_LINE_BYTES);
  assert.equal(windowsOf(env).usable, false, 'the padding is not JSON');
  for (const [text, usable] of [[`${JSON.stringify(edges.open('a', 1, [0]))}\n`, true], ['{"t":"open"\n', false], [`${JSON.stringify({ t: 'other', at: 1 })}\n`, false]]) {
    writeFileSync(logPath(home), text);
    assert.equal(windowsOf(env).usable, usable, text);
  }
  writeFileSync(logPath(home), `${JSON.stringify(edges.open('a', 1, [0]))}\n`.padEnd(MAX_WINDOW_LOG_BYTES - MAX_EDGE_LINE_BYTES, ' '));
  assert.equal(windowsOf(env).usable, true, 'one line under the cap (trailing blanks are ignored)');
  writeFileSync(logPath(home), `${JSON.stringify(edges.open('a', 1, [0]))}\n`.padEnd(MAX_WINDOW_LOG_BYTES - MAX_EDGE_LINE_BYTES + 1, ' '));
  assert.equal(windowsOf(env).usable, false, 'at the cap: a line may have been refused');
  const linked = homeEnv();
  mkdirSync(LOG_DIR(linked.home), { recursive: true, mode: 0o700 });
  writeFileSync(join(linked.home, 'real.jsonl'), `${JSON.stringify(edges.open('a', 1, [0]))}\n`);
  symlinkSync(join(linked.home, 'real.jsonl'), logPath(linked.home));
  assert.equal(windowsOf(linked.env).usable, false);
  assert.equal(recordCallEdge(pre({ tool_name: 'Bash', tool_use_id: 'x', tool_input: {}, cwd: linked.home }), linked.env), false, 'never written through a link');
  const fifo = homeEnv();
  mkdirSync(LOG_DIR(fifo.home), { recursive: true, mode: 0o700 });
  if (spawnSync('mkfifo', [logPath(fifo.home)]).status === 0) {
    assert.equal(windowsOf(fifo.env).usable, false, 'a FIFO is refused without a hang');
    assert.equal(recordCallEdge(pre({ tool_name: 'Bash', tool_use_id: 'x', tool_input: {}, cwd: fifo.home }), fifo.env), false);
  }
});

test('two processes appending 200 edges each: every line parses (P7)', async () => {
  const { home, env } = homeEnv();
  const script = `import { recordCallEdge } from ${JSON.stringify(new URL('../home/hooks/lib/call-windows.mjs', import.meta.url).href)};
    for (let i = 0; i < 200; i += 1) recordCallEdge({ hook_event_name: 'PreToolUse', session_id: '${SESSION}', tool_name: 'Bash', tool_use_id: process.argv[1] + i, tool_input: {}, cwd: ${JSON.stringify(home)} }, process.env);`;
  const runs = ['p', 'q'].map((tag) => new Promise((done) => spawn(process.execPath, ['--input-type=module', '-e', script, tag], { env, stdio: 'ignore' }).on('exit', done)));
  assert.deepEqual(await Promise.all(runs), [0, 0]);
  const lines = readLog(home);
  assert.equal(lines.length, 400);
  assert.equal(windowsOf(env).usable, true);
});

test('ownsOffset and ownsInstant: program windows in scope only; a subagent sees its own windows; slack on the instants', () => {
  const { home, env } = homeEnv();
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'x', timeout: 1 }] }] } }));
  writeLog(home, SESSION, [edges.watch(0, '/r', 0, 'a', 1), edges.open('a', 1000, [10]), edges.close('a', 2000, [20]), edges.open('p', 5000, [20], { tool: 'Write', path: '/f' }), edges.close('p', 6000, [30]), edges.open('s', 8000, [30], { agent: 'x1' }), edges.close('s', 9000, [40], { agent: 'x1' })]);
  const log = windowsOf(env);
  assert.deepEqual([9, 10, 19, 20].map((o) => ownsOffset(log, null, 0, o)), [false, true, true, false]);
  assert.equal(ownsOffset(log, null, 0, 25), false, 'a path window owns no reflog line');
  assert.deepEqual([ownsOffset(log, 'x1', 0, 15), ownsOffset(log, 'x1', 0, 35), ownsOffset(log, null, 0, 35)], [false, true, true]);
  assert.deepEqual([ownsInstant(log, null, 3999), ownsInstant(log, null, 4001), ownsInstant(log, null, -1001), ownsInstant(log, null, 5500)], [true, false, false, false]);
});

test('claims: only a closed window of an OLDER usable log; a file by a path window or by a log that watched the worktree first (K1\', K2\')', () => {
  const { home, env } = homeEnv();
  writeLog(home, SESSION, [edges.open('own', 5000, [0]), edges.close('own', 5001, [0])]);
  const ctx = { env, session: SESSION, agent: null, log: windowsOf(env), top: '/top', deadlineMs: Date.now() + 1500 };
  writeLog(home, OTHER, [edges.watch(0, '/r', 0, 'a', 10), edges.open('o', 100, [5]), edges.close('o', 200, [9]), edges.open('w', 300, [9], { tool: 'Write', path: '/top/f' }), edges.close('w', 400, [9])]);
  assert.deepEqual([claimed({ ...ctx }, { reflog: '/r', offset: 5 }), claimed({ ...ctx }, { reflog: '/r', offset: 9 })], [true, false]);
  assert.deepEqual([claimed({ ...ctx }, { ms: 350, path: '/top/f' }), claimed({ ...ctx }, { ms: 150, path: '/top/g' })], [true, false], 'a program window of a log that never watched /top');
  appendFileFolder(home);
  assert.equal(claimed({ ...ctx }, { ms: 150, path: '/top/g' }), false, 'the folder watch came after that window opened');
  writeLog(home, 'third', [edges.folder('/top', 20), edges.open('t', 1000, []), edges.close('t', 2000, [])]);
  assert.equal(claimed({ ...ctx }, { ms: 1500, path: '/top/g' }), true);
  writeLog(home, 'younger', [edges.watch(0, '/r', 0, 'a', 6000), edges.open('y', 6001, [30], { tool: 'Write', path: '/top/y' }), edges.close('y', 8000, [40])]);
  assert.equal(claimed({ ...ctx }, { ms: 7000, path: '/top/y' }), false, 'a log younger than this session never claims (U6 open)');
  assert.equal(claimed({ ...ctx }, { reflog: '/r', offset: 35 }), false);
  writeFileSync(logPath(home, 'third'), '{bad\n');
  assert.equal(claimed({ ...ctx }, { ms: 1500, path: '/top/g' }), false, 'an unusable log claims nothing');
  assert.equal(claimed({ ...ctx, deadlineMs: Date.now() - 1 }, { reflog: '/r', offset: 5 }), false, 'past the deadline');
  assert.equal(claimed({ ...ctx, claimBudgetBytes: 10 }, { reflog: '/r', offset: 5 }), false, 'past the byte budget');
});

function appendFileFolder(home) {
  writeLog(home, OTHER, [...readLog(home, OTHER), edges.folder('/top', 250)]);
}

test('missingToolUses: a tool_use id with no open line; drift finds nothing; Read calls are not asked for', () => {
  const { home, env } = homeEnv();
  writeLog(home, SESSION, [edges.open('m1', FAR, [])]);
  const log = windowsOf(env);
  const ctx = { env, session: SESSION, agent: null, log, deadlineMs: Date.now() + 1500 };
  assert.deepEqual(missingToolUses({ ...ctx, transcriptPath: leadTranscript(0, ['m1']) }), []);
  assert.deepEqual(missingToolUses({ ...ctx, transcriptPath: leadTranscript(0, ['m1', 'm2']) }), ['m2']);
  assert.deepEqual(missingToolUses({ ...ctx, transcriptPath: leadTranscript(0, [], { extra: [{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r', name: 'Read' }] } }, { kind: 'drifted', tool: 'm9' }] }) }), []);
  assert.equal(missingToolUses({ ...ctx, transcriptPath: join(home, 'none.jsonl') }), null, 'an unreadable transcript is not "nothing missing"');
});

test('namesPath: the whole path in exact case, not next to a path character; baselineOf returns top, head and takenMs', () => {
  assert.equal(namesPath('add big/blob.bin to the lane', 'big/blob.bin', '/r/big/blob.bin'), true);
  assert.equal(namesPath('see /r/big/blob.bin, please', 'big/blob.bin', '/r/big/blob.bin'), true);
  for (const text of ['add big/blob.bin2', 'add xbig/blob.bin', 'add Big/blob.bin', 'add big/blob.bin/', '']) assert.equal(namesPath(text, 'big/blob.bin', '/r/big/blob.bin'), false, text);
  const { env } = homeEnv();
  assert.equal(baselineOf(env, SESSION, ''), null);
  saveBaseline(env, SESSION, '', '/top', [], 'abc');
  const base = baselineOf(env, SESSION, '');
  assert.deepEqual([base.top, base.head, typeof base.takenMs], ['/top', 'abc', 'number']);
});
