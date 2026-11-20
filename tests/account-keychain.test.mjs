// Tests for the macOS Keychain store against the real /usr/bin/security (probe ACC-4) and a scratch keychain file, passed
// as an explicit path: the login keychain is never read or changed, and `security list-keychains` is the same before and
// after. Defined on macOS only (by platform; other systems have no `security`). The token is a made-up one, the account
// names are made per run, and each test ends by asking the default search list (attributes only) for them: not found.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { KEYCHAIN_SERVICE, keychainStore, runSecurity } from '../home/tools/account/lib/keychain-store.mjs';
import { AccountError } from '../home/tools/account/lib/names.mjs';
import { fakeToken } from './account-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const SECURITY = '/usr/bin/security';
const TOKEN_A = fakeToken('KeychainA');
const TOKEN_B = fakeToken('KeychainB');
const EXIT_NO_SUCH_ITEM = 44;
// Account names no real account has, new in every run, so the check on the default search list below can only see this test's own item.
const RUN = Math.random().toString(36).slice(2, 10);
const WORK = `t-${RUN}-w`;
const HOME = `t-${RUN}-h`;
const inDefaultSearchList = (name) => spawnSync(SECURITY, ['find-generic-password', '-a', name, '-s', KEYCHAIN_SERVICE], { encoding: 'utf8' }).status !== EXIT_NO_SUCH_ITEM;
const searchList = () => spawnSync(SECURITY, ['list-keychains'], { encoding: 'utf8' }).stdout;

/** A scratch keychain file in a temp folder whose name holds a space; removed (the file only) when the test ends. */
function scratchKeychain(t) {
  const before = searchList();
  const keychain = join(makeTempDir('account keychain-'), 'scratch.keychain-db');
  const made = spawnSync(SECURITY, ['create-keychain', '-p', '', keychain], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  t.after(() => {
    spawnSync(SECURITY, ['delete-keychain', keychain], { encoding: 'utf8' });
    assert.equal(searchList(), before, 'the search list is the same before and after');
    // A broken store could have written this run's item into the login keychain (see keychain-store.mjs on a missing file):
    // say so, and take that one item out again. The names are this run's own, so no other item can be meant.
    const strayed = [WORK, HOME].filter(inDefaultSearchList);
    for (const name of strayed) spawnSync(SECURITY, ['delete-generic-password', '-a', name, '-s', KEYCHAIN_SERVICE], { encoding: 'utf8' });
    assert.deepEqual(strayed, [], 'an item of this test was written to the login keychain (it was removed again)');
  });
  assert.equal(searchList(), before, 'creating the scratch file does not add it to the search list');
  return keychain;
}

test('runSecurity: the only argument of /usr/bin/security is -i; the command line goes to its stdin', () => {
  const seen = [];
  const spawnSpy = (command, args, options) => { seen.push({ command, args, input: options.input }); return { status: 0, stdout: '', stderr: '' }; };
  runSecurity(`add-generic-password -U -a ${WORK} -s ${KEYCHAIN_SERVICE} -w ${TOKEN_A}`, spawnSpy);
  assert.deepEqual(seen, [{ command: SECURITY, args: ['-i'], input: `add-generic-password -U -a ${WORK} -s ${KEYCHAIN_SERVICE} -w ${TOKEN_A}\n` }]);
});

if (process.platform === 'darwin') {
  test('the Keychain store on a scratch keychain file: write, read back, replace, a second account, remove', (t) => {
    const keychain = scratchKeychain(t);
    const store = keychainStore({ keychain });
    store.put(WORK, TOKEN_A);
    assert.equal(store.get(WORK), TOKEN_A);
    store.put(WORK, TOKEN_B);
    assert.equal(store.get(WORK), TOKEN_B, 'a second add replaces the token');
    store.put(HOME, TOKEN_A);
    assert.deepEqual([store.get(HOME), store.get('nobody')], [TOKEN_A, null]);
    assert.deepEqual([store.remove(WORK), store.get(WORK), store.remove(WORK)], [true, null, false]);
  });

  test('a duplicate add and a failed add print no part of the token, and the error of the store names none', (t) => {
    const keychain = scratchKeychain(t);
    const add = `add-generic-password -a ${WORK} -s ${KEYCHAIN_SERVICE} -w ${TOKEN_A} "${keychain}"`;
    assert.equal(runSecurity(add).status, 0);
    const duplicate = runSecurity(add);
    assert.equal(duplicate.status, 45);
    assert.ok(!`${duplicate.stdout}${duplicate.stderr}`.includes('MadeUp'));
    const store = keychainStore({ keychain, run: (line) => runSecurity(line.replace(' -U ', ' ')) });
    assert.throws(() => store.put(WORK, TOKEN_A), (error) => error instanceof AccountError && error.kind === 'store' && /exit 45/.test(error.message) && !error.message.includes('MadeUp'));
  });
}
