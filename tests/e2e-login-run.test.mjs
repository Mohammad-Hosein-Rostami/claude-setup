// Tests of the e2e runner's stored login, end to end (review round 3): with no CLAUDE_CODE_OAUTH_TOKEN in its env the runner
// reads the claude-account store once (the real account library, on a file store in the case's HOME, filled with a made-up
// token); the token reaches every `claude` child's env and never its argv; the run prints only the account's name; and a scan
// of every file the run wrote and of its stdout and stderr finds the token's value 0 times, though the fake `claude` echoes its
// login into its stream, its stderr, a transcript, the guard log and long-run's state (each route the kept files come from), and
// a token of no known shape from the terminal is masked the same way. An empty store or an unreadable one
// ends the run with exit 2 and one plain line before anything is made; `--no-stored-login` reads no store; the dry run reads
// nothing. Safety: a real `claude`, the Keychain and the real HOME are never reached (fake `claude` first on PATH, temp HOME,
// CLAUDE_ACCOUNT_STORE=file).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { addAccount, setDefault } from '../home/tools/account/lib/accounts.mjs';
import { cleanEnv } from './clean-env.mjs';
import { madeUpToken } from './e2e-fixtures.mjs';
import { REDACTED } from './e2e/lib/redact.mjs';
import { RUN_PREFIX } from './e2e/lib/scratch.mjs';
import { NO_ACCOUNT_LINE } from './e2e/lib/stored-login.mjs';
import { makeTempDir, testTempRoot } from './temp-dir-helpers.mjs';

const RUNNER = fileURLToPath(new URL('./e2e/run.mjs', import.meta.url));
const RUNNER_TIMEOUT_MS = 120_000;
const ACCOUNT_NAME = 'e2e-made-up';
const STORED_TOKEN = madeUpToken('oat01');
const PLAIN_TERMINAL_LOGIN = 'made-up-terminal-login-value-0077'; // no sk-ant- shape: only the exact-value mask catches it
const SESSION_ID = 'fake-e2e-login-session';
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// A fake `claude` (CommonJS): logs its argv and a hash of the login it got (never the login itself), then echoes the login into
// every place a child can (as a session that runs `printenv` would): the preflight's (`auth status`) JSON and stderr, and for a
// -p run a transcript under the HOME's projects, the guard log, long-run's state, a tool result in its stream, its stderr and
// its result. It answers the preflight as logged in and every -p run with a good result at once.
const ECHO_PROJECT = 'e2e-login-echo';
const HASH_CLAUDE = `const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const login = process.env.CLAUDE_CODE_OAUTH_TOKEN;
appendFileSync(process.env.FAKE_E2E_CLAUDE_LOG, JSON.stringify({ args: process.argv.slice(2),
  loginHash: login === undefined ? null : createHash('sha256').update(login).digest('hex') }) + '\\n');
const echo = login ?? 'no-login';
if (process.argv[2] === 'auth') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'made-up', seen: echo }));
  console.error('auth stderr ' + echo);
  process.exit(0);
}
const claudeDir = join(process.env.HOME, '.claude');
mkdirSync(join(claudeDir, 'projects', '${ECHO_PROJECT}'), { recursive: true });
writeFileSync(join(claudeDir, 'projects', '${ECHO_PROJECT}', 'echo.jsonl'), JSON.stringify({ type: 'user', message: { content: 'printenv: ' + echo } }) + '\\n');
mkdirSync(join(claudeDir, 'logs'), { recursive: true });
appendFileSync(join(claudeDir, 'logs', 'guard.jsonl'), JSON.stringify({ command: 'printenv', out: echo }) + '\\n');
mkdirSync(process.env.LONG_RUN_STATE_DIR, { recursive: true });
writeFileSync(join(process.env.LONG_RUN_STATE_DIR, 'echo.txt'), echo);
const emit = (event) => console.log(JSON.stringify(event));
emit({ type: 'system', subtype: 'init', session_id: '${SESSION_ID}', apiKeySource: 'none' });
emit({ type: 'user', message: { content: [{ type: 'tool_result', content: 'CLAUDE_CODE_OAUTH_TOKEN=' + echo + '\\nseen ' + echo }] } });
console.error('stderr echo ' + echo);
emit({ type: 'result', is_error: false, result: '4 ' + echo, session_id: '${SESSION_ID}' });
`;
/** The kept copies of the echo files (run.mjs: transcripts, home-logs, long-run-state), relative to --out. */
const ECHO_COPIES = [['transcripts', ECHO_PROJECT, 'echo.jsonl'], ['home-logs', 'guard.jsonl'], ['long-run-state', 'echo.txt']];

/**
 * A case folder: TMPDIR, a temp HOME with made-up owner files and a file account store, the fake claude first on PATH, and no
 * terminal token unless one is given (so the store is the login source).
 * @param {{stored?: boolean, terminalToken?: string}} [spec] false: the store holds no account; the terminal's own login
 */
function makeCase({ stored = true, terminalToken } = {}) {
  const dir = makeTempDir('e2el-');
  assert.equal(testTempRoot(dir), dir, 'the case folder is short enough to be the runner temp root');
  const home = join(dir, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env: {} }));
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# made-up owner rules\n');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node\n${HASH_CLAUDE}`);
  chmodSync(join(bin, 'claude'), 0o755);
  const accountsDir = join(home, '.config', 'claude-setup', 'accounts');
  const store = { HOME: home, USERPROFILE: home, CLAUDE_ACCOUNT_STORE: 'file', CLAUDE_ACCOUNT_DIR: accountsDir };
  if (stored) {
    addAccount(ACCOUNT_NAME, STORED_TOKEN, { env: store });
    setDefault(ACCOUNT_NAME, { env: store });
  }
  const claudeLog = join(dir, 'claude.log');
  const env = cleanEnv({ ...store, TMPDIR: dir, PATH: `${bin}${delimiter}${process.env.PATH}`, CS_E2E_LIVE: '1', FAKE_E2E_CLAUDE_LOG: claudeLog });
  delete env.NODE_TEST_CONTEXT;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  if (terminalToken !== undefined) env.CLAUDE_CODE_OAUTH_TOKEN = terminalToken;
  const calls = () => (existsSync(claudeLog) ? readFileSync(claudeLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  const runRoots = () => readdirSync(dir).filter((name) => name.startsWith(RUN_PREFIX));
  return { dir, env, accountsDir, calls, runRoots, out: join(dir, 'out') };
}

/** Runs the runner to its end. @returns {Promise<{code: number, stdout: string, stderr: string}>} */
function runRunner(args, env) {
  const child = spawn(process.execPath, [RUNNER, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`runner did not end in time:\n${stdout}\n${stderr}`)); }, RUNNER_TIMEOUT_MS);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** Every file under `dir`, except under `skip` (the account store holds the token on purpose). */
function filesUnder(dir, skip) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => !path.startsWith(`${skip}${sep}`) && statSync(path).isFile());
}

/**
 * Asserts the echoed login reached each kept copy (masked) and that no file the run wrote, nor its stdout or stderr, holds it.
 * @returns {string[]} the files scanned
 */
function assertNowhere(one, run, value) {
  for (const parts of ECHO_COPIES) {
    const copy = readFileSync(join(one.out, ...parts), 'utf8');
    assert.ok(copy.includes(REDACTED) && !copy.includes(value), `${parts.join('/')}: the echo was kept, masked`);
  }
  const written = filesUnder(one.dir, one.accountsDir);
  assert.ok(written.includes(join(one.out, 'results.json')), 'the scan covers the run output');
  assert.ok(written.some((path) => path.startsWith(join(one.out, 'E0', 'logs') + sep)), 'and the scenario logs (stream, stderr)');
  const holding = written.filter((path) => readFileSync(path, 'latin1').includes(value));
  assert.deepEqual(holding, [], 'no file the run wrote holds the login');
  assert.ok(!run.stdout.includes(value) && !run.stderr.includes(value), 'nor its stdout or stderr');
  return written;
}

test('stored login: the account store token reaches every claude child by env, never argv; only the name is printed', async () => {
  const one = makeCase();
  const run = await runRunner(['--only', 'E0', '--out', one.out], one.env);
  assert.match(run.stdout, new RegExp(`login: stored account ${ACCOUNT_NAME}`), run.stdout);
  const calls = one.calls();
  assert.ok(calls.some((call) => call.args[0] === 'auth'), 'the preflight ran with the stored login');
  assert.ok(calls.some((call) => call.args.includes('-p')), 'E0 started claude');
  for (const call of calls) {
    assert.equal(call.loginHash, sha256(STORED_TOKEN), call.args.join(' '));
    assert.ok(!call.args.some((arg) => arg.includes(STORED_TOKEN)), 'never in argv');
  }
  const results = JSON.parse(readFileSync(join(one.out, 'results.json'), 'utf8'));
  assert.deepEqual(results.loginFrom, { source: 'store', name: ACCOUNT_NAME });
  assertNowhere(one, run, STORED_TOKEN);
});

test('stored login: a terminal login of no known shape, echoed everywhere by the child, is masked in every kept file', async () => {
  const one = makeCase({ stored: false, terminalToken: PLAIN_TERMINAL_LOGIN });
  const run = await runRunner(['--only', 'E0', '--out', one.out], one.env);
  assert.match(run.stdout, /login: CLAUDE_CODE_OAUTH_TOKEN of this terminal/, run.stdout);
  for (const call of one.calls()) assert.equal(call.loginHash, sha256(PLAIN_TERMINAL_LOGIN), call.args.join(' '));
  assertNowhere(one, run, PLAIN_TERMINAL_LOGIN);
});

test('stored login: an empty store ends the run with exit 2 and the plain line; no claude, no run root', async () => {
  const empty = makeCase({ stored: false });
  const run = await runRunner(['--only', 'E0', '--out', empty.out], empty.env);
  assert.equal(run.code, 2, run.stdout + run.stderr);
  assert.match(run.stdout, new RegExp(`^${NO_ACCOUNT_LINE}$`, 'm'));
  assert.deepEqual(empty.calls(), []);
  assert.deepEqual(empty.runRoots(), []);
  assert.equal(existsSync(empty.out), false);
});

test('stored login: an unreadable store (an account error) ends the run with exit 2; its text holds no token', async () => {
  const broken = makeCase();
  const run = await runRunner(['--only', 'E0', '--out', broken.out], { ...broken.env, CLAUDE_ACCOUNT_STORE: 'made-up-kind' });
  assert.equal(run.code, 2, run.stdout + run.stderr);
  assert.match(run.stdout, new RegExp(`^${NO_ACCOUNT_LINE}$`, 'm'));
  assert.match(run.stdout, /^e2e: the account store was not read: .*CLAUDE_ACCOUNT_STORE/m, 'the reason, in one line');
  assert.ok(!run.stdout.includes(STORED_TOKEN) && !run.stderr.includes(STORED_TOKEN));
  assert.deepEqual([broken.calls(), broken.runRoots()], [[], []]);
});

test('stored login: --no-stored-login reads no store; the children get no token and the line says so', async () => {
  const off = makeCase();
  const run = await runRunner(['--only', 'E0', '--out', off.out, '--no-stored-login'], { ...off.env, CLAUDE_ACCOUNT_STORE: 'made-up-kind' });
  assert.ok(!run.stdout.includes(NO_ACCOUNT_LINE), 'no store was opened (a bad store kind would have refused)');
  assert.match(run.stdout, /login: none passed on \(--no-stored-login\)/);
  assert.ok(off.calls().length > 0);
  for (const call of off.calls()) assert.equal(call.loginHash, null, call.args.join(' '));
});

test('stored login: the dry run reads no store', async () => {
  const dry = makeCase();
  const run = await runRunner(['--dry-run', '--only', 'E0'], { ...dry.env, CLAUDE_ACCOUNT_STORE: 'made-up-kind' });
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.ok(!run.stdout.includes(NO_ACCOUNT_LINE) && !run.stdout.includes('login: stored account'));
  assert.deepEqual(dry.calls(), []);
});
