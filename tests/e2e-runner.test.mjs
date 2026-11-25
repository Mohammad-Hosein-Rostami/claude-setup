// Tests of the e2e runner's command line (tests/e2e/run.mjs): the skip switch (no CS_E2E_LIVE=1: exit 2, nothing made or
// started), usage errors (exit 2), the dry run (C-2: exit 0, `--model` on every claude line, no Fable), a
// usage limit (exit 3, the reset time printed, no retry), SIGINT (every process of the run ended), E7 run for real against
// land in throwaway repos (exit 0), the login preflight (not logged in: one line, exit 2, no scenario), a login refusal (the
// whole run stops, exit 2), no `--resume` after an error result, an E0 that throws closing the gate, `--real-home`
// giving the real HOME to E9 only, and E0(a) setting the answer mode of the later jobs (R8).
// Safety: a real `claude` never runs. Every runner gets a PATH whose first folder holds a fake `claude`, a temp HOME (with a
// made-up settings.json and CLAUDE.md) and a temp TMPDIR, so its run root, results and the HOME it copies are all in the case.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fakeStack } from './claude-fakes.mjs';
import { cleanEnv } from './clean-env.mjs';
import { madeUpToken } from './e2e-fixtures.mjs';
import { LOGIN_LINE, PREFLIGHT_ARGS } from './e2e/lib/login.mjs';
import { RUN_PREFIX } from './e2e/lib/scratch.mjs';
import { makeTempDir, testTempRoot } from './temp-dir-helpers.mjs';

const RUNNER = fileURLToPath(new URL('./e2e/run.mjs', import.meta.url));
const RUNNER_TIMEOUT_MS = 120_000;
const RESETS_AT_S = 1_795_000_000;
const SESSION_ID = 'fake-e2e-session-1';
const TREE_SEEN_MS = 2_500; // past the registry's 1 s tree poll, so the fake's own child has been seen
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Fake `claude` scripts (CommonJS, outside every repo). Each answers the runner's login preflight (`auth status`) as logged in,
// else logs its argv and whether an API key reached it, then:
const LOGGED_IN = `if (process.argv[2] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'made-up' })); process.exit(0); }
`;
const LOG_CALL = `${LOGGED_IN}const { appendFileSync } = require('node:fs');
appendFileSync(process.env.FAKE_E2E_CLAUDE_LOG, JSON.stringify({ args: process.argv.slice(2), apiKey: 'ANTHROPIC_API_KEY' in process.env }) + '\\n');
const emit = (event) => console.log(JSON.stringify(event));
emit({ type: 'system', subtype: 'init', session_id: '${SESSION_ID}', apiKeySource: 'none' });
`;
// prints a rejected rate-limit event and would run on for 20 s if nobody stopped it
const LIMIT_CLAUDE = `${LOG_CALL}emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: ${RESETS_AT_S}, rateLimitType: 'five_hour' } });
setTimeout(() => {}, 20000);
`;
// starts a child in a process group of its own (as a subagent's Bash does), writes its pid, and runs on
const HANG_CLAUDE = `${LOG_CALL}const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
child.unref();
require('node:fs').writeFileSync(process.env.FAKE_E2E_CHILD_PID, String(child.pid));
setTimeout(() => {}, 60000);
`;

// answers every -p run with an error result: a login refusal, or an error of another kind
const REFUSED_CLAUDE = `${LOG_CALL}emit({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' });
`;
const ERROR_CLAUDE = `${LOG_CALL}emit({ type: 'result', is_error: true, result: 'API Error: 500 made-up overload' });
`;
// says it is not logged in, as \`claude auth status\` does without a login
const LOGGED_OUT_CLAUDE = LOG_CALL.replace(LOGGED_IN, `if (process.argv[2] === 'auth') { console.log(JSON.stringify({ loggedIn: false })); process.exit(0); }
`);
// answers every -p run with a good result: the digit 4 at once, or (FOUR_ON_RESUME) only in a `--resume` run, as a boss that
// ends before its background agent does (E0(a) then needs rounds: the resume answer mode)
const FOUR_AT_ONCE = `${LOG_CALL}emit({ type: 'result', is_error: false, result: '4', session_id: '${SESSION_ID}' });
`;
const FOUR_ON_RESUME = `${LOG_CALL}emit({ type: 'result', is_error: false, result: process.argv.includes('--resume') ? '4' : 'started', session_id: '${SESSION_ID}' });
`;
const FAILING_GIT = `#!/usr/bin/env node
process.stderr.write('fatal: made-up git failure\\n');
process.exit(128);
`;

// A case folder under the caller's TMPDIR can pass the 80-char runner temp root (macOS `mktemp -d` TMPDIRs are 60+ chars), so the
// cases are made under /tmp where it exists; Windows keeps its default root.
const SHORT_ROOT = process.platform === 'win32' ? undefined : '/tmp';

/** A case folder: TMPDIR, a temp HOME with made-up owner files, a fake claude first on PATH, and the made-up login token of a
 * `claude-as` terminal (the first login source, so the runner never reads an account store; e2e-login-run.test.mjs reads one). */
function makeCase(fakeClaude = LIMIT_CLAUDE) {
  const dir = makeTempDir('e2er-', SHORT_ROOT);
  assert.equal(testTempRoot(dir), dir, 'the case folder is short enough to be the runner temp root');
  const home = join(dir, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env: { CLAUDE_GUARD_ASK: 'allow' }, autoContinueAtUsageLimit: true }));
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# made-up owner rules\n');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node\n${fakeClaude}`);
  chmodSync(join(bin, 'claude'), 0o755);
  const claudeLog = join(dir, 'claude.log');
  const env = cleanEnv({ HOME: home, USERPROFILE: home, TMPDIR: dir, PATH: `${bin}${delimiter}${process.env.PATH}`, CS_E2E_LIVE: '1',
    ANTHROPIC_API_KEY: 'from-the-test', FAKE_E2E_CLAUDE_LOG: claudeLog, FAKE_E2E_CHILD_PID: join(dir, 'child.pid'),
    CLAUDE_CODE_OAUTH_TOKEN: madeUpToken() });
  delete env.NODE_TEST_CONTEXT;
  const calls = () => (existsSync(claudeLog) ? readFileSync(claudeLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  const runRoots = () => readdirSync(dir).filter((name) => name.startsWith(RUN_PREFIX));
  return { dir, env, calls, runRoots, out: join(dir, 'out') };
}

/** Starts the runner; `done` settles with its exit code and output. */
function startRunner(args, env) {
  const child = spawn(process.execPath, [RUNNER, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`runner did not end in time:\n${stdout}\n${stderr}`)); }, RUNNER_TIMEOUT_MS);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  return { child, done };
}
const runRunner = (args, env) => startRunner(args, env).done;

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('skip switch: --all without CS_E2E_LIVE=1 exits 2, starts no claude and makes no run root', async () => {
  const stack = fakeStack();
  const tmp = makeTempDir('e2er-');
  for (const value of [undefined, '0', 'yes']) {
    const env = { ...stack.env, TMPDIR: tmp, CS_E2E_LIVE: value };
    if (value === undefined) delete env.CS_E2E_LIVE;
    const { code, stderr } = await runRunner(['--all'], env);
    assert.equal(code, 2, `CS_E2E_LIVE=${value}`);
    assert.match(stderr, /set CS_E2E_LIVE=1/);
  }
  assert.deepEqual(stack.claudeCalls(), []);
  assert.deepEqual(readdirSync(tmp).filter((name) => name.startsWith(RUN_PREFIX)), []);
});

test('usage errors exit 2 before anything starts: an unknown --only id, no selection, an unknown flag, a missing value', async () => {
  const kase = makeCase();
  for (const [args, message] of [[['--only', 'E0,E99'], /unknown scenario id: E99/], [[], /--only <id,...> or --all/],
    [['--all', '--fast'], /unknown argument: --fast/], [['--only'], /--only needs a value/], [['--only', 'E1', '--all'], /cannot both/]]) {
    const { code, stderr } = await runRunner(args, kase.env);
    assert.equal(code, 2, args.join(' '));
    assert.match(stderr, message);
  }
  assert.deepEqual(kase.calls(), []);
  assert.deepEqual(kase.runRoots(), []);
});

// E2-E5, E8 and E10 went with the guard and the popup; the six scenarios left print 6 claude lines in the dry run (E0, E1, E6, E9)
const MIN_DRY_CLAUDE_LINES = 6;

test('C-2: --dry-run --all exits 0, every claude line names an allowed --model, no line names Fable, nothing starts', async () => {
  const kase = makeCase();
  const { code, stdout } = await runRunner(['--dry-run', '--all'], kase.env);
  assert.equal(code, 0, stdout);
  const lines = stdout.split('\n');
  const claudeLines = lines.filter((line) => /(?:^|\s)claude -p /.test(line));
  assert.ok(claudeLines.length >= MIN_DRY_CLAUDE_LINES, `${claudeLines.length} claude lines`);
  for (const line of claudeLines) assert.match(line, / --model (?:opus|sonnet|claude-opus-5-5|claude-sonnet-5-5) /, line);
  assert.deepEqual(lines.filter((one) => /fable/i.test(one)), []);
  assert.ok(!/ANTHROPIC_API_KEY=/.test(stdout));
  for (const id of ['E0', 'E1', 'E6', 'E7', 'E9', 'E11']) assert.match(stdout, new RegExp(`^# ${id} `, 'm'));
  assert.deepEqual(kase.calls(), []);
  assert.deepEqual(kase.runRoots(), []);
});

test('a usage limit stops the run: exit 3, the reset time printed, claude called once, no process or root left', async () => {
  const kase = makeCase(LIMIT_CLAUDE);
  const { code, stdout } = await runRunner(['--only', 'E0', '--out', kase.out], kase.env);
  assert.equal(code, 3, stdout);
  assert.match(stdout, new RegExp(`resets at ${new Date(RESETS_AT_S * 1000).toISOString()}\\. Nothing was retried`));
  const calls = kase.calls();
  assert.equal(calls.length, 1, 'no retry and no later claude run');
  assert.equal(calls[0].args[calls[0].args.indexOf('--model') + 1], 'sonnet');
  assert.equal(calls[0].apiKey, false, 'the runner drops ANTHROPIC_API_KEY from every child');
  assert.match(stdout, /^run no process of the run is left \| none \| none \| PASS$/m);
  assert.match(stdout, /^run the run root was removed \| removed \| removed \| PASS$/m);
  assert.deepEqual(kase.runRoots(), []);
  const results = JSON.parse(readFileSync(join(kase.out, 'results.json'), 'utf8'));
  assert.deepEqual([results.exit, results.limit.kind, results.scenarios[0].id], [3, 'limit', 'E0']);
});

test('SIGINT ends every process of the run, also a child the fake claude left in its own group', async () => {
  const kase = makeCase(HANG_CLAUDE);
  const pidFile = join(kase.dir, 'child.pid');
  const runner = startRunner(['--only', 'E0', '--out', kase.out], kase.env);
  let child = null;
  try {
    for (let waited = 0; waited < RUNNER_TIMEOUT_MS / 2 && !existsSync(pidFile); waited += 100) await pause(100);
    child = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(isAlive(child));
    await pause(TREE_SEEN_MS);
    runner.child.kill('SIGINT');
    const { code, stdout } = await runner.done;
    assert.equal(code, 1, stdout);
    assert.match(stdout, /SIGINT: stopping every scenario/);
    assert.match(stdout, /^run no process of the run is left \| none \| none \| PASS$/m);
    assert.equal(isAlive(child), false, 'the detached child of the fake claude is gone');
    assert.deepEqual(kase.runRoots(), []);
    assert.equal(kase.calls().length, 1, 'no claude starts after the interrupt');
  } finally {
    if (child && isAlive(child)) process.kill(child, 'SIGKILL');
    runner.child.kill('SIGKILL');
  }
});

test('E7 live (land in throwaway repos, no claude): every check passes and the runner exits 0', async () => {
  const kase = makeCase();
  const { code, stdout } = await runRunner(['--only', 'E7', '--out', kase.out], kase.env);
  assert.equal(code, 0, stdout);
  const e7 = stdout.split('\n').filter((line) => line.startsWith('E7 '));
  assert.ok(e7.length >= 5, stdout);
  for (const line of e7) assert.match(line, /\| PASS$/, line);
  assert.deepEqual(kase.calls(), []);
  assert.deepEqual(kase.runRoots(), []);
});

const minusP = (calls) => calls.filter((one) => one.args[0] === '-p');

test('preflight: without a login (fakeStack claude) the run prints one line, exits 2 and starts no scenario', async () => {
  const kase = makeCase();
  const stack = fakeStack();
  const env = { ...kase.env, PATH: `${stack.bin}${delimiter}${process.env.PATH}`, FAKE_CLAUDE_LOG: stack.env.FAKE_CLAUDE_LOG,
    FAKE_CLAUDE_MODE: 'ok', ACCOUNT_STATE_DIR: stack.env.ACCOUNT_STATE_DIR };
  const { code, stdout } = await runRunner(['--only', 'E0,E7', '--out', kase.out], env);
  assert.equal(code, 2, stdout);
  assert.equal(stdout, `${LOGIN_LINE}\n`);
  assert.deepEqual(stack.claudeCalls().map((one) => one.args), [[...PREFLIGHT_ARGS]], 'only the preflight ran: no -p, no --resume');
  assert.deepEqual(kase.runRoots(), []);
  const results = JSON.parse(readFileSync(join(kase.out, 'results.json'), 'utf8'));
  assert.deepEqual([results.exit, results.scenarios.length], [2, 0]);
});

test('preflight: "loggedIn": false gives the same one line and exit 2; the dry run names the preflight and skips it', async () => {
  const kase = makeCase(LOGGED_OUT_CLAUDE);
  const live = await runRunner(['--only', 'E7', '--out', kase.out], kase.env);
  assert.equal(live.code, 2, live.stdout);
  assert.equal(live.stdout, `${LOGIN_LINE}\n`);
  assert.deepEqual(kase.calls(), []);
  const dry = await runRunner(['--dry-run', '--only', 'E0'], kase.env);
  assert.equal(dry.code, 0, dry.stdout);
  assert.match(dry.stdout, /^preflight: claude auth status --json .*\(skipped in a dry run\)$/m);
  assert.ok(!dry.stdout.includes(LOGIN_LINE));
});

test('a login refusal stops the whole run: exit 2, one line for E0, later scenarios NOT RUN, no --resume', async () => {
  const kase = makeCase(REFUSED_CLAUDE);
  const { code, stdout } = await runRunner(['--only', 'E0,E7', '--out', kase.out], kase.env);
  assert.equal(code, 2, stdout);
  assert.deepEqual(minusP(kase.calls()).length, 1, 'the first refused call is the last one');
  assert.equal(stdout.split('\n').filter((line) => line.startsWith('E0 ')).length, 1, stdout);
  assert.match(stdout, /^E0 .*: every claude run is logged in \| logged in \| a-background-lex: Not logged in .* \| FAIL$/m);
  assert.match(stdout, /^E7 .* \| not run: stopped: a claude run was refused its login \(no retry\) \| NOT RUN$/m);
  assert.match(stdout, /^e2e: stopped: E0 a-background-lex was refused its login .*Nothing was retried\.$/m);
  assert.deepEqual(kase.runRoots(), []);
});

test('an error result is not resumed: E0(a) stops after its first run and says so', async () => {
  const kase = makeCase(ERROR_CLAUDE);
  const { code, stdout } = await runRunner(['--only', 'E0', '--out', kase.out], kase.env);
  assert.equal(code, 1, stdout);
  assert.deepEqual(kase.calls().filter((one) => one.args.includes('--resume')), []);
  assert.match(stdout, /^E0 \(a\) .* \| one run, stopped: an error result: .* \| FAIL$/m);
  assert.deepEqual(kase.runRoots(), []);
});

test('an E0 that throws (its git setup fails) closes the gate: the later scenarios are NOT RUN', async () => {
  const kase = makeCase();
  writeFileSync(join(kase.dir, 'bin', 'git'), FAILING_GIT);
  chmodSync(join(kase.dir, 'bin', 'git'), 0o755);
  const { code, stdout } = await runRunner(['--only', 'E0,E7', '--out', kase.out], kase.env);
  assert.equal(code, 1, stdout);
  assert.match(stdout, /^E0 .*: setup ran to its end \| no error \| e2e: setup step failed: git init .*made-up git failure \| FAIL$/m);
  assert.match(stdout, /^E7 .* \| not run: E0 stopped with an error, so its probes say nothing \| NOT RUN$/m);
  assert.deepEqual(minusP(kase.calls()), []);
  assert.deepEqual(kase.runRoots(), []);
});

test('--real-home: the dry run gives the real HOME to E9 only; E0 keeps the temp HOME of the run root', async () => {
  const kase = makeCase();
  const { code, stdout } = await runRunner(['--dry-run', '--real-home', '--only', 'E0,E9'], kase.env);
  assert.equal(code, 0, stdout);
  const homeOf = (id) => new RegExp(`^# ${id} .*; HOME (\\S+)\\)$`, 'm').exec(stdout)?.[1];
  assert.equal(homeOf('E9'), kase.env.HOME);
  assert.ok(homeOf('E0').startsWith(join(kase.dir, RUN_PREFIX)) && homeOf('E0').endsWith('/home'), homeOf('E0'));
  assert.ok(!/E9 run: not run/.test(stdout), 'E9 runs in this mode');
});

test("E0(a) sets the later jobs' answer mode: direct when it was done in one run, resume when it needed rounds", async () => {
  const jobLineOf = (stdout) => /^E6 each claude job ended: .*$/m.exec(stdout)?.[0] ?? '';
  const direct = makeCase(FOUR_AT_ONCE);
  const once = await runRunner(['--only', 'E0,E6', '--out', direct.out], direct.env);
  assert.match(once.stdout, /^e2e: E0 answer mode direct: later jobs run once$/m, once.stdout);
  assert.match(jobLineOf(once.stdout), /\| done \(E0 answer mode: direct\) \| run-release: one run; run-owner: one run; run-proxy: one run \| PASS$/);
  assert.deepEqual(direct.calls().filter((one) => one.args.includes('--resume')), []);
  const rounds = makeCase(FOUR_ON_RESUME);
  const resumed = await runRunner(['--only', 'E0,E6', '--out', rounds.out], rounds.env);
  assert.match(resumed.stdout, /^e2e: E0 answer mode resume: later jobs get --resume rounds until done$/m, resumed.stdout);
  assert.match(jobLineOf(resumed.stdout), /\| done \(E0 answer mode: resume\) \| run-release: one run; run-owner: one run; run-proxy: one run \| PASS$/);
});
