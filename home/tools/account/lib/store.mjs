// Purpose: pick the token store of this machine: the Keychain on macOS, the 0600 file store on Linux (and any other
// system), DPAPI-protected files on Windows (not verified).
// Exports: openStore.
// Invariants: every store has the same four members (kind, put, get, remove) and checks names and tokens itself;
// `CLAUDE_ACCOUNT_STORE=file` forces the file store on any system (the tests use it, and it is the kind Claude Code
// itself falls back to when the Keychain refuses a write); no other value is accepted.
import { dpapiStore } from './dpapi-store.mjs';
import { fileStore } from './file-store.mjs';
import { keychainStore } from './keychain-store.mjs';
import { AccountError } from './names.mjs';
import { accountsDir } from './registry.mjs';

const FORCED_KIND = 'file';
const kindOf = (platform) => (platform === 'darwin' ? 'keychain' : platform === 'win32' ? 'dpapi' : 'file');

/**
 * @param {object} env `CLAUDE_ACCOUNT_STORE` (only `file`) and the variables of `accountsDir`.
 * @param {{platform?: string}} options `platform` stands in for `process.platform` (tests).
 * @returns {{kind: string, put: (name: string, token: string) => void, get: (name: string) => string | null, remove: (name: string) => boolean}}
 * @throws {AccountError} kind `store` for a forced kind other than `file`.
 */
export function openStore(env = process.env, { platform = process.platform } = {}) {
  const forced = env.CLAUDE_ACCOUNT_STORE;
  if (forced && forced !== FORCED_KIND) throw new AccountError('store', `CLAUDE_ACCOUNT_STORE can only be "${FORCED_KIND}"`);
  const kind = forced || kindOf(platform);
  if (kind === 'keychain') return keychainStore();
  return kind === 'dpapi' ? dpapiStore(accountsDir(env)) : fileStore(accountsDir(env));
}
