// The board's `show` command (home/tools/board/lib/show.mjs showLines, home/tools/board/board.mjs `show`): the board file as plain
// lines. Unit: the head line (write time, fresh or stale N s), one line per agent in the board's order with its state text, control
// characters gone from every line, only the head line with no agent, `-` for an empty field. Integration: the command in a child
// process under a temp HOME, with no board file (exit 1 and the refresh command, no stack trace) and with one at the path the
// readers use (exit 0 and the lines).
// Every HOME is a temp `cs-test-*` folder; the child gets cleanEnv, so a session's CLAUDE_* switches never reach it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { showLines } from '../home/tools/board/lib/show.mjs';
import { cleanEnv } from './clean-env.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const BOARD_CLI = fileURLToPath(new URL('../home/tools/board/board.mjs', import.meta.url));
const SESSION = '11111111-2222-4333-8444-555555555555';
const WRITTEN_AT_MS = 1_700_000_000_000;
const WRITTEN_AT_ISO = '2023-11-14T22:13:20.000Z'; // written out, not computed, so the test does not repeat the code's own conversion
const NOW_MS = WRITTEN_AT_MS + 5_000;
const STALE_SINCE_MS = NOW_MS - 42_500; // 42.5 s old: the line counts whole seconds
const STALE_SECONDS = 42;
const QUIET_MINUTES = 7;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const CHILD_TIMEOUT_MS = 30_000;
const EXIT_NO_BOARD = 1;

const agent = (fields) => ({
  id: 'a1', type: 'dev', state: 'run', quietMin: 0, branch: 'lane/x', wt: '/work/x', doing: 'Edit a.mjs', ...fields,
});
const board = (fields = {}) => ({ session: SESSION, at: WRITTEN_AT_MS, stale: null, agents: [], ...fields });

test('show lists a head line with the write time and fresh, then one line per agent in the board order with running, quiet N min or done', () => {
  const lines = showLines(board({
    agents: [
      agent({ id: 'zq', type: 'tess', state: 'quiet', quietMin: QUIET_MINUTES, branch: 'lane/q', wt: '/work/q', doing: 'Read b.mjs' }),
      agent({ id: 'ad', type: 'lex', state: 'done', branch: 'lane/d', wt: '/work/d', doing: 'Write plan' }),
      agent({ id: 'mr', type: 'dev', state: 'run', branch: 'lane/r', wt: '/work/r', doing: 'Edit c.mjs' }),
    ],
  }), NOW_MS);
  assert.deepEqual(lines, [
    `board ${SESSION} at ${WRITTEN_AT_ISO} fresh`,
    'agent zq tess quiet 7 min branch lane/q folder /work/q Read b.mjs',
    'agent ad lex done branch lane/d folder /work/d Write plan',
    'agent mr dev running branch lane/r folder /work/r Edit c.mjs',
  ]);
});

test('show marks a stale board in the head line with the whole seconds since the old data was kept', () => {
  const [head] = showLines(board({ stale: { sinceMs: STALE_SINCE_MS } }), NOW_MS);
  assert.equal(head, `board ${SESSION} at ${WRITTEN_AT_ISO} stale ${STALE_SECONDS} s`);
});

test('show leaves no control character in any line, whichever field of the board holds one', () => {
  const dirty = (word) => `${word}\u001b[31m\r\u0007${word}`;
  const lines = showLines(board({
    session: dirty('sess'),
    agents: [agent({ id: dirty('id'), type: dirty('type'), branch: dirty('br'), wt: dirty('wt'), doing: dirty('doing') })],
  }), NOW_MS);
  assert.equal(lines.length, 2);
  for (const line of lines) assert.doesNotMatch(line, CONTROL_CHARS, JSON.stringify(line));
  assert.ok(lines[1].endsWith('doing [31m  doing'), `the text around the control characters stays: ${lines[1]}`);
});

test('show prints only the head line for a board with no agent', () => {
  assert.deepEqual(showLines(board({ agents: [] }), NOW_MS), [`board ${SESSION} at ${WRITTEN_AT_ISO} fresh`]);
});

test('show prints - for an empty or missing branch, folder and doing text, so every line keeps its fields', () => {
  const lines = showLines(board({
    agents: [
      agent({ id: 'e1', branch: '', wt: '', doing: '' }),
      agent({ id: 'e2', branch: null, wt: null, doing: null }),
    ],
  }), NOW_MS);
  assert.deepEqual(lines.slice(1), [
    'agent e1 dev running branch - folder - -',
    'agent e2 dev running branch - folder - -',
  ]);
});

/** Runs `board.mjs show` as a child with a temp HOME, the session by flag (cleanEnv holds no CLAUDE_CODE_SESSION_ID). */
function runShow(home) {
  const env = cleanEnv({ HOME: home, USERPROFILE: home, TMPDIR: home, TEMP: home, TMP: home });
  return spawnSync(process.execPath, [BOARD_CLI, 'show', '--session', SESSION], { env, encoding: 'utf8', timeout: CHILD_TIMEOUT_MS });
}

test('show with no board file exits 1, prints nothing to stdout and names the refresh command on stderr, never a stack trace', () => {
  const home = makeTempDir('board-show-none-');
  const run = runShow(home);
  assert.equal(run.status, EXIT_NO_BOARD, run.stderr);
  assert.equal(run.stdout, '');
  assert.ok(run.stderr.includes(`no board file for session ${SESSION}`), run.stderr);
  assert.ok(run.stderr.includes(`refresh --session ${SESSION} --force`), run.stderr);
  assert.doesNotMatch(run.stderr, /^\s+at .+:\d+/m, 'no stack frame');
  assert.doesNotMatch(run.stderr, /Error/, 'no thrown error');
});

test('show reads the board file under HOME/.claude/state/board and prints its head line and agent lines with exit 0', () => {
  const home = makeTempDir('board-show-file-');
  const dir = join(home, '.claude', 'state', 'board');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const saved = board({ agents: [agent({ id: 'w1', type: 'dev', state: 'done', branch: 'lane/w', wt: '/work/w', doing: 'Write t.mjs' })] });
  writeFileSync(join(dir, `${SESSION}.json`), JSON.stringify(saved), { mode: 0o600 });
  const run = runShow(home);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  assert.deepEqual(run.stdout.split('\n').filter(Boolean), [
    `board ${SESSION} at ${WRITTEN_AT_ISO} fresh`,
    'agent w1 dev done branch lane/w folder /work/w Write t.mjs',
  ]);
});
