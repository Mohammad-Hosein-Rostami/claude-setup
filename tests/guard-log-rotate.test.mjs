// Tests for the guard log's size bound (home/hooks/lib/guard-log.mjs): a log of 5 MB or more moves to guard.1.jsonl and a new empty log
// takes its place, a second rotation replaces guard.1.jsonl, writers racing on a full log rotate it once and lose no line, a reader that
// follows guard.jsonl keeps reading, a killed rotation's temp names are cleaned up and a link planted at guard.1.jsonl is never followed.
// Every log lives in a cs-test-* temp folder (CLAUDE_GUARD_LOG); the real ~/.claude/logs is never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GUARD_LOG_FILE, GUARD_LOG_MAX_BYTES, GUARD_ROTATE_LOCK_FILE, logDecision, rotatedLogPath } from '../home/hooks/lib/guard-log.mjs';
import { checkGuardStateWrite } from '../home/hooks/lib/guard-state-write.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { cleanEnv } from './clean-env.mjs';

const posix = { skip: process.platform === 'win32' && 'needs symlinks and file modes' };
const GUARD_LOG = new URL('../home/hooks/lib/guard-log.mjs', import.meta.url).href;
const RACERS = 8;
const OWNER_ONLY = 0o600;
const record = (command) => ({ hook: 'pre-bash-guard', tool: 'Bash', decision: 'ask', outcome: 'allow', reason: 'test', command });
const linesOf = (path) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((line) => line !== '') : []);

/** A log folder in a temp HOME and the env that points the guard log there. */
function logIn() {
  const home = makeTempDir('guard-log-rotate-');
  const path = join(home, 'logs', 'guard.jsonl');
  return { home, path, env: { HOME: home, CLAUDE_GUARD_LOG: path } };
}

/** Fills the log with whole JSON lines tagged `mark` until it holds at least `bytes`; returns how many lines it wrote. */
function fill(path, mark, bytes = GUARD_LOG_MAX_BYTES) {
  const line = `${JSON.stringify({ mark, pad: 'x'.repeat(100) })}\n`;
  const count = Math.ceil(bytes / Buffer.byteLength(line));
  writeFileSync(path, line.repeat(count), { mode: OWNER_ONLY });
  return count;
}

test('rotatedLogPath: guard.jsonl -> guard.1.jsonl; another name gets .1', () => {
  assert.equal(rotatedLogPath('/x/logs/guard.jsonl'), '/x/logs/guard.1.jsonl');
  assert.equal(rotatedLogPath('/x/decisions.log'), '/x/decisions.log.1');
});

test('a log under 5 MB is not rotated', () => {
  const { path, env } = logIn();
  logDecision(record('first'), env);
  fill(path, 'small', GUARD_LOG_MAX_BYTES - 1024);
  logDecision(record('second'), env);
  assert.equal(existsSync(rotatedLogPath(path)), false);
  assert.equal(JSON.parse(linesOf(path).at(-1)).command, 'second');
});

test('a full log moves to guard.1.jsonl with the line just written; the next line goes to a new 0600 guard.jsonl; a second rotation replaces guard.1.jsonl', posix, () => {
  const { path, env } = logIn();
  logDecision(record('make the folder'), env);
  const firstCount = fill(path, 'A');
  logDecision(record('the line that filled it'), env);
  const rotated = rotatedLogPath(path);
  assert.equal(linesOf(rotated).length, firstCount + 1);
  assert.equal(JSON.parse(linesOf(rotated).at(-1)).command, 'the line that filled it');
  assert.deepEqual([statSync(path).size, statSync(path).mode & 0o777], [0, OWNER_ONLY]);
  logDecision(record('after'), env);
  assert.deepEqual(linesOf(path).map((line) => JSON.parse(line).command), ['after']);
  fill(path, 'B');
  logDecision(record('second rotation'), env);
  assert.equal(JSON.parse(linesOf(rotated)[0]).mark, 'B', 'guard.1.jsonl now holds the second full log; one old file is kept');
  assert.equal(linesOf(rotated).some((line) => line.includes('"mark":"A"')), false);
  assert.equal(existsSync(join(path, '..', '.guard.rotate-lock')), false, 'the rotation lock is released');
});

test(`${RACERS} writers on a full log at once: rotated once, no line lost`, posix, async () => {
  const { path, env } = logIn();
  logDecision(record('make the folder'), env);
  const filled = fill(path, 'A'); // fill writes the whole file: the folder-making line is gone
  const script = `const { logDecision } = await import(${JSON.stringify(GUARD_LOG)}); logDecision({ hook: 'h', tool: 'Bash', decision: 'ask', outcome: 'allow', reason: 'r', command: process.argv[1] });`;
  const writer = (n) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, `racer-${n}`], { env: cleanEnv(env), stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', resolve);
  });
  assert.deepEqual(await Promise.all(Array.from({ length: RACERS }, (_, n) => writer(n))), Array(RACERS).fill(0));
  const rotated = linesOf(rotatedLogPath(path));
  const all = [...rotated, ...linesOf(path)];
  assert.equal(JSON.parse(rotated[0]).mark, 'A', 'the full log was rotated once: a second rotation would have replaced it with a small one');
  assert.equal(all.length, filled + RACERS);
  for (let n = 0; n < RACERS; n += 1) assert.equal(all.filter((line) => line.includes(`"racer-${n}"`)).length, 1, `racer-${n}`);
});

test('a reader that follows guard.jsonl (tail -F) keeps reading after the rotation: the path never goes missing, the new file holds only new lines', posix, () => {
  const { path, env } = logIn();
  logDecision(record('make the folder'), env);
  fill(path, 'A');
  const before = statSync(path).ino;
  logDecision(record('rotates'), env);
  assert.ok(existsSync(path), 'guard.jsonl exists right after the rotation');
  assert.notEqual(statSync(path).ino, before, 'a new file, so a follower reads it from its start');
  logDecision(record('after the rotation'), env);
  const commands = readFileSync(path, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line).command);
  assert.equal(commands.at(-1), 'after the rotation');
  assert.ok(!commands.includes('make the folder'), 'the old lines are in guard.1.jsonl, not in the new file');
});

test('crash case: temp names a killed rotation left are removed by the next one; a link planted at guard.1.jsonl is replaced, never followed', posix, () => {
  const { home, path, env } = logIn();
  logDecision(record('make the folder'), env);
  const rotated = rotatedLogPath(path);
  writeFileSync(`${rotated}.part`, 'left by a killed rotation');
  writeFileSync(`${path}.new`, 'left by a killed rotation');
  const target = join(home, 'outside.txt');
  writeFileSync(target, 'not the log');
  symlinkSync(target, rotated);
  fill(path, 'A');
  logDecision(record('rotates'), env);
  assert.equal(lstatSync(rotated).isFile(), true, 'guard.1.jsonl is the old log, not the link');
  assert.equal(readFileSync(target, 'utf8'), 'not the log');
  assert.deepEqual([existsSync(`${rotated}.part`), existsSync(`${path}.new`), statSync(path).size], [false, false, 0]);
});

test('a Bash write to the rotated log or the rotation lock asks, like one to guard.jsonl (guard-state-write.mjs)', () => {
  const logs = join(GUARD_LOG_FILE, '..');
  for (const name of ['guard.jsonl', 'guard.1.jsonl', GUARD_ROTATE_LOCK_FILE]) {
    assert.notEqual(checkGuardStateWrite('rm', ['rm', join(logs, name)], '/'), undefined, name);
  }
});
