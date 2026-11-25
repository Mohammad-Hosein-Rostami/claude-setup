// Purpose: which Claude account a long run spends (spec 7.5, owner decision O6) and the token of that account, read in process.
// Exports: AccountRefusal, startAccount, requireCreditsOff, accountToken.
// Invariants: the job file names no account; a run takes the account selected when it starts (CLAUDE_ACCOUNT, else the default the
//   owner set) and keeps it until `resume --account` switches it, whatever the terminal uses then; `-` (a `claude-as --once`
//   terminal) is refused because a later resume could not find its token; an account whose usage credits are not recorded off is
//   refused at every start and resume; the token goes only into the child's environment and is never returned with the name in any
//   printed text.
import { NAME_PATTERN } from '../../account/lib/names.mjs';
import { readRegistry } from '../../account/lib/registry.mjs';
import { openStore } from '../../account/lib/store.mjs';

/** The account cannot be used; the message names the fix. */
export class AccountRefusal extends Error {}

/**
 * The account a new run records.
 * @param {object} env the starting environment (CLAUDE_ACCOUNT, the account folder variables).
 * @returns {string} the account name, checked: stored and with usage credits recorded off.
 * @throws {AccountRefusal} for `-`, a name that is not stored, no account and no default, or credits not recorded off.
 */
export function startAccount(env = process.env) {
  const named = env.CLAUDE_ACCOUNT;
  if (named === '-') throw new AccountRefusal('this terminal uses a one-time token (claude-as --once), which a later resume could not find: pick a stored account first: claude-as <name>');
  if (named && !NAME_PATTERN.test(named)) throw new AccountRefusal('CLAUDE_ACCOUNT is not an account name: pick an account first: claude-as <name>');
  const registry = readRegistry(env);
  const name = named || registry.default;
  if (!name) throw new AccountRefusal('no account selected and no default: pick an account first: claude-as <name>');
  requireCreditsOff(name, env, registry);
  return name;
}

/**
 * @param {string} name the account.
 * @param {object} env the account folder variables.
 * @param {object} registry readRegistry's result (read again when not given).
 * @throws {AccountRefusal} when the account is not stored or its usage credits are not recorded off.
 */
export function requireCreditsOff(name, env = process.env, registry = readRegistry(env)) {
  const entry = registry.accounts[name];
  if (!entry) throw new AccountRefusal(`account ${name} is gone from the store (or was never added): add it with claude-as ${name}, or use another stored account (a run moves to it with resume --account <name>)`);
  if (entry.creditsOff !== true) throw new AccountRefusal(`record that usage credits are off for this account first: claude-account credits-off ${name}`);
}

/**
 * The token of the recorded account, for one child start.
 * @param {string} name the account recorded in run.json.
 * @param {{env?: object, store?: object}} options `store` replaces this machine's store (tests use the file store through env).
 * @returns {string} the token (never printed by any caller).
 * @throws {AccountRefusal} when the account is gone, its credits are not recorded off, or the store has no token for it.
 */
export function accountToken(name, { env = process.env, store = null } = {}) {
  if (!NAME_PATTERN.test(name ?? '')) throw new AccountRefusal('the run records no valid account name');
  requireCreditsOff(name, env);
  const token = (store ?? openStore(env)).get(name);
  if (token === null) throw new AccountRefusal(`account ${name} is gone from the store: add it again with claude-as ${name}, then resume`);
  return token;
}
