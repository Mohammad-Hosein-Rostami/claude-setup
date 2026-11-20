// Purpose: the one library through which code reads and changes the stored accounts: add, remove, list, the owner's
// answers per account (plan, usage credits off, the default), and which account a headless call may spend.
// Exports: addAccount, removeAccount, listAccounts, accountForCall, setDefault, setPlan, setCreditsOff, recordCheck,
// TOKEN_LIFETIME_DAYS.
// Invariants: a token lives in the store only (store.mjs); accounts.json and everything returned by `listAccounts`
// hold names and non-secret fields. `accountForCall` never picks an account by itself: the name in CLAUDE_ACCOUNT,
// else the default the owner set, else none; a name that is reserved (`-`), not a valid name or not stored gives
// none, never the default (the setup never switches accounts by itself, owner 2026-11-19).
import { AccountError, NAME_PATTERN, assertName, assertToken } from './names.mjs';
import { PLANS, readRegistry, writeRegistry } from './registry.mjs';
import { openStore } from './store.mjs';

/** A token of `claude setup-token` lasts one year (authentication docs). */
export const TOKEN_LIFETIME_DAYS = 365;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Changes the fields of one stored account; `change` gets its entry and returns the new one. */
function updateAccount(name, env, change) {
  const registry = readRegistry(env);
  if (!registry.accounts[assertName(name)]) throw new AccountError('unknown', `no account named ${name}`);
  writeRegistry({ ...registry, accounts: { ...registry.accounts, [name]: change(registry.accounts[name]) } }, env);
}

/**
 * Stores a token under a name (replacing an older one) and lists the account.
 * @param {string} name the account name.
 * @param {string} token the token.
 * @param {{env?: object, store?: object, now?: Date, checked?: string | null}} options `checked` is the result of the
 *   validity check the caller made (`valid`, `check failed: <class>`), kept with its time.
 * @throws {AccountError} kind `name` or `token` before anything is written; the store's own errors.
 */
export function addAccount(name, token, { env = process.env, store = openStore(env), now = new Date(), checked = null } = {}) {
  assertName(name);
  assertToken(token);
  const registry = readRegistry(env);
  store.put(name, token);
  const at = now.toISOString();
  const entry = { plan: null, creditsOff: false, ...registry.accounts[name], added: at, checked: checked === null ? null : { at, result: checked } };
  writeRegistry({ ...registry, accounts: { ...registry.accounts, [name]: entry } }, env);
}

/**
 * Removes the token and the account's fields; clears the default when it was this account.
 * @returns {boolean} false when there was no such account.
 */
export function removeAccount(name, { env = process.env, store = openStore(env) } = {}) {
  assertName(name);
  const registry = readRegistry(env);
  const hadToken = store.remove(name);
  if (!registry.accounts[name]) return hadToken;
  const { [name]: removed, ...accounts } = registry.accounts;
  writeRegistry({ default: registry.default === name ? null : registry.default, accounts }, env);
  return true;
}

/** Whether this terminal uses the account: its CLAUDE_ACCOUNT names it and its token equals the stored one (compared here, never printed). */
function terminalUse(name, env, store) {
  if (env.CLAUDE_ACCOUNT !== name) return 'no';
  return env.CLAUDE_CODE_OAUTH_TOKEN && store.get(name) === env.CLAUDE_CODE_OAUTH_TOKEN ? 'yes' : 'name only';
}

/**
 * @param {{env?: object, store?: object, now?: Date}} options
 * @returns {{name: string, added: string, daysLeft: number, plan: string | null, creditsOff: boolean, checked: object | null, isDefault: boolean, inThisTerminal: 'yes' | 'no' | 'name only'}[]}
 *   one row per account, by name; never a token. The store is read only for the account CLAUDE_ACCOUNT names.
 */
export function listAccounts({ env = process.env, store = openStore(env), now = new Date() } = {}) {
  const registry = readRegistry(env);
  return Object.keys(registry.accounts).sort().map((name) => {
    const { added, plan, creditsOff, checked } = registry.accounts[name];
    const daysLeft = TOKEN_LIFETIME_DAYS - Math.floor((now.getTime() - Date.parse(added)) / MS_PER_DAY);
    return { name, added, daysLeft, plan, creditsOff, checked, isDefault: registry.default === name, inThisTerminal: terminalUse(name, env, store) };
  });
}

/**
 * The account a headless call (a hook's `claude -p`) may spend when its own environment has no token.
 * @param {object} env the caller's environment: `CLAUDE_ACCOUNT` (set by `claude-as`), the variables of `accountsDir`.
 * @param {object | null} store a store to read, or null to open this machine's (only once a name is found).
 * @returns {{name: string, token: string} | null} null when no account may be spent.
 * @throws {AccountError} when the account list or the store cannot be read (a locked Keychain).
 */
export function accountForCall(env = process.env, store = null) {
  const named = env.CLAUDE_ACCOUNT;
  // Not a name: `-` (a `claude-as --once` terminal) or hostile text. No store call, and never the default in its place.
  if (named && !NAME_PATTERN.test(named)) return null;
  const name = named || readRegistry(env).default;
  if (!name) return null;
  const token = (store ?? openStore(env)).get(name);
  return token === null ? null : { name, token };
}

/** Sets the default account (`null` for none). @throws {AccountError} kind `unknown` for a name that is not stored. */
export function setDefault(name, { env = process.env } = {}) {
  const registry = readRegistry(env);
  if (name !== null && !registry.accounts[assertName(name)]) throw new AccountError('unknown', `no account named ${name}`);
  writeRegistry({ ...registry, default: name }, env);
}

/** Records the plan the owner says the account is on. @throws {AccountError} kind `usage` for a plan that is not one of PLANS. */
export function setPlan(name, plan, { env = process.env } = {}) {
  if (!PLANS.includes(plan)) throw new AccountError('usage', `a plan is one of: ${PLANS.join(', ')}`);
  updateAccount(name, env, (entry) => ({ ...entry, plan }));
}

/** Records that the owner said usage credits are off on the account. */
export function setCreditsOff(name, { env = process.env } = {}) {
  updateAccount(name, env, (entry) => ({ ...entry, creditsOff: true }));
}

/** Records the result of a validity check (`valid`, `revoked`, `check failed: <class>`) with its time. */
export function recordCheck(name, result, { env = process.env, now = new Date() } = {}) {
  updateAccount(name, env, (entry) => ({ ...entry, checked: { at: now.toISOString(), result } }));
}
