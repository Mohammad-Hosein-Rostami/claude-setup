// Where a live run's login comes from (review round 3). Exports: NO_ACCOUNT_LINE, ACCOUNTS_MODULE, resolveLogin(spec).
// Why: the nested sessions run under a temp HOME, where Claude Code finds no login, and a Claude session cannot hand its own
// login on. The owner allows an agent to read a saved token from the claude-account store (never to print it), so the runner
// takes, in this order: (1) CLAUDE_CODE_OAUTH_TOKEN of its own env (a `claude-as` terminal); (2) unless `--no-stored-login`,
// accountForCall(env) of the checkout's home/tools/account/lib/accounts.mjs: the account CLAUDE_ACCOUNT names, else the
// owner's default, the same call hook jobs make (claude-call.mjs loginFor). Neither: one plain line, exit 2.
// Invariants: called once, in the runner process, with the real env and HOME, before the temp HOME exists (the dry run never
// calls it); the token is returned only for env.mjs useLogin (child env and redactor); every text returned for printing holds
// the account name and the source, never the token, and an error's message is redacted.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { redact } from './redact.mjs';

/** The one line a run prints when it has no login to pass on. */
export const NO_ACCOUNT_LINE = 'no saved account: the owner runs E0 from a claude-as terminal';
/** The account tool's module, under the checkout under test. */
export const ACCOUNTS_MODULE = Object.freeze(['home', 'tools', 'account', 'lib', 'accounts.mjs']);
const TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';
const DETAIL_CHARS = 200;

const loadAccounts = (setupFrom) => import(pathToFileURL(join(setupFrom, ...ACCOUNTS_MODULE)).href);

/**
 * @param {{env?: object, setupFrom: string, useStore?: boolean, load?: (setupFrom: string) => Promise<{accountForCall: Function}>}} spec
 *   the runner's real env, the checkout under test, false for `--no-stored-login`, and the module loader (tests replace it)
 * @returns {Promise<{ok: true, source: 'env' | 'store' | 'none', name: string | null, token: string | null, line: string}
 *   | {ok: false, source: 'store', line: string, detail: string}>} `line` and `detail` never hold the token
 */
export async function resolveLogin({ env = process.env, setupFrom, useStore = true, load = loadAccounts }) {
  if (env[TOKEN_ENV]) return { ok: true, source: 'env', name: null, token: env[TOKEN_ENV], line: `login: ${TOKEN_ENV} of this terminal` };
  if (!useStore) return { ok: true, source: 'none', name: null, token: null, line: 'login: none passed on (--no-stored-login)' };
  let account = null;
  try {
    const { accountForCall } = await load(setupFrom);
    account = accountForCall(env);
  } catch (error) {
    const detail = redact(`the account store was not read: ${String(error?.message ?? error)}`).slice(0, DETAIL_CHARS);
    return { ok: false, source: 'store', line: NO_ACCOUNT_LINE, detail };
  }
  if (typeof account?.token !== 'string' || account.token === '') {
    return { ok: false, source: 'store', line: NO_ACCOUNT_LINE, detail: 'the store holds no account for this call (CLAUDE_ACCOUNT, else the default)' };
  }
  return { ok: true, source: 'store', name: String(account.name), token: account.token, line: `login: stored account ${account.name}` };
}
