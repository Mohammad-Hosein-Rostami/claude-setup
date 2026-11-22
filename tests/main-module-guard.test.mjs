// Tests for the "run as a script" check at the bottom of the CLI and hook files: it must still be true when the file is reached through a
// symlink. The owner's ~/.claude is a symlink to this repo's home/, so a check without realpathSync made git-tidy, the checkpoint and
// recall-digest hooks and the reranker watchdog silently do nothing (exit 0, no output).
// Exports: none (node:test file). Every run uses a temp dir for the symlink and for any state; nothing touches the real ~/.claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../home/tools/recall/lib/store.mjs';
import { lockHeld, readCheckpoint } from '../home/tools/recall/lib/checkpoint-state.mjs';
import { bigTranscript, fakeStack } from './recall-fakes.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
// process.argv[1] handed to pathToFileURL or compared with ==, ===, != or !==, with no realpathSync around it. Fine: a bare
// `process.argv[1] &&` truthiness test, and a presence test against undefined or null (`process.argv[1] !== undefined`), since neither
// compares the path. The (?<![!=]) and (?!=) keep a partial operator match (`!=` out of `!==`) from slipping past the undefined/null check.
const UNRESOLVED_ARGV = /pathToFileURL\(\s*process\.argv\[1\]|(?<!\b(?:undefined|null)\s*)(?<![!=])[!=]==?\s*process\.argv\[1\]|process\.argv\[1\]\s*[!=]==?(?!=)(?!\s*(?:undefined|null)\b)/;
// The module's own location: as a URL, or as a native path (import.meta.filename, a C:\ drive path on Windows).
const OWN_LOCATION = /import\.meta\.(?:url|filename|dirname)\b/;

/** True when a file that reads its own location also uses process.argv[1] without realpathSync, in either operand order. */
function hasUnresolvedMainCheck(source) {
  return OWN_LOCATION.test(source) && UNRESOLVED_ARGV.test(source);
}
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
  const dir = realpathSync(makeTempDir('main-guard-'));
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
  const offenders = [...scriptFiles('home'), ...scriptFiles('scripts')].filter((file) => hasUnresolvedMainCheck(readFileSync(join(REPO, file), 'utf8')));
  assert.deepEqual(offenders, [], 'wrap process.argv[1] in realpathSync, as home/tools/status/status.mjs does');
});

test('the scan flags every spelling of the unresolved check and passes the resolved one', () => {
  const flagged = [
    'if (import.meta.url === pathToFileURL(process.argv[1]).href) main();',
    'if (pathToFileURL(process.argv[1]).href === import.meta.url) main();',
    'if (fileURLToPath(import.meta.url) === process.argv[1]) main();',
    'if (import.meta.filename === process.argv[1]) main();',
    'if (process.argv[1] == fileURLToPath(import.meta.url)) main();',
    // a presence test first never hides the unresolved compare after it
    'if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();',
    'if (undefined !== process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();',
    'if (process.argv[1] != null && process.argv[1] === import.meta.filename) main();',
  ];
  for (const source of flagged) assert.equal(hasUnresolvedMainCheck(source), true, source);
  const resolved = [
    'if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();',
    'if (process.argv[1] && import.meta.filename === realpathSync(process.argv[1])) main();',
    'const isMain = process.argv[1] !== undefined && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));',
    'const isMain = null != process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));',
  ];
  for (const source of resolved) assert.equal(hasUnresolvedMainCheck(source), false, source);
});

test('done-check.mjs with its realpathSync taken off the argv[1] side is reported; the real file is not', () => {
  const source = readFileSync(join(REPO, 'home', 'tools', 'done-check', 'done-check.mjs'), 'utf8');
  const resolvedArgv = 'realpathSync(process.argv[1]) ===';
  assert.ok(source.includes(resolvedArgv), 'the fixture still holds the resolved compare');
  assert.equal(hasUnresolvedMainCheck(source), false);
  assert.equal(hasUnresolvedMainCheck(source.replace(resolvedArgv, 'process.argv[1] ===')), true);
});

test('git-tidy reached through a symlink to home/ still runs: an unknown command exits 2', () => {
  const link = linkTo('home', 'claude');
  const result = spawnSync(process.execPath, [join(link, 'tools', 'git-tidy', 'git-tidy.mjs'), 'bogus'], { encoding: 'utf8' });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /git-tidy: usage/);
});

test('done-check reached through a symlink to home/ still runs: an unknown command exits 2', () => {
  const link = linkTo('home', 'claude');
  const home = realpathSync(makeTempDir('done-check-home-')); // never the real ~/.claude
  const result = spawnSync(process.execPath, [join(link, 'tools', 'done-check', 'done-check.mjs'), 'bogus'], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /usage: done-check/);
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
  const dir = realpathSync(makeTempDir('rerank-watch-'));
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
