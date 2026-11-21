// Helpers for the account tests and tests/claude-call.test.mjs (not a test file).
// Exports: fakeToken, tokenHash, accountSandbox, memoryStore, filesHolding, assertNoLeak, runInPty, SHELLS, PTY_PLATFORM.
// What they give: made-up tokens of the real shape (built from parts, so no secret scanner sees a literal), a sandbox on
// top of `fakeStack` of recall-fakes.mjs (a temp HOME and TMPDIR, the 0600 file store, a fake `claude` that also logs a
// hash of the token it was given, never the token), an in-memory store that records its reads, a scan that finds a token
// in any file of the sandbox (K10: after every test the token is only in the store), and a pseudo-terminal runner
// (`script`) for the hidden prompt and the terminal refusals.
// Invariants: no real token, Keychain item or state folder is read; nothing here asserts elapsed time.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeStack } from './recall-fakes.mjs';

const TOKEN_PREFIX = ['sk', 'ant', 'oat01', ''].join('-');
const TOKEN_BODY_CHARS = 80;
const SCAN_MAX_BYTES = 8 * 1024 * 1024;
const PTY_TIMEOUT_MS = 120000;
const SESSION_VARIABLES = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_ACCOUNT', 'CLAUDE_ACCOUNT_DIR', 'CLAUDE_CONFIG_DIR', 'ZDOTDIR'];

/** A made-up token of the real shape; `word` tells two of them apart. */
export const fakeToken = (word) => `${TOKEN_PREFIX}${`MadeUp${word}`.repeat(TOKEN_BODY_CHARS).slice(0, TOKEN_BODY_CHARS)}`;

/** What the fake `claude` logs in place of the token it was given. */
export const tokenHash = (token) => createHash('sha256').update(token).digest('hex');

const FAKE_LOG_LINE = 'JSON.stringify({ args: process.argv.slice(2), stdin })';
const FAKE_LOG_LINE_WITH_LOGIN = "JSON.stringify({ args: process.argv.slice(2), stdin, account: process.env.CLAUDE_ACCOUNT ?? null, tokenHash: process.env.CLAUDE_CODE_OAUTH_TOKEN ? createHash('sha256').update(process.env.CLAUDE_CODE_OAUTH_TOKEN).digest('hex') : null })";
const FAKE_ERROR_MODE = "if (mode === 'error')";
const FAKE_LOGIN_MODES = `if (mode === 'revoked') { reply('Failed to authenticate. API Error: 401 OAuth token has been revoked.', { is_error: true }); process.exit(0); }
if (mode === 'limit') { reply('You have hit your usage limit. It resets at 3am.', { is_error: true }); process.exit(0); }
if (mode === 'leak') { console.error('debug: my token is ' + process.env.CLAUDE_CODE_OAUTH_TOKEN); process.exit(1); }
if (mode === 'slow') { writeFileSync('/dev/tty', 'CHECK-STARTED\\n'); await new Promise((done) => setTimeout(done, 60000)); }
`;

/**
 * Teaches the fake `claude` of recall-fakes.mjs to log who it ran as and to answer as a revoked or limited account; `slow`
 * says CHECK-STARTED on the terminal and then waits a minute (a check to interrupt with Ctrl-C).
 */
function patchFakeClaude(path) {
  const original = readFileSync(path, 'utf8');
  const patched = original
    .replace("import { appendFileSync", "import { createHash } from 'node:crypto';\nimport { appendFileSync")
    .replace(FAKE_LOG_LINE, FAKE_LOG_LINE_WITH_LOGIN)
    .replace(FAKE_ERROR_MODE, `${FAKE_LOGIN_MODES}${FAKE_ERROR_MODE}`);
  for (const part of ["from 'node:crypto'", 'tokenHash', "mode === 'revoked'"]) assert.ok(patched.includes(part), `the fake claude of recall-fakes.mjs changed: ${part} not patched in`);
  writeFileSync(path, patched);
}

/**
 * A sandbox for one test: the fake stack of recall-fakes.mjs with a temp HOME and TMPDIR, the file store forced, no
 * session variable of the test runner's own terminal, and a script that prints a hash of the shell's token.
 * @returns {object} `fakeStack`'s fields plus `home`, `storeDir`, `envPrint` and an `env` to pass to every child.
 */
export function accountSandbox({ claudeMode = 'ok' } = {}) {
  const stack = fakeStack({ claudeMode });
  patchFakeClaude(join(stack.bin, 'claude'));
  const home = join(stack.dir, 'home');
  const tmp = join(stack.dir, 'tmp');
  mkdirSync(home);
  mkdirSync(tmp);
  const env = { ...stack.env, HOME: home, USERPROFILE: home, TMPDIR: tmp, CLAUDE_ACCOUNT_STORE: 'file' };
  for (const name of SESSION_VARIABLES) delete env[name];
  const envPrint = join(stack.dir, 'env-print.mjs');
  writeFileSync(envPrint, "import { createHash } from 'node:crypto';\nconst token = process.env.CLAUDE_CODE_OAUTH_TOKEN;\nconsole.log(`ENV ${token ? createHash('sha256').update(token).digest('hex') : 'none'} ${process.env.CLAUDE_ACCOUNT ?? 'none'}`);\n");
  return { ...stack, env, home, envPrint, storeDir: join(home, '.config', 'claude-setup', 'accounts') };
}

/** A store kept in memory; `reads` lists every name that was asked for. */
export function memoryStore(entries = {}) {
  const tokens = new Map(Object.entries(entries));
  const reads = [];
  return {
    kind: 'memory', reads,
    get: (name) => { reads.push(name); return tokens.get(name) ?? null; },
    put: (name, token) => { tokens.set(name, token); },
    remove: (name) => tokens.delete(name),
  };
}

/** Every regular file under `root` (links are not followed) whose bytes hold `needle`. */
export function filesHolding(root, needle) {
  const found = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = lstatSync(path);
    if (stat.isDirectory()) found.push(...filesHolding(path, needle));
    else if (stat.isFile() && stat.size <= SCAN_MAX_BYTES && readFileSync(path, 'latin1').includes(needle)) found.push(path);
  }
  return found;
}

/** K10: each token is in no file of the sandbox except a `.token` file of the store folder. */
export function assertNoLeak(sandbox, tokens) {
  for (const token of tokens) {
    const outside = filesHolding(sandbox.dir, token).filter((path) => !(path.startsWith(`${sandbox.storeDir}/`) && path.endsWith('.token')));
    assert.deepEqual(outside, [], 'a token was written outside the store');
  }
}

/** The shells the snippet must run under, of those this machine has: [label, path, flags]. */
export const SHELLS = [['bash', '/bin/bash', []], ['zsh', '/bin/zsh', ['-f']]].filter(([, path]) => existsSync(path));

/** True where `script` can give a child a pseudo-terminal the way `runInPty` calls it. */
export const PTY_PLATFORM = ['darwin', 'linux'].includes(process.platform) && existsSync('/usr/bin/script') && existsSync('/bin/bash');
// `script` of macOS refuses a socket as stdin, and Node's pipes are sockets: `cat` in between gives it a real pipe.
const PTY_WRAPPER = 'exec /usr/bin/script "$@" < <(/bin/cat 2>/dev/null)';

const shellQuote = (word) => `'${word.replace(/'/g, "'\\''")}'`;

/**
 * Runs a command on a pseudo-terminal and types `steps` into it: each `send` is written once `wait` shows up in the
 * output that came after the step before.
 * @param {string[]} command the program and its arguments.
 * @param {{env: object, steps?: {wait: string, send: string}[]}} options
 * @returns {Promise<{output: string, code: number}>} everything the terminal showed and the exit code.
 */
export function runInPty(command, { env, steps = [] }) {
  const args = process.platform === 'darwin' ? ['-q', '/dev/null', ...command] : ['-qec', command.map(shellQuote).join(' '), '/dev/null'];
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', ['-c', PTY_WRAPPER, 'pty', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let seen = 0;
    const pending = [...steps];
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`the terminal run did not end; waiting for ${JSON.stringify(pending[0]?.wait ?? 'exit')}`)); }, PTY_TIMEOUT_MS);
    const onData = (chunk) => {
      output += chunk;
      while (pending.length > 0 && output.indexOf(pending[0].wait, seen) !== -1) {
        seen = output.length;
        child.stdin.write(pending.shift().send);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.stdin.on('error', () => {}); // the terminal may be gone before the last write; `close` reports the run
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); child.stdin.end(); resolve({ output, code }); });
  });
}
