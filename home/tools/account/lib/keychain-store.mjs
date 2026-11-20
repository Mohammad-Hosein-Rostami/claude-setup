// Purpose: the token store of macOS: one generic password per account in the Keychain, service `claude-setup-account`,
// account attribute = the account name.
// Exports: keychainStore, runSecurity, KEYCHAIN_SERVICE.
// Invariants: `/usr/bin/security` (absolute path, never PATH) is started with the one argument `-i` and reads its command
// from stdin, so a token is never a command argument (probe ACC-4, macOS 26.6.2: exit 0, 44 = no such item, 45 =
// duplicate; with two lines on stdin the exit code is the last line's). One call sends one line: name and token are
// checked against their patterns first (no space, quote or newline), and a keychain path is quoted, may hold no
// quote, backslash or newline, and must be an existing file: given a path that does not exist, `security` wrote the item
// into the default (login) keychain instead (seen 2026-11-21, macOS 26.6.2), so nothing is run for one. An error names the exit code only: never stderr, never the command text.
// What it does not defend: any process of the same user can read the item with `security` and no prompt (README).
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { AccountError, assertName, assertToken } from './names.mjs';

const SECURITY = '/usr/bin/security';
export const KEYCHAIN_SERVICE = 'claude-setup-account';
const SECURITY_TIMEOUT_MS = 20000;
const EXIT_NO_SUCH_ITEM = 44;
const EXIT_LOCKED = 36; // "User interaction is not allowed": the login keychain is locked, as in an ssh session (docs; ACC-6 not run)
const UNSAFE_KEYCHAIN_PATH = /["\\\n\r]/;

/**
 * Runs one `security` command, given on stdin.
 * @param {string} line the command line (one line).
 * @param {Function} spawn `spawnSync`, or a test's stand-in.
 * @returns {{status: number | null, stdout: string, stderr: string}} `status` null when it did not end in time.
 */
export function runSecurity(line, spawn = spawnSync) {
  const { status, stdout, stderr } = spawn(SECURITY, ['-i'], { input: `${line}\n`, encoding: 'utf8', timeout: SECURITY_TIMEOUT_MS });
  return { status, stdout: stdout ?? '', stderr: stderr ?? '' };
}

function refused(verb, status) {
  const why = status === EXIT_LOCKED ? ' (the Keychain is locked, as in an ssh session)' : status === null ? ' (it did not answer in time)' : '';
  return new AccountError('store', `the Keychain refused to ${verb} the account${why}: security exit ${status}`);
}

/**
 * @param {{run?: (line: string) => {status: number | null, stdout: string, stderr: string}, keychain?: string | null}} options
 *   `run` replaces `runSecurity` (tests); `keychain` is a keychain file to use in place of the default (login) keychain:
 *   tests and probes pass a scratch file (it must exist), the tool itself never sets it.
 * @returns {{kind: 'keychain', put: Function, get: Function, remove: Function}} as `fileStore`; each method throws
 *   AccountError (`name`, `token`, `store`).
 * @throws {AccountError} kind `store` for a keychain path that cannot be quoted.
 */
export function keychainStore({ run = runSecurity, keychain = null } = {}) {
  if (keychain !== null && UNSAFE_KEYCHAIN_PATH.test(keychain)) throw new AccountError('store', 'the keychain path holds a quote, a backslash or a newline; not used');
  const target = () => {
    if (keychain === null) return '';
    if (!statSync(keychain, { throwIfNoEntry: false })?.isFile()) throw new AccountError('store', 'the keychain file does not exist; nothing was run');
    return ` "${keychain}"`;
  };
  const item = (name) => `-a ${assertName(name)} -s ${KEYCHAIN_SERVICE}`;
  return {
    kind: 'keychain',
    put(name, token) {
      const { status } = run(`add-generic-password -U ${item(name)} -w ${assertToken(token)}${target()}`);
      if (status !== 0) throw refused('store', status);
    },
    get(name) {
      const { status, stdout } = run(`find-generic-password ${item(name)} -w${target()}`);
      if (status === EXIT_NO_SUCH_ITEM) return null;
      if (status !== 0) throw refused('read', status);
      return assertToken(stdout.replace(/\n$/, ''));
    },
    remove(name) {
      const { status } = run(`delete-generic-password ${item(name)}${target()}`);
      if (status === EXIT_NO_SUCH_ITEM) return false;
      if (status !== 0) throw refused('remove', status);
      return true;
    },
  };
}
