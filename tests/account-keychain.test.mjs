// Tests for the macOS Keychain store and doctor's Keychain call through a real child process: a fake `security` program
// (a node script behind a /bin/sh launcher named `security`) in a cs-test- temp folder that is the only folder on the
// child's PATH, so the real /usr/bin/security is never started and no keychain of the owner is read or changed. The fake
// speaks the `security -i` dialect the store uses (one command line on stdin; exit 0, 44 = no such item, 45 = duplicate),
// keeps its items as JSON in the scratch keychain file it is given, and puts an item for a call with no keychain file
// into its own stand-in default keychain, so a test can see that nothing went there. FAKE_SECURITY_HANG makes it wait
// like an unlock window. The real program's behaviour rests on probe ACC-4 (home/tools/account/README.md).
// Defined on POSIX only (the launcher is a shell script). The tokens are made-up ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KEYCHAIN_SERVICE, SECURITY_TIMEOUT_MS, keychainStore, runSecurity } from '../home/tools/account/lib/keychain-store.mjs';
import { AccountError } from '../home/tools/account/lib/names.mjs';
import { KEYCHAIN_PROBE_TIMEOUT_MS } from '../scripts/doctor-accounts.mjs';
import { fakeToken } from './account-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const SECURITY = '/usr/bin/security';
const TOKEN_A = fakeToken('KeychainA');
const TOKEN_B = fakeToken('KeychainB');
const EXIT_DUPLICATE = 45;
const REPO = fileURLToPath(new URL('..', import.meta.url));
const posixTest = process.platform !== 'win32' ? test : () => {};
const HANG_GUARD_MS = 60000; // a doctor run that waits past its bound fails here; nothing is measured

// The fake `security -i`. Items: {"<service>/<account>": token}, kept as JSON in the keychain file named last on the line.
const FAKE_SECURITY = `
import { readFileSync, writeFileSync } from 'node:fs';
if (process.argv[2] !== '-i') { console.error('fake security: expected -i only'); process.exit(2); }
if (process.env.FAKE_SECURITY_HANG) await new Promise((done) => setTimeout(done, 120000));
const line = readFileSync(0, 'utf8').replace(/\\n$/, '');
if (line.includes('\\n')) { console.error('fake security: one command line only'); process.exit(2); }
const quoted = / "([^"]+)"$/.exec(line);
const file = quoted ? quoted[1] : process.env.FAKE_DEFAULT_KEYCHAIN;
const words = (quoted ? line.slice(0, quoted.index) : line).split(' ');
if (words[0] === 'show-keychain-info') process.exit(0);
const value = (flag) => words[words.indexOf(flag) + 1];
const key = value('-s') + '/' + value('-a');
const text = readFileSync(file, 'utf8');
const items = text ? JSON.parse(text) : {};
const save = () => writeFileSync(file, JSON.stringify(items));
if (words[0] === 'add-generic-password') {
  if (key in items && !words.includes('-U')) { console.error('security: SecKeychainItemCreateFromContent (<default>): The specified item already exists in the keychain.'); process.exit(45); }
  items[key] = value('-w');
  save();
  process.exit(0);
}
if (!(key in items)) { console.error('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.'); process.exit(44); }
if (words[0] === 'find-generic-password') { process.stdout.write(items[key] + '\\n'); process.exit(0); }
if (words[0] === 'delete-generic-password') { delete items[key]; save(); process.exit(0); }
console.error('fake security: unknown command'); process.exit(2);
`;

/** A cs-test- folder with the fake `security`, a scratch keychain file and the fake's stand-in default keychain. */
function fakeSecurityBox() {
  const dir = realpathSync(makeTempDir('account-keychain-')); // /var is a link on macOS: the store refuses a path with a link in it
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(dir, 'fake-security.mjs'), FAKE_SECURITY);
  writeFileSync(join(bin, 'security'), `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'fake-security.mjs')}" "$@"\n`);
  chmodSync(join(bin, 'security'), 0o755);
  const keychain = join(dir, 'scratch dir', 'scratch.keychain-db');
  mkdirSync(join(dir, 'scratch dir'));
  writeFileSync(keychain, '');
  const defaultKeychain = join(dir, 'default.keychain-db');
  writeFileSync(defaultKeychain, '');
  const calls = [];
  /** A stand-in for spawnSync: the store names /usr/bin/security; the fake is started instead, found on a PATH of its folder only. */
  const spawn = (command, args, options) => {
    calls.push({ command, args, input: options.input, timeout: options.timeout });
    return spawnSync('security', args, { ...options, env: { PATH: bin, FAKE_DEFAULT_KEYCHAIN: defaultKeychain } });
  };
  return { dir, bin, keychain, defaultKeychain, spawn, calls, run: (line) => runSecurity(line, spawn) };
}

test('runSecurity: the only argument of /usr/bin/security is -i; the command line goes to its stdin; the store\'s timeout by default', () => {
  const seen = [];
  const spawnSpy = (command, args, options) => { seen.push({ command, args, input: options.input, timeout: options.timeout }); return { status: 0, stdout: '', stderr: '' }; };
  runSecurity(`add-generic-password -U -a work -s ${KEYCHAIN_SERVICE} -w ${TOKEN_A}`, spawnSpy);
  assert.deepEqual(seen, [{ command: SECURITY, args: ['-i'], input: `add-generic-password -U -a work -s ${KEYCHAIN_SERVICE} -w ${TOKEN_A}\n`, timeout: SECURITY_TIMEOUT_MS }]);
});

posixTest('the Keychain store over the fake security program: write, read back, replace, a second account, remove; nothing reaches the default keychain', () => {
  const box = fakeSecurityBox();
  const store = keychainStore({ keychain: box.keychain, run: box.run });
  store.put('work', TOKEN_A);
  assert.equal(store.get('work'), TOKEN_A);
  store.put('work', TOKEN_B);
  assert.equal(store.get('work'), TOKEN_B, 'a second add replaces the token');
  store.put('home', TOKEN_A);
  assert.deepEqual([store.get('home'), store.get('nobody')], [TOKEN_A, null]);
  assert.deepEqual([store.remove('work'), store.get('work'), store.remove('work')], [true, null, false]);
  assert.ok(box.calls.every((call) => call.command === SECURITY && call.args.length === 1 && call.args[0] === '-i'), 'every token went on stdin, never in argv');
  assert.equal(readFileSync(box.defaultKeychain, 'utf8'), '', 'no item went to the default keychain');
});

posixTest('a duplicate add and a failed add print no part of the token, and the error of the store names none', () => {
  const box = fakeSecurityBox();
  const add = `add-generic-password -a work -s ${KEYCHAIN_SERVICE} -w ${TOKEN_A} "${box.keychain}"`;
  assert.equal(box.run(add).status, 0);
  const duplicate = box.run(add);
  assert.equal(duplicate.status, EXIT_DUPLICATE);
  assert.ok(!`${duplicate.stdout}${duplicate.stderr}`.includes('MadeUp'));
  const store = keychainStore({ keychain: box.keychain, run: (line) => box.run(line.replace(' -U ', ' ')) });
  assert.throws(() => store.put('work', TOKEN_A), (error) => error instanceof AccountError && error.kind === 'store' && /exit 45/.test(error.message) && !error.message.includes('MadeUp'));
});

// Runs doctor in a child (its findings go to stdout) with a Keychain-kind store and doctor's own bounded runner, whose
// spawn starts the fake `security`. The store's own reads must not happen: the Keychain counts as locked.
const DOCTOR_DRIVER = `
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { keychainStore } from ${JSON.stringify(pathToFileURL(join(REPO, 'home/tools/account/lib/keychain-store.mjs')).href)};
import { keychainProbeRunner, main } from ${JSON.stringify(pathToFileURL(join(REPO, 'scripts/doctor-accounts.mjs')).href)};
const spawn = (command, args, options) => {
  appendFileSync(process.env.CALLS_LOG, JSON.stringify({ command, args, input: options.input, timeout: options.timeout }) + '\\n');
  return spawnSync('security', args, { ...options, env: { PATH: process.env.FAKE_SECURITY_BIN, FAKE_SECURITY_HANG: '1' } });
};
const store = keychainStore({ run: () => { throw new Error('the store must not be asked while the Keychain is locked'); } });
process.exitCode = await main(process.argv.slice(2), process.env, { store, run: keychainProbeRunner(spawn) });
`;

posixTest('F3: doctor\'s Keychain call is bounded: a Keychain that waits (an unlock window) is ended and reported as locked, exit 0', () => {
  const box = fakeSecurityBox();
  const home = join(box.dir, 'home');
  const project = join(box.dir, 'project');
  for (const path of [home, join(home, '.claude'), project]) mkdirSync(path);
  writeFileSync(join(box.dir, 'driver.mjs'), DOCTOR_DRIVER);
  const callsLog = join(box.dir, 'calls.jsonl');
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, SHELL: '/bin/zsh', CLAUDE_ACCOUNT_DIR: join(home, 'accounts'), CLAUDE_ACCOUNT_STORE: 'file', CALLS_LOG: callsLog, FAKE_SECURITY_BIN: box.bin };
  const done = spawnSync(process.execPath, [join(box.dir, 'driver.mjs'), join(home, '.claude'), REPO, project], { env, encoding: 'utf8', timeout: HANG_GUARD_MS });
  assert.equal(done.error, undefined, 'doctor came back before the guard');
  assert.deepEqual([done.status, done.stderr], [0, '']);
  const locked = done.stdout.split('\n').filter((line) => /Keychain did not answer/.test(line));
  assert.equal(locked.length, 1, done.stdout);
  assert.match(locked[0], /^WARN {2}the Keychain did not answer in \d+ s, so it counts as locked/);
  const calls = existsSync(callsLog) ? readFileSync(callsLog, 'utf8').trim().split('\n').map((row) => JSON.parse(row)) : [];
  assert.deepEqual(calls, [{ command: SECURITY, args: ['-i'], input: 'show-keychain-info\n', timeout: KEYCHAIN_PROBE_TIMEOUT_MS }], 'one call, ended at doctor\'s bound');
  assert.ok(KEYCHAIN_PROBE_TIMEOUT_MS < SECURITY_TIMEOUT_MS, 'doctor waits less than the store\'s 20 s');
});
