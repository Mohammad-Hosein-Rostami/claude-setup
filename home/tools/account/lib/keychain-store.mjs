// Purpose: the token store of macOS: one generic password per account in the Keychain, service `claude-setup-account`,
// account attribute = the account name.
// Exports: keychainStore, runSecurity, KEYCHAIN_SERVICE.
// Invariants: `/usr/bin/security` (absolute path, never PATH) is started with the one argument `-i` and reads its command
// from stdin, so a token is never a command argument (probe ACC-4, macOS 26.6.2: exit 0, 44 = no such item, 45 =
// duplicate; with two lines on stdin the exit code is the last line's). One call sends one line: name and token are
// checked against their patterns first (no space, quote or newline), and a keychain path is quoted, may hold no
// quote, backslash or newline, and must be an existing regular file with no link in any part of its path: given a path that does not exist, `security` wrote the item
// into the default (login) keychain instead (seen 2026-11-21, macOS 26.6.2), so nothing is run for one. `security` opens
// the file by its path in a second step, so the file's identity (device and inode) is noted at the check and compared
// again when `security` has ended: a file swapped, moved or linked in between makes the call fail, and a read's answer is
// not handed on. An error names the exit code only: never stderr, never the command text.
// What it does not defend: any process of the same user can read the item with `security` and no prompt (README); a
// swap that is put back before `security` ends is not seen (only the path can be given to `security`, not an open file).
import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { AccountError, assertName, assertToken } from './names.mjs';

const SECURITY = '/usr/bin/security';
export const KEYCHAIN_SERVICE = 'claude-setup-account';
/** How long one `security` call may take before it is ended (its status is then null). */
export const SECURITY_TIMEOUT_MS = 20000;
const EXIT_NO_SUCH_ITEM = 44;
const EXIT_LOCKED = 36; // "User interaction is not allowed": the login keychain is locked, as in an ssh session (docs; ACC-6 not run)
const UNSAFE_KEYCHAIN_PATH = /["\\\n\r]/;

/**
 * Runs one `security` command, given on stdin.
 * @param {string} line the command line (one line).
 * @param {Function} spawn `spawnSync`, or a stand-in (a test's, or doctor's, which ends the call sooner).
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
 * The identity of the keychain file, or why it may not be given to `security`: only an absolute path to a regular file
 * with no link in any part of it (`lstat` sees only the last part; the real path of the file must be the path itself),
 * because `security` resolves a bare name in ~/Library/Keychains and falls back to the login keychain for a file it
 * cannot open (security review 1, S6).
 * @param {string} keychain the path given to the store.
 * @returns {{id: string} | {why: string}} `id` is `<device>:<inode>`.
 */
function keychainFileState(keychain) {
  if (!isAbsolute(keychain)) return { why: 'the keychain path is not absolute' };
  const stat = lstatSync(keychain, { bigint: true, throwIfNoEntry: false });
  if (!stat?.isFile()) return { why: 'the keychain file does not exist or is not a regular file (a link?)' };
  if (realpathSync(keychain) !== keychain) return { why: 'the keychain path has a link or a relative part in it' };
  return { id: `${stat.dev}:${stat.ino}` };
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
  // Runs `command` with the keychain file named last; the file is checked right before the call and again after it.
  const call = (command, verb) => {
    if (keychain === null) return run(command);
    const before = keychainFileState(keychain);
    if ('why' in before) throw new AccountError('store', `${before.why}; nothing was run`);
    const result = run(`${command} "${keychain}"`);
    const after = keychainFileState(keychain);
    if ('why' in after || after.id !== before.id) {
      throw new AccountError('store', `the keychain file was swapped, moved or linked while security ran; the ${verb} is not trusted (it may have reached another keychain)`);
    }
    return result;
  };
  const item = (name) => `-a ${assertName(name)} -s ${KEYCHAIN_SERVICE}`;
  return {
    kind: 'keychain',
    put(name, token) {
      const { status } = call(`add-generic-password -U ${item(name)} -w ${assertToken(token)}`, 'write');
      if (status !== 0) throw refused('store', status);
    },
    get(name) {
      const { status, stdout } = call(`find-generic-password ${item(name)} -w`, 'read');
      if (status === EXIT_NO_SUCH_ITEM) return null;
      if (status !== 0) throw refused('read', status);
      return assertToken(stdout.replace(/\n$/, ''));
    },
    remove(name) {
      const { status } = call(`delete-generic-password ${item(name)}`, 'removal');
      if (status === EXIT_NO_SUCH_ITEM) return false;
      if (status !== 0) throw refused('remove', status);
      return true;
    },
  };
}
