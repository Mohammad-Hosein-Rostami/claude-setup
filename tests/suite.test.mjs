// Tests for home/tools/suite: the machine-wide queue (slots in arrival order, stale holders reclaimed, SIGTERM kills the command's
// process group and frees the slot), the pass cache (only a clean tree and exit 0, `--fresh` re-runs) and `related`.
// Every case has its own state folder (CLAUDE_CONFIG_DIR) and its own throw-away repo or folder in the OS temp folder, so cases
// can run at any concurrency. The fake commands are small node scripts written into the case's temp folder.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { acquireSlot } from '../home/tools/suite/lib/queue.mjs';
import { CLEAN_ENV, commit, git } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const SUITE = fileURLToPath(new URL('../home/tools/suite/suite.mjs', import.meta.url));
const WAIT_LIMIT_MS = 20_000; // the longest a case waits for a file or a process; normal runs take well under a second
const POLL_MS = 20;
const SIGTERM_EXIT = 143; // 128 + 15

// Appends `start <name>`, waits until the log shows `start <peer>` or <maxWaitMs> passed, then appends `end <name>`.
const OVERLAP_FAKE = `import { appendFileSync, readFileSync } from 'node:fs';
const [log, name, peer, maxWaitMs] = process.argv.slice(2);
appendFileSync(log, 'start ' + name + '\\n');
const deadline = Date.now() + Number(maxWaitMs);
while (Date.now() < deadline && !readFileSync(log, 'utf8').includes('start ' + peer + '\\n')) await new Promise((r) => setTimeout(r, 20));
appendFileSync(log, 'end ' + name + '\\n');
`;
// Appends one line to <marker> (so a run that happened can be counted), then exits with <code>.
const MARKER_FAKE = `import { appendFileSync } from 'node:fs';
appendFileSync(process.argv[2], 'ran\\n');
process.exit(Number(process.argv[3]));
`;
// Starts a grandchild that runs forever, writes both pids to <pidFile>, then runs forever itself.
const GROUP_FAKE = `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(process.argv[2], JSON.stringify([process.pid, grandchild.pid]));
setInterval(() => {}, 1000);
`;

/** A fresh case: a state folder, a folder for fakes and logs, and the env that points the tool at the state folder. */
function makeCase() {
  const root = realpathSync(makeTempDir('suite-')); // real path: git-tidy-helpers' git() runs only under the real temp folder
  const configDir = join(root, 'config');
  const stateDir = join(configDir, 'state', 'suite');
  const work = join(root, 'work');
  mkdirSync(work);
  const fake = (name, text) => {
    const path = join(work, name);
    writeFileSync(path, text);
    return path;
  };
  return { root, stateDir, work, fake, env: { ...CLEAN_ENV, CLAUDE_CONFIG_DIR: configDir } };
}

/** Runs the CLI and waits for it; resolves to `{ status, stdout, stderr }`. */
function suite(args, { env, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SUITE, ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let [stdout, stderr] = ['', ''];
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/** Waits until `check()` returns a truthy value, polling every POLL_MS; fails the test after WAIT_LIMIT_MS. */
async function waitFor(check, what) {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  for (;;) {
    const value = check();
    if (value) return value;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await sleep(POLL_MS);
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

/** The pid of a process that has already exited. */
function deadPid() {
  return spawnSync(process.execPath, ['-e', '0']).pid;
}

/** Two `suite run`s started together with the overlap fake; returns the log's lines in the order they were written. */
async function twoRuns(slots, maxWaitMs) {
  const { work, fake, env } = makeCase();
  const script = fake('overlap.mjs', OVERLAP_FAKE);
  const log = join(work, 'order.log');
  writeFileSync(log, '');
  const run = (name, peer) => suite(['run', '--repo', work, '--slots', String(slots), '--', process.execPath, script, log, name, peer, String(maxWaitMs)], { env, cwd: work });
  const results = await Promise.all([run('a', 'b'), run('b', 'a')]);
  for (const result of results) assert.equal(result.status, 0, result.stdout + result.stderr);
  return readFileSync(log, 'utf8').trim().split('\n');
}

test('with --slots 1 the second run starts only after the first ended', async () => {
  const lines = await twoRuns(1, 300);
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^start /);
  assert.equal(lines[1], lines[0].replace('start', 'end'), `the first run ends before the second starts: ${lines.join(', ')}`);
});

test('with --slots 2 the two runs overlap', async () => {
  const lines = await twoRuns(2, WAIT_LIMIT_MS);
  assert.deepEqual(lines.slice(0, 2).map((line) => line.split(' ')[0]), ['start', 'start'], `both start before either ends: ${lines.join(', ')}`);
});

/**
 * True when acquireSlot takes slot 0 at its first check (it checks at once, then every 2 s). When it does not, the slots are
 * cleared so the waiter gets one at its next check and the case leaves no waiter behind.
 */
async function takesSlotAtFirstCheck(stateDir) {
  const pending = acquireSlot({ stateDir, slots: 1, label: { repo: 'r', command: 'c' } });
  const slot = await Promise.race([pending, sleep(1500).then(() => null)]);
  if (slot === null) rmSync(join(stateDir, 'slots'), { recursive: true, force: true });
  (await pending).release();
  return slot !== null;
}

/** Writes slots/0/holder.json as another run would. */
function plantHolder(stateDir, holder) {
  mkdirSync(join(stateDir, 'slots', '0'), { recursive: true });
  writeFileSync(join(stateDir, 'slots', '0', 'holder.json'), JSON.stringify({ token: 'other', ...holder }));
}

test('a holder whose pid is gone is reclaimed at the first check, and release frees the slot', async () => {
  const { stateDir } = makeCase();
  plantHolder(stateDir, { pid: deadPid(), startedAt: new Date().toISOString() });
  assert.equal(await takesSlotAtFirstCheck(stateDir), true);
  assert.equal(existsSync(join(stateDir, 'slots', '0')), false, 'release removes the slot folder');
});

test('a live holder keeps its slot until it is older than 2 h 10 min', async () => {
  const { stateDir } = makeCase();
  plantHolder(stateDir, { pid: process.pid, startedAt: new Date().toISOString() });
  assert.equal(await takesSlotAtFirstCheck(stateDir), false, 'a live, fresh holder keeps its slot');
  plantHolder(stateDir, { pid: process.pid, startedAt: new Date(Date.now() - (2 * 60 + 11) * 60 * 1000).toISOString() });
  assert.equal(await takesSlotAtFirstCheck(stateDir), true, 'a holder past 2 h 10 min is reclaimed');
});

test('a ticket ahead whose pid is gone does not block the queue', async () => {
  const { stateDir } = makeCase();
  mkdirSync(join(stateDir, 'tickets'), { recursive: true });
  writeFileSync(join(stateDir, 'tickets', `1-${deadPid()}`), '{}');
  assert.equal(await takesSlotAtFirstCheck(stateDir), true);
});

test('SIGTERM to suite run kills the command and its children and frees the slot', { skip: process.platform === 'win32' && 'no POSIX signals or process groups on Windows' }, async () => {
  const { work, fake, env, stateDir } = makeCase();
  const script = fake('group.mjs', GROUP_FAKE);
  const pidFile = join(work, 'pids.json');
  const child = spawn(process.execPath, [SUITE, 'run', '--repo', work, '--slots', '1', '--', process.execPath, script, pidFile], { env, stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const pids = await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8'), 'the fake to write its pids').then(JSON.parse);
  assert.ok(existsSync(join(stateDir, 'slots', '0', 'holder.json')), 'the run holds slot 0');
  child.kill('SIGTERM');
  assert.equal(await exited, SIGTERM_EXIT);
  await waitFor(() => pids.every((pid) => !isAlive(pid)), 'the command and its grandchild to be gone');
  assert.equal(existsSync(join(stateDir, 'slots', '0')), false, 'the slot is free');
});

/** A git repo (in a folder whose name has a space) with one commit, and a marker fake outside it. */
function cacheCase() {
  const testCase = makeCase();
  const repo = join(testCase.root, 'my repo');
  git(testCase.root, 'init', '-q', '-b', 'main', repo);
  git(repo, 'config', 'commit.gpgsign', 'false');
  commit(repo, 'a.txt');
  const script = testCase.fake('marker.mjs', MARKER_FAKE);
  const marker = join(testCase.work, 'marker');
  const run = (code, ...flags) => suite(['run', '--repo', repo, ...flags, '--', process.execPath, script, marker, String(code)], { env: testCase.env, cwd: repo });
  const runs = () => (existsSync(marker) ? readFileSync(marker, 'utf8').split('\n').filter(Boolean).length : 0);
  return { ...testCase, repo, run, runs };
}

test('the same clean tree and command run twice: the second is a cached PASS and does not run the command', async () => {
  const { repo, run, runs } = cacheCase();
  const first = await run(0);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^PASS /);
  const second = await run(0);
  assert.equal(second.status, 0, second.stderr);
  const tree = git(repo, 'rev-parse', 'HEAD^{tree}').slice(0, 12);
  assert.match(second.stdout, new RegExp(`^cached PASS ${tree} \\d{4}-\\d\\d-\\d\\dT\\S+Z ${process.execPath.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')} `));
  assert.equal(runs(), 1, 'the command ran once');
});

test('--fresh runs again after a cached pass', async () => {
  const { run, runs } = cacheCase();
  await run(0);
  const fresh = await run(0, '--fresh');
  assert.match(fresh.stdout, /^PASS /);
  assert.equal(runs(), 2);
});

test('a failing command is never cached', async () => {
  const { run, runs } = cacheCase();
  const first = await run(1);
  assert.equal(first.status, 1);
  assert.match(first.stdout, /^FAIL \(exit 1\) /);
  assert.match(first.stdout, /\nlog: .+\.log\n$/);
  await run(1);
  assert.equal(runs(), 2);
});

test('a dirty tree (an untracked file) is never cached', async () => {
  const { repo, run, runs } = cacheCase();
  writeFileSync(join(repo, 'new.txt'), 'untracked');
  await run(0);
  const second = await run(0);
  assert.match(second.stdout, /^PASS /);
  assert.equal(runs(), 2);
});

test('a command is passed as argv, never through a shell', async () => {
  const { work, env } = makeCase();
  const hostile = `x; touch ${join(work, 'pwned')}`;
  const result = await suite(['run', '--repo', work, '--', process.execPath, '-e', 'process.exit(0)', hostile], { env, cwd: work });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(work, 'pwned')), false);
});

test('status shows a held slot and a waiter', async () => {
  const { stateDir, env, work } = makeCase();
  mkdirSync(join(stateDir, 'slots', '0'), { recursive: true });
  mkdirSync(join(stateDir, 'tickets'), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(stateDir, 'slots', '0', 'holder.json'), JSON.stringify({ pid: process.pid, startedAt: now, repo: '/r', command: 'node --test' }));
  writeFileSync(join(stateDir, 'tickets', `5-${process.pid}`), JSON.stringify({ pid: process.pid, since: now, repo: '/w', command: 'npm test' }));
  const result = await suite(['status'], { env, cwd: work });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^slot 0: pid ${process.pid} since ${now} repo /r command node --test$`, 'm'));
  assert.match(result.stdout, new RegExp(`^waiting: pid ${process.pid} since ${now} repo /w command npm test$`, 'm'));
});

/**
 * A repo whose six tests each import their own lib (and `tool.test.mjs` reaches `lib/c.mjs` only through the tool it spawns by
 * `new URL`), plus settings and a doc. Returns the repo, its base commit and a `related` runner.
 */
function relatedCase() {
  const testCase = makeCase();
  const repo = join(testCase.root, 'my repo');
  git(testCase.root, 'init', '-q', '-b', 'main', repo);
  git(repo, 'config', 'commit.gpgsign', 'false');
  const files = {
    'settings/base.json': '{}\n',
    'docs/guide.md': '# guide\n',
    'tools/t.mjs': "import '../lib/c.mjs';\n",
    'tests/tool.test.mjs': "const TOOL = new URL('../tools/t.mjs', import.meta.url);\n",
  };
  for (const name of ['a', 'b', 'd', 'e', 'f']) {
    files[`lib/${name}.mjs`] = `export const ${name} = 1;\n`;
    files[`tests/${name}.test.mjs`] = `import { ${name} } from '../lib/${name}.mjs';\n`;
  }
  files['lib/c.mjs'] = 'export const c = 1;\n';
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(repo, name, '..'), { recursive: true });
    writeFileSync(join(repo, name), text);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  const related = (...args) => suite(['related', '--repo', repo, '--base', base, ...args], { env: testCase.env, cwd: repo });
  return { repo, base, related };
}

test('related: a changed lib selects only the test that imports it', async () => {
  const { repo, related } = relatedCase();
  appendFileSync(join(repo, 'lib/a.mjs'), '// changed\n');
  const result = await related();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'tests/a.test.mjs\n');
});

test('related: a committed change of a lib reached through a spawned tool selects the spawning test (--tip)', async () => {
  const { repo, related } = relatedCase();
  commit(repo, 'lib/c.mjs', 'export const c = 2;\n');
  const result = await related('--tip', 'HEAD');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'tests/tool.test.mjs\n');
});

test('related: a changed test selects itself', async () => {
  const { repo, related } = relatedCase();
  appendFileSync(join(repo, 'tests/b.test.mjs'), '// changed\n');
  assert.equal((await related()).stdout, 'tests/b.test.mjs\n');
});

test('related: a changed settings file selects the full suite', async () => {
  const { repo, related } = relatedCase();
  writeFileSync(join(repo, 'settings/base.json'), '{"a":1}\n');
  const result = await related();
  assert.equal(result.stdout, 'full\n');
  assert.match(result.stderr, /settings\/base\.json/);
});

test('related: an empty range is none, and so is a change of plain docs only', async () => {
  const { repo, related } = relatedCase();
  assert.deepEqual([(await related()).stdout, (await related()).status], ['none\n', 0]);
  writeFileSync(join(repo, 'docs/guide.md'), '# guide, changed\n');
  assert.equal((await related()).stdout, 'none\n');
});

test('related: a bad ref or a folder that is not a repository exits 2', async () => {
  const { related } = relatedCase();
  const bad = await related('--tip', 'no-such-ref');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /no-such-ref/);
  const { work, env } = makeCase();
  rmSync(join(work), { recursive: true });
  mkdirSync(work);
  assert.equal((await suite(['related', '--repo', work, '--base', 'main'], { env, cwd: work })).status, 2);
});
