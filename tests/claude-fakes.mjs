// A fake `claude` for the account tests (not a test file), installed on a private PATH so no real Haiku call is ever made.
// Exports: fakeStack({ claudeMode, patch }) -> { dir, bin, env, claudeCalls }.
// `claude` behaviour is chosen per call with FAKE_CLAUDE_MODE (ok | bad | error); every call is appended to $FAKE_CLAUDE_LOG as
// one JSON line {args, stdin}. The env points ACCOUNT_STATE_DIR (usage log, the call's working folder) into the sandbox.
// On POSIX `bin/claude` is a symlink to one shared, read-only copy of the (patched) script (shared-tools.mjs: no first-run check
// per test); everything per test reaches it through the env. win32 writes the file per test, as before.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { linkSharedTool } from './shared-tools.mjs';
import { cleanEnv } from './clean-env.mjs';

// A made-up token (built from parts, so no secret scanner sees a literal): `callHaiku` starts no `claude` without a login.
const FAKE_LOGIN_TOKEN = ['sk', 'ant', 'oat01', 'MadeUpClaudeFakeStackToken0000'].join('-');

const FAKE_CLAUDE = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args: process.argv.slice(2), stdin }) + '\\n');
const mode = process.env.FAKE_CLAUDE_MODE || 'ok';
const counter = process.env.FAKE_CLAUDE_LOG + '.count';
const n = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1;
writeFileSync(counter, String(n));
const reply = (result, extra = {}) => console.log(JSON.stringify({ type: 'result', is_error: false, result, usage: { input_tokens: 400, output_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, modelUsage: { 'claude-haiku-fake': {} }, total_cost_usd: 0.001, ...extra }));
if (mode === 'error') { reply('boom', { is_error: true }); process.exit(0); }
if (mode === 'bad') { reply('Sure! (not JSON)'); process.exit(0); }
reply('ok');
`;

/**
 * A sandbox: the fake claude on a private PATH, a state folder and the terminal's (made-up) login.
 * @param {{ claudeMode?: string, patch?: (script: string) => string }} [options] the FAKE_CLAUDE_MODE of every call; `patch` turns
 *   the fake's script into the one this test runs (default: unchanged).
 * @returns {{dir: string, bin: string, env: object, claudeCalls: () => object[]}}
 */
export function fakeStack({ claudeMode = 'ok', patch = (script) => script } = {}) {
  const dir = makeTempDir('claude-stack-');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const script = patch(FAKE_CLAUDE);
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'claude'), script);
    chmodSync(join(bin, 'claude'), 0o755);
  } else linkSharedTool(bin, 'claude', script);
  const claudeLog = join(dir, 'claude.log');
  writeFileSync(claudeLog, '');
  const env = cleanEnv({
    PATH: `${bin}${delimiter}${process.env.PATH}`, ACCOUNT_STATE_DIR: join(dir, 'state'),
    FAKE_CLAUDE_LOG: claudeLog, FAKE_CLAUDE_MODE: claudeMode,
    CLAUDE_CODE_OAUTH_TOKEN: FAKE_LOGIN_TOKEN, // the terminal's login; never the real one of the shell that runs the tests
  });
  const lines = (path) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { dir, bin, env, claudeCalls: () => lines(claudeLog) };
}
