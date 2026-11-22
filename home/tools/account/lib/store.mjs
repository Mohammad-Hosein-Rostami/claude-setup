// Purpose: pick the token store of this machine: the Keychain on macOS, the 0600 file store on Linux (and any other
// system), DPAPI-protected files on Windows (not verified).
// Exports: openStore, storeKind.
// Invariants: every store has the same four members (kind, put, get, remove) and checks names and tokens itself;
// `CLAUDE_ACCOUNT_STORE=file` forces the file store on any system (the tests use it, and it is the kind Claude Code
// itself falls back to when the Keychain refuses a write); no other value is accepted. The login Keychain is opened only
// for this user with the real HOME and outside a test run (NODE_TEST_CONTEXT): a test or a temp HOME that forgot
// CLAUDE_ACCOUNT_STORE=file is refused instead of reaching the owner's Keychain (security review 1, S7).
import { dpapiStore } from './dpapi-store.mjs';
import { fileStore } from './file-store.mjs';
import { keychainStore } from './keychain-store.mjs';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { AccountError } from './names.mjs';
import { accountsDir } from './registry.mjs';

const FORCED_KIND = 'file';

/** The store kind of a platform with no forced kind: `keychain` on macOS, `dpapi` on Windows, else `file`. */
export const storeKind = (platform) => (platform === 'darwin' ? 'keychain' : platform === 'win32' ? 'dpapi' : 'file');

function assertRealUser(env) {
  const testRun = env.NODE_TEST_CONTEXT || process.env.NODE_TEST_CONTEXT;
  if (testRun || resolve(env.HOME ?? '') !== resolve(userInfo().homedir)) {
    throw new AccountError('store', 'the login Keychain is used only with this user\'s real HOME and never in a test run; set CLAUDE_ACCOUNT_STORE=file');
  }
}

/**
 * @param {object} env `CLAUDE_ACCOUNT_STORE` (only `file`) and the variables of `accountsDir`.
 * @param {{platform?: string}} options `platform` stands in for `process.platform` (tests).
 * @returns {{kind: string, put: (name: string, token: string) => void, get: (name: string) => string | null, remove: (name: string) => boolean}}
 * @throws {AccountError} kind `store` for a forced kind other than `file`, and for the login Keychain under a test or
 *   a HOME that is not this user's home.
 */
export function openStore(env = process.env, { platform = process.platform } = {}) {
  const forced = env.CLAUDE_ACCOUNT_STORE;
  if (forced && forced !== FORCED_KIND) throw new AccountError('store', `CLAUDE_ACCOUNT_STORE can only be "${FORCED_KIND}"`);
  const kind = forced || storeKind(platform);
  if (kind === 'keychain') {
    assertRealUser(env);
    return keychainStore();
  }
  return kind === 'dpapi' ? dpapiStore(accountsDir(env)) : fileStore(accountsDir(env));
}
