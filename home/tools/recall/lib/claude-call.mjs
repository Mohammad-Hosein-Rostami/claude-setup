// Purpose: one headless Haiku call over the Claude subscription (`claude -p`), used by the checkpoint job and by the
// account tool's validity check (home/tools/account/lib/check.mjs).
// Exports: callHaiku, HAIKU_ARGS, claudePlan.
// Login (spec-accounts K1, K2, K13): Claude Code removes CLAUDE_CODE_OAUTH_TOKEN from the environment of hooks (probe
// ACC-9a, CLI 2.1.329), and a `claude -p` child that is given the variable uses it (probe (a2)). So the child's token
// is, in this order: the account the caller passes, the token of this process's own environment, else the stored token
// of the account CLAUDE_ACCOUNT names, else of the default account (home/tools/account/lib/accounts.mjs). With none of
// these NO child is started: a token-less `claude -p` would spend whatever login is stored in the Keychain (#108645).
// One usage row `{account: null, error: "auth", is_error: true}` is written and the error has `kind: "auth"`. The token
// goes to the child in its environment only, and is cut out of any error text; the row names the account, never a token.
// One call, one account: after an auth or usage-limit error no other account is tried.
// Invariants: never an API key (no --bare; every ANTHROPIC_* variable and the Bedrock / Vertex switches are removed from the child env; `--setting-sources ''`
// loads no user, project or local settings, verified in CLI 2.1.323 to keep the subscription login: apiKeySource "none"); no tools, no MCP, no skills, hooks disabled and no session transcript is
// written (--no-session-persistence, verified in CLI 2.1.x), so the call cannot trigger the checkpoint hook again or
// leave a session behind; the working directory is an empty folder in the state dir and CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 (no CLAUDE.md is loaded);
// on Windows the npm install is `claude.cmd`, which Node can only start through a shell, so there every argument is quoted and the
// (free-text) system prompt goes through a file, never through the command line;
// every attempt, failed or not, is logged to usage.jsonl; an error reply or unreadable output throws.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { accountForCall } from '../../account/lib/accounts.mjs';
import { AccountError, NAME_PATTERN } from '../../account/lib/names.mjs';
import { stateDir } from './paths.mjs';
import { PRIVATE_FILE_MODE, ensurePrivateDir } from './private-fs.mjs';
import { logUsage } from './usage.mjs';

const CALL_TIMEOUT_MS = 240000;
const STDERR_CHARS = 200;
const TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';
const NO_LOGIN = 'no token in the environment and no account found (pick one in the terminal: claude-as <name>)';
// Variables that would move the call from the Claude subscription to API billing, Bedrock, Vertex or another endpoint.
const BILLING_ENV = /^(?:ANTHROPIC_.*|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|AWS_BEARER_TOKEN_BEDROCK)$/;
export const HAIKU_ARGS = ['-p', '--model', 'haiku', '--output-format', 'json', '--strict-mcp-config', '--disable-slash-commands',
  '--settings', '{"disableAllHooks":true}', '--setting-sources', '', '--no-session-persistence', '--tools', ''];

const SYSTEM_PROMPT_FILE = 'system-prompt.txt';
const quoteForCmd = (arg) => `"${arg.replace(/"/g, '\\"')}"`;

/**
 * How to start `claude`: a plain `claude` elsewhere; on win32 `claude.cmd` through a shell (Node cannot spawn a .cmd
 * directly) with every argument quoted and the system prompt passed as `--system-prompt-file <cwd>/system-prompt.txt`.
 * @param {string} platform `process.platform`.
 * @param {string} system the system prompt.
 * @param {string} cwd the child's working directory (holds the prompt file on win32).
 * @returns {{command: string, args: string[], shell: boolean, systemFile: string | null}} `systemFile` is the path the caller must write `system` to.
 */
export function claudePlan(platform, system, cwd) {
  if (platform !== 'win32') return { command: 'claude', args: [...HAIKU_ARGS, '--system-prompt', system], shell: false, systemFile: null };
  const systemFile = join(cwd, SYSTEM_PROMPT_FILE);
  return { command: 'claude.cmd', args: [...HAIKU_ARGS, '--system-prompt-file', systemFile].map(quoteForCmd), shell: true, systemFile };
}

function runClaude(prompt, system, env, cwd) {
  return new Promise((resolve, reject) => {
    const plan = claudePlan(process.platform, system, cwd);
    if (plan.systemFile) writeFileSync(plan.systemFile, system, { mode: PRIVATE_FILE_MODE });
    const child = spawn(plan.command, plan.args, { cwd, env, shell: plan.shell, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`claude timed out after ${CALL_TIMEOUT_MS / 1000}s`)); }, CALL_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.once('error', (error) => { clearTimeout(timer); reject(new Error(error.code === 'ENOENT' ? 'claude is not on PATH' : error.message)); });
    child.once('close', (code) => {
      clearTimeout(timer);
      try {
        resolve({ json: JSON.parse(out), code });
      } catch {
        reject(new Error(`claude exited ${code} without JSON: ${err.slice(0, STDERR_CHARS) || out.slice(0, STDERR_CHARS)}`));
      }
    });
    child.stdin.on('error', () => {}); // the child may exit before reading the prompt; `close` reports why
    child.stdin.end(prompt);
  });
}

/**
 * Whose token the child gets: the caller's account, else this environment's own token (named by CLAUDE_ACCOUNT when
 * that is a valid name), else the stored account `accountForCall` finds.
 * @returns {{name: string | null, token: string} | null} null when there is none.
 * @throws {AccountError} when the account list or the store cannot be read.
 */
function loginFor(env, account, store) {
  if (account) return account;
  if (env[TOKEN_ENV]) return { name: NAME_PATTERN.test(env.CLAUDE_ACCOUNT ?? '') ? env.CLAUDE_ACCOUNT : null, token: env[TOKEN_ENV] };
  return accountForCall(env, store);
}

/** The login, or: one `auth` row and an error of kind `auth`, with no child started. */
function requireLogin({ session, label, attempt, env, account, store }) {
  let login = null;
  let why = NO_LOGIN;
  try {
    login = loginFor(env, account, store);
  } catch (error) {
    if (!(error instanceof AccountError)) throw error;
    why = error.message;
  }
  if (login) return login;
  logUsage({ session, label, attempt, account: null, error: 'auth', is_error: true }, env);
  throw Object.assign(new Error(`claude was not started: ${why}`), { kind: 'auth' });
}

/**
 * Ask Haiku one question.
 * @param {{system: string, prompt: string, session?: string, label?: string, attempt?: number, env?: object,
 *   account?: {name: string | null, token: string} | null, store?: object | null}} call `account` is a token to use
 *   whatever the environment holds (the account tool's check); `store` replaces this machine's account store (tests).
 * @returns {Promise<{text: string, usage: object, ms: number}>} the reply text and the raw `usage` of the call.
 * @throws when there is no login (`kind: "auth"`, no child started), claude is missing, times out, returns unreadable
 *   output, or reports `is_error`. No message holds the token.
 */
export async function callHaiku({ system, prompt, session = null, label = 'checkpoint', attempt = 0, env = process.env, account = null, store = null }) {
  const login = requireLogin({ session, label, attempt, env, account, store });
  const withoutToken = (text) => text.split(login.token).join('<token>');
  const cwd = join(stateDir(env), 'haiku-cwd');
  ensurePrivateDir(cwd);
  const started = Date.now();
  // CLAUDE_CODE_DISABLE_CLAUDE_MDS keeps the owner's global CLAUDE.md out of the call (measured: 3.6k -> 0.4k input tokens).
  const childEnv = { ...env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', [TOKEN_ENV]: login.token };
  for (const name of Object.keys(childEnv)) if (BILLING_ENV.test(name)) delete childEnv[name];
  const { json } = await runClaude(prompt, system, childEnv, cwd).catch((error) => { throw new Error(withoutToken(error.message)); });
  const usage = json.usage ?? {};
  logUsage({
    session, label, attempt, account: login.name, model: Object.keys(json.modelUsage ?? {})[0] ?? 'haiku',
    input: usage.input_tokens ?? 0, cache_creation: usage.cache_creation_input_tokens ?? 0, cache_read: usage.cache_read_input_tokens ?? 0,
    output: usage.output_tokens ?? 0, cost_usd_list: json.total_cost_usd ?? 0, ms: Date.now() - started, is_error: Boolean(json.is_error),
  }, env);
  if (json.is_error) throw new Error(withoutToken(`claude reported an error: ${String(json.result).slice(0, STDERR_CHARS)}`));
  return { text: String(json.result ?? ''), usage, ms: Date.now() - started };
}
