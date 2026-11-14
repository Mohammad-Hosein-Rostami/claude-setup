// Tests for home/tools/watch/watch.mjs: the real CLI with a temp HOME. Argument validation (exit 2), session-id resolution,
// `--once` output and exit code, the --log verbose file, guard lines for watched sessions only, and a follow-mode run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, UsageError } from '../home/tools/watch/lib/args.mjs';

const CLI = fileURLToPath(new URL('../home/tools/watch/watch.mjs', import.meta.url));
const SESSION = 'eeeeeeee-1111-2222-3333-444444444444';
const STAMP = '2026-11-14T10:00:00.000Z';
const entry = (value) => `${JSON.stringify({ timestamp: STAMP, ...value })}\n`;
const TRANSCRIPT = [
  entry({ type: 'user', message: { content: 'please ship it\nnow' } }),
  entry({ type: 'user', isCompactSummary: true, message: { content: 'This session is being continued from earlier' } }),
  entry({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 9000, postTokens: 1000 } }),
  entry({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'ERROR build failed' }] } }),
  entry({ type: 'user', message: { content: 'Stop hook feedback: continue' } }),
  entry({ type: 'assistant', message: { model: 'm', content: [{ type: 'tool_use', name: 'Bash', input: {} }], usage: { input_tokens: 1, output_tokens: 2 } } }),
].join('');

async function sandbox(t) {
  const home = await mkdtemp(join(tmpdir(), 'watch-cli-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const project = join(home, '.claude', 'projects', '-proj');
  await mkdir(project, { recursive: true });
  const transcript = join(project, `${SESSION}.jsonl`);
  await writeFile(transcript, TRANSCRIPT);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
  return { home, transcript, env, run };
}

test('parseArgs: defaults, flags, targets and rejections', () => {
  const parsed = parseArgs(['a1b2c3d4', 'x.jsonl', '--stall-min', '5', '--log', 'L', '--guard-log', 'G', '--once']);
  assert.deepEqual(parsed, { targets: ['a1b2c3d4', 'x.jsonl'], stallMin: 5, logDir: 'L', guardLog: 'G', once: true, help: false });
  assert.equal(parseArgs(['abcdef']).stallMin, 20);
  assert.deepEqual(parseArgs(['--', '--odd.jsonl']).targets, ['--odd.jsonl']);
  for (const bad of [[], ['abcdef', '--nope'], ['abcdef', '--stall-min'], ['abcdef', '--stall-min', '0'], ['abcdef', '--stall-min', 'x'], ['abcdef', '--log', ' ']]) {
    assert.throws(() => parseArgs(bad), UsageError, JSON.stringify(bad));
  }
});

test('--once prints each action line with the label, nothing for routine events, and exits 0', async (t) => {
  const { home, run } = await sandbox(t);
  const result = run([SESSION, '--once', '--guard-log', join(home, 'none.jsonl')]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    'eeeeeeee: OWNER please ship it now',
    `eeeeeeee: ${STAMP} COMPACT auto 9000->1000`,
    `eeeeeeee: ${STAMP} ERR ERROR build failed`,
    `eeeeeeee: ${STAMP} PROMPT Stop hook feedback: continue`,
  ]);
});

test('a transcript path works the same as a session id', async (t) => {
  const { home, run, transcript } = await sandbox(t);
  const result = run([transcript, '--once', '--guard-log', join(home, 'none.jsonl')]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^eeeeeeee: OWNER please ship it now$/m);
});

test('--log writes the full verbose stream to <label>.events.log', async (t) => {
  const { home, run } = await sandbox(t);
  const logDir = join(home, 'logs-out');
  const result = run([SESSION, '--once', '--log', logDir, '--guard-log', join(home, 'none.jsonl')]);
  assert.equal(result.status, 0, result.stderr);
  const log = await readFile(join(logDir, 'eeeeeeee.events.log'), 'utf8');
  assert.match(log, new RegExp(`${STAMP} TOOL Bash`));
  assert.match(log, new RegExp(`${STAMP} USAGE model=m ctx=1 create=null out=2`));
  assert.match(log, /PROMPT please ship it now/);
});

test('an unknown session id exits 2 and the error names the id', async (t) => {
  const { run } = await sandbox(t);
  const result = run(['ffffffff-0000-0000-0000-000000000000', '--once']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /ffffffff-0000-0000-0000-000000000000/);
  assert.equal(result.stdout, '');
});

test('a bad flag and a malformed id are rejected with exit 2', async (t) => {
  const { run } = await sandbox(t);
  assert.equal(run([SESSION, '--bogus']).status, 2);
  assert.equal(run(['bad id!', '--once']).status, 2);
});

test('--once prints guard events for the watched session only', async (t) => {
  const { home, run } = await sandbox(t);
  const guardLog = join(home, 'guard.jsonl');
  const record = (over) => `${JSON.stringify({ hook: 'pre-bash-guard', outcome: 'timeout', reason: 'DESTRUCTIVE: x', command: 'rm x', ...over })}\n`;
  await writeFile(guardLog, record({ session: SESSION }) + record({ session: 'other-session-id' }) + record({ session: SESSION, reason: 'the command contains a literal password/token (a key)' }));
  const lines = run([SESSION, '--once', '--guard-log', guardLog]).stdout.split('\n').filter((line) => line.includes('GUARD'));
  assert.deepEqual(lines, ['eeeeeeee: GUARD timeout pre-bash-guard: DESTRUCTIVE: x | rm x']);
});

test('follow mode prints only events written after start, as whole lines, and keeps running', async (t) => {
  const { home, transcript, env } = await sandbox(t);
  const child = spawn(process.execPath, [CLI, SESSION, '--guard-log', join(home, 'none.jsonl')], { env });
  t.after(() => child.kill());
  let output = '';
  let errors = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { errors += chunk; });
  // No fixed sleeps: keep appending numbered prompts (each in two halves, so a partial line is always in flight) until one
  // shows up; those written before the watcher anchored at the end of the file are legitimately skipped.
  const deadline = Date.now() + 15_000;
  for (let n = 0; !output.includes('OWNER fresh') && Date.now() < deadline; n += 1) {
    const line = entry({ type: 'user', message: { content: `fresh ${n}` } });
    await appendFile(transcript, line.slice(0, 20));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await appendFile(transcript, line.slice(20));
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  assert.match(output, /^eeeeeeee: OWNER fresh \d+\n/, `no event in 15 s; watcher exit=${child.exitCode} signal=${child.signalCode} stderr=${JSON.stringify(errors)}`);
  assert.ok(!output.includes('please ship it'), 'old content is not replayed');
  assert.ok(output.split('\n').every((row) => row === '' || /^eeeeeeee: OWNER fresh \d+$/.test(row)), 'only whole lines');
  assert.equal(child.exitCode, null);
});
