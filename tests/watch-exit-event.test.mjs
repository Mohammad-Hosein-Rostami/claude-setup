// Tests for `--exit-on-event [classes]` of home/tools/watch/watch.mjs: argument parsing, and the real CLI printing the first
// matching action line and exiting (0, or 1 for a WATCH_ERROR). Synthetic transcripts only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, UsageError } from '../home/tools/watch/lib/args.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const CLI = fileURLToPath(new URL('../home/tools/watch/watch.mjs', import.meta.url));
const SESSION = 'dddddddd-1111-2222-3333-444444444444';
const STAMP = '2026-11-14T10:00:00.000Z';
const entry = (value) => `${JSON.stringify({ timestamp: STAMP, ...value })}\n`;
const owner = (text) => entry({ type: 'user', message: { content: text } });
const compact = entry({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 9, postTokens: 1 } });
const apiError = (error = 'server_error') => entry({ type: 'assistant', isApiErrorMessage: true, error, message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: boom' }] } });

async function sandbox(t, transcript) {
  const home = makeTempDir('watch-exit-');
  t.after(() => rm(home, { recursive: true, force: true }));
  const project = join(home, '.claude', 'projects', '-proj');
  await mkdir(project, { recursive: true });
  const path = join(project, `${SESSION}.jsonl`);
  await writeFile(path, transcript);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const guardLog = join(home, 'none.jsonl');
  const run = (args) => spawnSync(process.execPath, [CLI, SESSION, '--guard-log', guardLog, ...args], { encoding: 'utf8', env });
  return { home, path, env, guardLog, run };
}

test('parseArgs: --exit-on-event with and without classes, and every unusable form', () => {
  const defaults = ['owner', 'error', 'limit', 'api-error', 'guard', 'stall', 'watch-error', 'session-end'];
  assert.deepEqual(parseArgs(['abcdef']).exitOnEvent, undefined);
  assert.deepEqual(parseArgs(['abcdef', '--exit-on-event']).exitOnEvent, defaults);
  assert.deepEqual(parseArgs(['--exit-on-event', '--once', 'abcdef']).exitOnEvent, defaults);
  assert.deepEqual(parseArgs(['abcdef', '--exit-on-event', 'api-error,stall,limit']).exitOnEvent, ['api-error', 'stall', 'limit']);
  assert.deepEqual(parseArgs(['abcdef', '--exit-on-event', 'compact']).exitOnEvent, ['compact']);
  assert.deepEqual(parseArgs(['--exit-on-event', 'abcdef1-2345-6789']).targets, ['abcdef1-2345-6789']);
  for (const bad of ['bogus', 'owner,bogus', 'owner,,stall']) {
    assert.throws(() => parseArgs(['abcdef', '--exit-on-event', bad]), UsageError, bad);
  }
});

test('--exit-on-event: the first default-class event is printed alone and the exit code is 0', async (t) => {
  const { run } = await sandbox(t, compact + owner('please ship it') + apiError());
  const result = run(['--once', '--exit-on-event']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'dddddddd: OWNER please ship it\n');
});

test('--exit-on-event: compact is opt-in, and only the requested classes wake', async (t) => {
  const { run } = await sandbox(t, compact + owner('hello') + apiError());
  assert.equal(run(['--once', '--exit-on-event']).stdout, 'dddddddd: OWNER hello\n');
  assert.equal(run(['--once', '--exit-on-event', 'compact']).stdout, `dddddddd: ${STAMP} COMPACT auto 9->1\n`);
  assert.equal(run(['--once', '--exit-on-event', 'api-error']).stdout, `dddddddd: ${STAMP} API_ERROR server_error\n`);
});

test('--exit-on-event: a transcript with an API error as its last line and no final newline is reported', async (t) => {
  const { run } = await sandbox(t, owner('start') + apiError().trimEnd());
  const result = run(['--once', '--exit-on-event', 'api-error']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `dddddddd: ${STAMP} API_ERROR server_error\n`);
});

test('--exit-on-event: a rate_limit error wakes on the limit class', async (t) => {
  const { run } = await sandbox(t, apiError('rate_limit'));
  assert.equal(run(['--once', '--exit-on-event', 'limit']).stdout, `dddddddd: ${STAMP} LIMIT rate_limit\n`);
  assert.equal(run(['--once', '--exit-on-event', 'api-error']).stdout, '');
});

test('--exit-on-event with nothing to report in --once prints nothing and exits 0', async (t) => {
  const { run } = await sandbox(t, entry({ type: 'assistant', message: { model: 'm', content: [] } }));
  const result = run(['--once', '--exit-on-event']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('an unknown class is a usage error: exit 2, nothing on stdout, the class named on stderr', async (t) => {
  const { run } = await sandbox(t, owner('hi'));
  const result = run(['--once', '--exit-on-event', 'bogus']);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /bogus/);
});

test('follow mode: a quiet transcript keeps running, then the first matching event exits 0 and prints only that line', async (t) => {
  const { path, env, guardLog } = await sandbox(t, '');
  const child = spawn(process.execPath, [CLI, SESSION, '--guard-log', guardLog, '--exit-on-event', 'api-error'], { env });
  t.after(() => child.kill());
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  const closed = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  const deadline = Date.now() + 15_000;
  // Routine events and a non-listed class first (they must not wake), then keep appending the API error until the watcher has anchored.
  while (child.exitCode === null && Date.now() < deadline) {
    await appendFile(path, owner('chatter') + apiError());
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert.equal(await closed, 0);
  assert.equal(output, `dddddddd: ${STAMP} API_ERROR server_error\n`);
});

test('exiting on a WATCH_ERROR uses a non-zero code (follow mode, a guard log path under a plain file)', async (t) => {
  const { path, env } = await sandbox(t, '');
  const result = spawnSync(process.execPath, [CLI, SESSION, '--guard-log', join(path, 'guard.jsonl'), '--exit-on-event'], { encoding: 'utf8', env, timeout: 15_000 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /^WATCH_ERROR guard cannot read /);
  assert.equal(result.stdout.trim().split('\n').length, 1);
});
