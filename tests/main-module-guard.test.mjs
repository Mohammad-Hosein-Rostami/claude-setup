// Tests for the "run as a script" check at the bottom of the CLI and hook files: it must still be true when the file is reached through a
// symlink. The owner's ~/.claude is a symlink to this repo's home/, so a check without realpathSync made test-pass, the checkpoint and
// recall-digest hooks, the reranker watchdog and affected-tests silently do nothing (exit 0, no output).
// Exports: none (node:test file). Every run uses a temp dir for the symlink and for any state; nothing touches the real ~/.claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../home/tools/recall/lib/store.mjs';
import { lockHeld, readCheckpoint } from '../home/tools/recall/lib/checkpoint-state.mjs';
import { bigTranscript, fakeStack } from './recall-fakes.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const UNGUARDED = /import\.meta\.url\s*===\s*pathToFileURL\(\s*process\.argv\[1\]\s*\)/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every .mjs/.js file under `folder` (relative to the repo), skipping node_modules. */
function scriptFiles(folder) {
  return readdirSync(join(REPO, folder), { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : scriptFiles(path);
    return /\.(mjs|js)$/.test(entry.name) ? [path] : [];
  });
}

/** A temp dir holding `<name> -> <repo>/<target>`; returns the symlink path. */
function linkTo(target, name) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'main-guard-')));
  const link = join(dir, name);
  symlinkSync(join(REPO, target), link);
  return link;
}

/** Run a script with JSON on stdin without blocking this process; resolves {status, stdout, stderr}. */
function runWithInput(script, input, env) {
  const child = spawn(process.execPath, [script], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify(input));
  return new Promise((resolve) => child.once('exit', (status) => resolve({ status, stdout, stderr })));
}

async function waitFor(check, ms = 20000) {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(50)) if (check()) return true;
  return false;
}

test('no script under home/ or scripts/ compares import.meta.url with an unresolved process.argv[1]', () => {
  const offenders = [...scriptFiles('home'), ...scriptFiles('scripts')].filter((file) => UNGUARDED.test(readFileSync(join(REPO, file), 'utf8')));
  assert.deepEqual(offenders, [], 'wrap process.argv[1] in realpathSync, as home/tools/status/status.mjs does');
});

test('test-pass reached through a symlink to home/ still runs: an unknown command exits 2', () => {
  const link = linkTo('home', 'claude');
  const result = spawnSync(process.execPath, [join(link, 'tools', 'test-pass', 'test-pass.mjs'), 'bogus'], { encoding: 'utf8' });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /test-pass:/);
});

test('affected-tests reached through a symlink to scripts/ lists the tests of a changed file', () => {
  const link = linkTo('scripts', 'tools');
  const result = spawnSync(process.execPath, [join(link, 'affected-tests.mjs'), 'home/tools/test-pass/test-pass.mjs', '--list'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /tests\/test-pass\.test\.mjs/);
});

test('the checkpoint hook reached through a symlink starts its job exactly like the real path', async () => {
  const link = linkTo('home', 'claude');
  const outcomes = [];
  for (const hook of [join(REPO, 'home', 'hooks', 'checkpoint.mjs'), join(link, 'hooks', 'checkpoint.mjs')]) {
    const stack = fakeStack();
    const { path, session } = bigTranscript(stack.dir, { count: 40 });
    const result = await runWithInput(hook, { hook_event_name: 'PostToolUse', session_id: session, transcript_path: path }, stack.env);
    const finished = await waitFor(() => readCheckpoint(session, stack.env) && !lockHeld(session, stack.env));
    outcomes.push({ status: result.status, stdout: result.stdout, finished, calls: stack.claudeCalls().length >= 1, notes: readCheckpoint(session, stack.env)?.notes > 0 });
  }
  assert.deepEqual(outcomes[0], { status: 0, stdout: '', finished: true, calls: true, notes: true }, 'the real path works (fixture sanity)');
  assert.deepEqual(outcomes[1], outcomes[0], 'the symlink path gives the same result');
});

test('the recall-digest hook reached through a symlink prints the same digest as the real path', async () => {
  const link = linkTo('home', 'claude');
  const session = 'cccccccc-9999-2222-3333-444444444444';
  const { env, dbPath } = fakeStack();
  const store = openStore(dbPath);
  store.addChunk({ project: '-p', session, source: `note:${session}`, kind: 'note', line: 3, ts: null, role: 'L1-3', text: '[note:facts] port 8012' });
  store.close();
  const input = { source: 'compact', session_id: session };
  const real = await runWithInput(join(REPO, 'home', 'hooks', 'recall-digest.mjs'), input, env);
  const linked = await runWithInput(join(link, 'hooks', 'recall-digest.mjs'), input, env);
  assert.match(real.stdout, /port 8012/, 'the real path prints the digest (fixture sanity)');
  assert.deepEqual(linked, real);
});

test('the reranker watchdog reached through a symlink acts on its state file like the real path', async () => {
  const link = linkTo('home', 'claude');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rerank-watch-')));
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); // not a llama-server: must never be signalled
  try {
    const statePath = join(dir, 'reranker.json');
    writeFileSync(statePath, JSON.stringify({ pid: bystander.pid, port: 1, startedAt: 0, lastUsed: Date.now() }));
    const watchdog = join(link, 'tools', 'recall', 'lib', 'rerank-watch.mjs');
    const result = spawnSync(process.execPath, [watchdog, statePath, String(bystander.pid)], { encoding: 'utf8', env: { ...process.env, RECALL_RERANK_IDLE_MS: '200' }, timeout: 20000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(statePath), false, 'a state file naming a process that is not a llama-server is removed');
    assert.equal(bystander.exitCode, null, 'and that process is left alone');
  } finally {
    bystander.kill();
  }
});
