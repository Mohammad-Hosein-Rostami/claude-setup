// Tests for the staging in home/hooks/post-edit.mjs: stagesFor, runStages (concurrent lint + typecheck, lint-first early
// return, deadline and process-tree kills) and runCheck's kill handle. Posix only where a fake package manager runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { warmExec } from './warm-exec.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCheck, runStages, stagesFor } from '../home/hooks/post-edit.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const names = (stages) => stages.map((stage) => stage.map((c) => c.name));
const ALL_CHECKS = ['format', 'lint', 'typecheck'].map((name) => ({ name, args: ['run', name] }));

test('stagesFor: format first and alone, lint and typecheck concurrent', () => {
  const scripts = { format: 'prettier --write', lint: 'eslint', typecheck: 'tsc --noEmit' };
  assert.deepEqual(names(stagesFor(ALL_CHECKS, scripts)), [['format'], ['lint', 'typecheck']]);
});

test('stagesFor: a fixing lint script keeps everything sequential', () => {
  for (const lint of ['eslint --fix', 'eslint . --fix --quiet', 'fix-lint', 'biome check --write', 'biome lint --apply']) {
    assert.deepEqual(names(stagesFor(ALL_CHECKS, { lint })), [['format'], ['lint'], ['typecheck']], lint);
  }
});

test('stagesFor: lone or missing checks stay as single stages', () => {
  const [format, lint, typecheck] = ALL_CHECKS;
  assert.deepEqual(names(stagesFor([lint], { lint: 'eslint' })), [['lint']]);
  assert.deepEqual(names(stagesFor([typecheck], {})), [['typecheck']]);
  assert.deepEqual(names(stagesFor([format, typecheck], {})), [['format'], ['typecheck']]);
  assert.deepEqual(stagesFor([], {}), []);
});

const TIMED_ATTEMPTS = 3;

/** Runs `job` up to 3 times, stopping at the first run faster than `underMs`; returns the fastest run in ms. A slow machine can delay one run; the code cannot beat its own speed. */
async function fastestOfAttempts(job, underMs) {
  let fastest = Infinity;
  for (let attempt = 0; attempt < TIMED_ATTEMPTS && fastest >= underMs; attempt += 1) {
    const started = Date.now();
    await job();
    fastest = Math.min(fastest, Date.now() - started);
  }
  return fastest;
}

// Fake package manager (a node script with a shebang): `fake <run> <name>` logs start/end, sleeps, then fails or not
// per FAKE_* env. Posix only: Windows would need a .cmd shim.
const FAKE_PM = `#!${process.execPath}
if (process.env.FAKE_WARM) process.exit(0);
const { appendFileSync } = require('node:fs');
const name = process.argv[3];
const log = (what) => appendFileSync(process.env.FAKE_LOG, name + ' ' + what + ' ' + Date.now() + '\\n');
log('start');
setTimeout(() => {
  log('end');
  if (process.env.FAKE_FAIL?.split(',').includes(name)) {
    console.error('src/a.ts(1,1): error TS1: ' + name + ' failed');
    process.exitCode = 1;
  }
}, Number(process.env.FAKE_SLEEP_MS ?? 0));
`;

async function fakeProject(env) {
  const dir = makeTempDir('post-edit-fake-');
  const pm = join(dir, 'fake-pm');
  await writeFile(pm, FAKE_PM);
  await chmod(pm, 0o755);
  warmExec(pm);
  const log = join(dir, 'log.txt');
  await writeFile(log, '');
  Object.assign(process.env, { FAKE_LOG: log }, env);
  return { pm, dir, log };
}

const events = async (log) =>
  (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map((l) => l.split(' ')).map(([name, what, at]) => ({ name, what, at: Number(at) }));

const posix = { skip: process.platform === 'win32' };

test('runStages runs lint and typecheck concurrently, format first', posix, async () => {
  const { pm, dir, log } = await fakeProject({ FAKE_SLEEP_MS: '300', FAKE_FAIL: '' });
  const stages = stagesFor(ALL_CHECKS, { lint: 'eslint' });
  const out = await runStages(stages, { pm, cwd: dir, rel: 'src/a.ts', deadline: Date.now() + 10_000 });
  assert.deepEqual(out, []);
  const ev = await events(log);
  const at = (name, what) => ev.find((e) => e.name === name && e.what === what).at;
  assert.ok(at('format', 'end') <= at('lint', 'start'), 'format finishes before lint starts');
  assert.ok(at('typecheck', 'start') < at('lint', 'end'), 'typecheck starts while lint is still running');
});

test('runStages with a fixing lint runs lint to the end before typecheck starts', posix, async () => {
  const { pm, dir, log } = await fakeProject({ FAKE_SLEEP_MS: '150', FAKE_FAIL: '' });
  const stages = stagesFor(ALL_CHECKS, { lint: 'eslint --fix' });
  await runStages(stages, { pm, cwd: dir, rel: 'src/a.ts', deadline: Date.now() + 10_000 });
  const ev = await events(log);
  const at = (name, what) => ev.find((e) => e.name === name && e.what === what).at;
  assert.ok(at('lint', 'end') <= at('typecheck', 'start'));
});

test('runStages reports lint before typecheck when both fail', posix, async () => {
  const { pm, dir } = await fakeProject({ FAKE_SLEEP_MS: '0', FAKE_FAIL: 'lint,typecheck' });
  const out = await runStages(stagesFor(ALL_CHECKS, { lint: 'eslint' }), { pm, cwd: dir, rel: 'src/a.ts', deadline: Date.now() + 10_000 });
  assert.deepEqual(out, ['src/a.ts:1 TS1 lint failed']);
});

test('runStages stops at a failing format without running later stages', posix, async () => {
  const { pm, dir, log } = await fakeProject({ FAKE_SLEEP_MS: '0', FAKE_FAIL: 'format' });
  const out = await runStages(stagesFor(ALL_CHECKS, { lint: 'eslint' }), { pm, cwd: dir, rel: 'src/a.ts', deadline: Date.now() + 10_000 });
  assert.deepEqual(out, ['src/a.ts:1 TS1 format failed']);
  assert.deepEqual([...new Set((await events(log)).map((e) => e.name))], ['format']);
});

test('runStages: a timeout or exhausted budget is no failure, even with a failing sibling', posix, async () => {
  const { pm, dir } = await fakeProject({ FAKE_SLEEP_MS: '5000', FAKE_FAIL: 'typecheck' });
  const lintAndTypecheck = stagesFor(ALL_CHECKS.slice(1), { lint: 'eslint' });
  const fastest = await fastestOfAttempts(async () => {
    assert.deepEqual(await runStages(lintAndTypecheck, { pm, cwd: dir, rel: 'src/a.ts', deadline: Date.now() + 300 }), []);
  }, 3000);
  assert.ok(fastest < 3000, `killed at the deadline, not after the 5 s sleep (fastest of up to 3: ${fastest.toFixed(0)} ms)`);
  assert.deepEqual(await runStages(lintAndTypecheck, { pm, cwd: dir, rel: 'src/a.ts', deadline: Date.now() - 1 }), []);
});

test('runStages reports a missing package manager as a HOOK failure', async () => {
  const out = await runStages([[{ name: 'lint', args: ['run', 'lint'] }]], { pm: '/nonexistent/pm', cwd: tmpdir(), rel: 'src/a.ts', deadline: Date.now() + 5000 });
  assert.match(out[0], /^src\/a\.ts:1 HOOK could not run \/nonexistent\/pm lint/);
});

// A fake package manager that leaves a long-lived grandchild holding the stdout pipe: only a tree kill and a
// timer-driven resolve return in time.
test('runStages returns within the deadline even when a grandchild outlives the check', posix, async () => {
  const dir = makeTempDir('post-edit-tree-');
  const pm = join(dir, 'fake-pm');
  const pidFile = join(dir, 'grandchild.pid');
  await writeFile(pm, `#!${process.execPath}
if (process.env.FAKE_WARM) process.exit(0);
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' });
writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
setTimeout(() => {}, 60000);
`);
  await chmod(pm, 0o755);
  warmExec(pm);
  // 2.5 s headroom: the fake pm must start node and write the pid file before the deadline, even when the suite
  // runs test files in parallel; the return is still far below the 60 s grandchild.
  const deadlineMs = 2500;
  // Fastest of up to 3 attempts; every attempt must also have killed its own grandchild.
  let fastest = Infinity;
  for (let attempt = 0; attempt < TIMED_ATTEMPTS && fastest >= deadlineMs + 2000; attempt += 1) {
    await rm(pidFile, { force: true });
    const started = Date.now();
    const out = await runStages([[{ name: 'lint', args: ['run', 'lint'] }]], { pm, cwd: dir, rel: 'src/a.ts', deadline: started + deadlineMs });
    fastest = Math.min(fastest, Date.now() - started);
    assert.deepEqual(out, []);
    const grandchildPid = Number(await readFile(pidFile, 'utf8'));
    await new Promise((r) => setTimeout(r, 200));
    assert.throws(() => process.kill(grandchildPid, 0), { code: 'ESRCH' }, 'grandchild was killed with the tree');
  }
  assert.ok(fastest < deadlineMs + 2000, `returned at the deadline, not after the 60 s grandchild (fastest of up to ${TIMED_ATTEMPTS}: ${fastest} ms)`);
});

// Lint is quick and fails about the edited file; the typecheck sleeps 10 s unless told otherwise.
const LINT_FIRST_PM = `#!${process.execPath}
if (process.env.FAKE_WARM) process.exit(0);
const name = process.argv[3];
if (name === 'lint') {
  console.error(process.env.LINT_ABOUT + '(1,1): error TS1: lint failed');
  process.exitCode = 1;
} else {
  setTimeout(() => {}, Number(process.env.TYPECHECK_MS));
}
`;

async function lintFirstPm(env) {
  const dir = makeTempDir('post-edit-lintfirst-');
  const pm = join(dir, 'fake-pm');
  await writeFile(pm, LINT_FIRST_PM);
  await chmod(pm, 0o755);
  warmExec(pm);
  Object.assign(process.env, env);
  return { pm, dir };
}

const LINT_AND_TYPECHECK = ALL_CHECKS.slice(1);

test('runStages returns lint failures at once and kills the slow typecheck', posix, async () => {
  const { pm, dir } = await lintFirstPm({ LINT_ABOUT: 'src/a.ts', TYPECHECK_MS: '10000' });
  const fastest = await fastestOfAttempts(async () => {
    const out = await runStages(stagesFor(LINT_AND_TYPECHECK, { lint: 'eslint' }), { pm, cwd: dir, rel: 'src/a.ts', deadline: Date.now() + 20_000 });
    assert.deepEqual(out, ['src/a.ts:1 TS1 lint failed']);
  }, 3000);
  assert.ok(fastest < 3000, `did not wait for the 10 s typecheck (fastest of up to 3: ${fastest.toFixed(0)} ms)`);
});

test('runStages keeps waiting for the typecheck when lint only fails about other files', posix, async () => {
  const { pm, dir } = await lintFirstPm({ LINT_ABOUT: 'src/other.ts', TYPECHECK_MS: '600' });
  const started = Date.now();
  const out = await runStages(stagesFor(LINT_AND_TYPECHECK, { lint: 'eslint' }), { pm, cwd: dir, rel: 'src/a.ts', deadline: started + 20_000 });
  assert.deepEqual(out, []);
  assert.ok(Date.now() - started >= 500, 'waited for the typecheck to finish');
});

// Records every process.kill call while `body` runs (killTree signals a process group with a negative pid).
async function recordKills(body) {
  const calls = [];
  const original = process.kill;
  process.kill = (pid, signal) => {
    calls.push([pid, signal]);
    return true;
  };
  try {
    await body();
  } finally {
    process.kill = original;
  }
  return calls;
}

test('runCheck.kill signals the process group of a running check', posix, async () => {
  const run = runCheck('unused', { cmd: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'] }, tmpdir(), 30_000);
  const calls = await recordKills(async () => run.kill());
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 'SIGKILL');
  assert.ok(calls[0][0] < 0, 'negative pid: the whole group');
  process.kill(calls[0][0], 'SIGKILL'); // the stubbed kill did not stop it: do it for real
  await run;
});

test('runCheck.kill does nothing once the check has closed (a recycled pid is never signalled)', posix, async () => {
  const run = runCheck('unused', { cmd: process.execPath, args: ['-e', ''] }, tmpdir(), 10_000);
  assert.equal((await run).status, 0);
  assert.deepEqual(await recordKills(async () => run.kill()), []);
});

test('a lint-first early return kills only the still-running typecheck, not the closed lint', posix, async () => {
  const { pm, dir } = await lintFirstPm({ LINT_ABOUT: 'src/a.ts', TYPECHECK_MS: '4000' });
  const calls = await recordKills(async () => {
    const out = await runStages(stagesFor(LINT_AND_TYPECHECK, { lint: 'eslint' }), { pm, cwd: dir, rel: 'src/a.ts', deadline: Date.now() + 20_000 });
    assert.deepEqual(out, ['src/a.ts:1 TS1 lint failed']);
  });
  assert.equal(calls.length, 1, 'one kill: the typecheck');
  process.kill(calls[0][0], 'SIGKILL'); // the stubbed kill did not stop it: do it for real
});
