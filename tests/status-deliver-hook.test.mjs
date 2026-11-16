// Tests for home/hooks/status-deliver.mjs: at the end of the lead's turn, `status.mjs deliver --auto` runs on the STATUS.md the
// session linked, so a hand-over is recorded without anyone remembering it (0 of 16 old commitments were ever scored because the
// deliver rows were not written). The hook edits a file named in a state file, so a link that is not a plain STATUS.md is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSessionFile } from '../home/hooks/lib/session-store.mjs';
import { deliverAtStop } from '../home/hooks/status-deliver.mjs';
import { runStatus } from '../home/tools/status/status.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/status-deliver.mjs', import.meta.url));
const SESSION = 'lead-session-1';
const NOW = new Date('2026-11-16T14:05Z');
const HEADER = '## Work items\n\n| id | item | size | started | done | evidence |\n| -- | -- | -- | -- | -- | -- |\n';
const ALL_DONE = `${HEADER}| 1 | first | S | 2026-11-16T10:00Z | 2026-11-16T10:30Z | abc123 |\n`;
const ONE_OPEN = `${ALL_DONE}| 2 | second | S | 2026-11-16T11:00Z | - | - |\n`;
const DELIVER_ROW = /\| deliver:1 \| deliver: turn ended with no open row \| S \| - \| 2026-11-16T14:05Z \| - \|/;

const tempDir = async (name) => realpathSync(await mkdtemp(join(tmpdir(), name)));

/** A project whose STATUS.md the session linked through a status edit, as in real use. */
async function linkedProject(text, stateDir) {
  const cwd = await tempDir('deliver-project-');
  writeFileSync(join(cwd, 'STATUS.md'), text);
  assert.equal(runStatus(['rule', 'linked'], { cwd, now: NOW, sessionId: SESSION, stateDir }).code, 0);
  return { cwd, file: join(cwd, 'STATUS.md'), read: () => readFileSync(join(cwd, 'STATUS.md'), 'utf8') };
}

/** Writes the session's link by hand, as a planted or stale state file would. */
const plantLink = (stateDir, path) => writeSessionFile(join(stateDir, 'session'), SESSION, JSON.stringify({ path, at: NOW.toISOString() }), { sweep: false });

test('no session id, an unsafe one, or a session with no link: null, nothing written', async () => {
  const stateDir = await tempDir('deliver-state-');
  assert.equal(deliverAtStop({}, { stateDir, now: NOW }), null);
  assert.equal(deliverAtStop(null, { stateDir, now: NOW }), null);
  assert.equal(deliverAtStop({ session_id: '../x' }, { stateDir, now: NOW }), null);
  assert.equal(deliverAtStop({ session_id: SESSION }, { stateDir, now: NOW }), null);
});

test('a linked table with nothing open and a row done since the last hand-over gets one deliver row', async () => {
  const stateDir = await tempDir('deliver-state-');
  const { cwd, read } = await linkedProject(ALL_DONE, stateDir);
  const outcome = deliverAtStop({ session_id: SESSION, cwd, stop_hook_active: false }, { stateDir, now: NOW });
  assert.equal(outcome.code, 0);
  assert.match(read(), DELIVER_ROW);
  const again = deliverAtStop({ session_id: SESSION, cwd }, { stateDir, now: NOW });
  assert.match(again.message, /since the last hand-over/);
  assert.equal(read().match(/deliver:/g).length, 2); // the id and the item of the one row
});

test('a linked table with an open row is left as it is', async () => {
  const stateDir = await tempDir('deliver-state-');
  const { cwd, read } = await linkedProject(ONE_OPEN, stateDir);
  const before = read();
  const outcome = deliverAtStop({ session_id: SESSION, cwd }, { stateDir, now: NOW });
  assert.equal(outcome.code, 0);
  assert.match(outcome.message, /row 2 is open/);
  assert.equal(read(), before);
});

test('a link to a file that is not named STATUS.md, or to a relative path, is refused or ignored and nothing is written', async () => {
  const stateDir = await tempDir('deliver-state-');
  const cwd = await tempDir('deliver-project-');
  const notes = join(cwd, 'notes.md');
  writeFileSync(notes, ALL_DONE);
  plantLink(stateDir, notes);
  const outcome = deliverAtStop({ session_id: SESSION }, { stateDir, now: NOW });
  assert.equal(outcome.code, 1);
  assert.match(outcome.message, /not a STATUS\.md/);
  assert.equal(readFileSync(notes, 'utf8'), ALL_DONE);
  plantLink(stateDir, 'STATUS.md');
  assert.equal(deliverAtStop({ session_id: SESSION }, { stateDir, now: NOW }), null);
});

test('a linked STATUS.md that is a link, or sits behind a linked folder, is refused and the real file is untouched', async () => {
  const stateDir = await tempDir('deliver-state-');
  const real = await tempDir('deliver-real-');
  writeFileSync(join(real, 'STATUS.md'), ALL_DONE);
  const viaFile = await tempDir('deliver-link-');
  symlinkSync(join(real, 'STATUS.md'), join(viaFile, 'STATUS.md'));
  plantLink(stateDir, join(viaFile, 'STATUS.md'));
  assert.equal(deliverAtStop({ session_id: SESSION }, { stateDir, now: NOW }).code, 1);
  const parent = await tempDir('deliver-parent-');
  symlinkSync(real, join(parent, 'linked-folder'));
  plantLink(stateDir, join(parent, 'linked-folder', 'STATUS.md'));
  const outcome = deliverAtStop({ session_id: SESSION }, { stateDir, now: NOW });
  assert.equal(outcome.code, 1);
  assert.match(outcome.message, /link/);
  assert.equal(readFileSync(join(real, 'STATUS.md'), 'utf8'), ALL_DONE);
});

test('a linked STATUS.md over the size cap or missing is refused without reading it', async () => {
  const stateDir = await tempDir('deliver-state-');
  const cwd = await tempDir('deliver-project-');
  const big = `${ALL_DONE}${'x'.repeat(5 * 1024 * 1024)}\n`;
  writeFileSync(join(cwd, 'STATUS.md'), big);
  plantLink(stateDir, join(cwd, 'STATUS.md'));
  assert.match(deliverAtStop({ session_id: SESSION }, { stateDir, now: NOW }).message, /over/);
  assert.equal(readFileSync(join(cwd, 'STATUS.md'), 'utf8'), big);
  plantLink(stateDir, join(cwd, 'gone', 'STATUS.md'));
  assert.equal(deliverAtStop({ session_id: SESSION }, { stateDir, now: NOW }).code, 1);
});

/**
 * The hook as Claude Code runs it, with its own home folder (the store is ~/.claude/state/estimate under it) and no project dir.
 * stdin is the input text, or a function of the prepared project that returns it.
 */
async function runHook(stdin, prepare) {
  const home = await tempDir('deliver-home-');
  const stateDir = join(home, '.claude', 'state', 'estimate');
  mkdirSync(stateDir, { recursive: true });
  const project = prepare ? await prepare(stateDir) : undefined;
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CLAUDE_PROJECT_DIR;
  const input = typeof stdin === 'function' ? stdin(project) : stdin;
  const run = spawnSync('node', [HOOK], { input, encoding: 'utf8', env });
  return { run, project };
}

test('the hook exits 0 silently without a link, with bad input and with input over the cap; it never prints a decision', async () => {
  for (const stdin of [JSON.stringify({ session_id: SESSION }), 'not json', JSON.stringify({ session_id: SESSION, pad: 'x'.repeat(2 * 1024 * 1024) })]) {
    const { run } = await runHook(stdin);
    assert.equal(run.status, 0);
    assert.equal(run.stdout, '');
  }
  const { run } = await runHook(JSON.stringify({ session_id: SESSION }));
  assert.equal(run.stderr, '');
});

test('the hook writes the deliver row for the linked table and prints nothing', async () => {
  const stdin = ({ cwd }) => JSON.stringify({ session_id: SESSION, cwd, stop_hook_active: false });
  const { run, project } = await runHook(stdin, (stateDir) => linkedProject(ALL_DONE, stateDir));
  assert.equal(run.status, 0);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, '');
  assert.match(project.read(), /\| deliver:1 \| deliver: turn ended with no open row \| S \| - \| \d{4}-\d\d-\d\dT\d\d:\d\dZ \| - \|/);
});

// Audit of 768f9aa (SF1, option a): a session's Stop wrote a hand-over into a table of another project it had only estimated, and a
// second session in the same project wrote one into the first session's table. A hand-over is now written only into a STATUS.md
// inside the Stop input's cwd or the project dir, both resolved with realpath.
test('a linked STATUS.md outside the Stop cwd and the project dir is left alone, without a stderr line', async () => {
  const stateDir = await tempDir('deliver-state-');
  const { read } = await linkedProject(ALL_DONE, stateDir);
  const before = read();
  const elsewhere = await tempDir('deliver-elsewhere-');
  for (const input of [{ session_id: SESSION, cwd: elsewhere }, { session_id: SESSION }]) {
    const outcome = deliverAtStop(input, { stateDir, now: NOW, projectDir: elsewhere });
    assert.equal(outcome.code, 0, JSON.stringify(input));
    assert.match(outcome.message, /outside/);
  }
  assert.equal(read(), before);
  const { run, project } = await runHook(JSON.stringify({ session_id: SESSION, cwd: elsewhere }), (dir) => linkedProject(ALL_DONE, dir));
  assert.deepEqual([run.status, run.stdout, run.stderr], [0, '', '']);
  assert.doesNotMatch(project.read(), /deliver:/);
});

test('a linked STATUS.md in a subfolder of the cwd, under the project dir, or under a cwd reached through a link gets its row', async () => {
  const cases = [
    ['parent cwd', (cwd) => ({ input: { cwd: dirname(cwd) } })],
    ['project dir', (cwd, other) => ({ input: { cwd: other }, projectDir: cwd })],
    ['cwd through a link', (cwd, other) => {
      symlinkSync(cwd, join(other, 'linked'));
      return { input: { cwd: join(other, 'linked') } };
    }],
  ];
  for (const [name, setup] of cases) {
    const stateDir = await tempDir('deliver-state-');
    const { cwd, read } = await linkedProject(ALL_DONE, stateDir);
    const { input, projectDir } = setup(cwd, await tempDir('deliver-other-'));
    const outcome = deliverAtStop({ session_id: SESSION, ...input }, { stateDir, now: NOW, projectDir });
    assert.equal(outcome.code, 0, name);
    assert.match(read(), DELIVER_ROW, name);
  }
});

test('a cwd whose path is only a name prefix of the STATUS.md folder does not count as holding it', async () => {
  const stateDir = await tempDir('deliver-state-');
  const { cwd, read } = await linkedProject(ALL_DONE, stateDir);
  const prefix = cwd.slice(0, -2); // `/tmp/deliver-project-ab` for `/tmp/deliver-project-abcd`: a sibling folder, not a parent
  mkdirSync(prefix);
  const outcome = deliverAtStop({ session_id: SESSION, cwd: prefix }, { stateDir, now: NOW });
  assert.match(outcome.message, /outside/);
  assert.doesNotMatch(read(), /deliver:/);
});

// The documented rule (status-deliver.mjs header): the hand-over goes to the STATUS.md the session last edited with status.mjs when
// it is inside the cwd. A cwd above two projects holds both, so the earlier project's table gets nothing (the audit's S1 residual).
test('the hand-over goes to the STATUS.md last edited with status.mjs, also when the cwd holds an earlier edited project', async () => {
  const stateDir = await tempDir('deliver-state-');
  const first = await linkedProject(ALL_DONE, stateDir);
  const last = await linkedProject(ALL_DONE, stateDir);
  const outcome = deliverAtStop({ session_id: SESSION, cwd: dirname(first.cwd) }, { stateDir, now: NOW });
  assert.equal(outcome.code, 0, outcome.message);
  assert.match(last.read(), DELIVER_ROW);
  assert.doesNotMatch(first.read(), /deliver:/);
});
