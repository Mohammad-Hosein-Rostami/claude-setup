// Tests for the account library (home/tools/account/lib/): the name and token patterns, the pasted export line, the
// list of non-secret fields (accounts.json), the 0600 file store, the Keychain store over a fake `security` runner
// (injected through the library, never through PATH), the Windows store over a fake PowerShell runner (the real one is
// not verified: no Windows machine), and which account a call may spend. K10: after each test the token is only in the store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { accountForCall, addAccount, listAccounts, removeAccount, setCreditsOff, setDefault, setPlan } from '../home/tools/account/lib/accounts.mjs';
import { dpapiStore } from '../home/tools/account/lib/dpapi-store.mjs';
import { fileStore } from '../home/tools/account/lib/file-store.mjs';
import { KEYCHAIN_SERVICE, keychainStore } from '../home/tools/account/lib/keychain-store.mjs';
import { AccountError, NAME_PATTERN, TOKEN_PATTERN, looksLikeToken, tokenFromPaste } from '../home/tools/account/lib/names.mjs';
import { REGISTRY_MAX_BYTES, readRegistry, writeRegistry } from '../home/tools/account/lib/registry.mjs';
import { openStore, storeKind } from '../home/tools/account/lib/store.mjs';
import { accountSandbox, assertNoLeak, fakeToken, filesHolding, memoryStore } from './account-helpers.mjs';

const TOKEN_A = fakeToken('StoreA');
const TOKEN_B = fakeToken('StoreB');
const HOSTILE_NAMES = ['../x', 'a"b', 'a\nb', '', '-', '-x', 'A', 'a b', 'a/b', 'x'.repeat(33), "a'b", 'a;b', '$(id)'];
const POSIX = process.platform !== 'win32';
const FILE_STORE = new URL('../home/tools/account/lib/file-store.mjs', import.meta.url);
const FIFO_GUARD_MS = 30000; // a read that waits on the FIFO is ended here and fails the test; nothing is measured
// File modes are a POSIX fact: these tests are defined by platform, as the Keychain tests are.
const posixTest = POSIX ? test : () => {};
const modeOf = (path) => statSync(path).mode & 0o777;
const refuses = (kind) => (error) => error instanceof AccountError && error.kind === kind;

function sandbox(t) {
  const box = accountSandbox();
  t.after(() => assertNoLeak(box, [TOKEN_A, TOKEN_B]));
  return box;
}

/** A fake `security -i`: keeps items in memory and records every command line it was given on stdin. */
function fakeSecurity({ failWith } = {}) {
  const items = new Map();
  const lines = [];
  const run = (line) => {
    lines.push(line);
    if (failWith !== undefined) return { status: failWith, stdout: '', stderr: `security: SecKeychainItemCreateFromContent (<default>): failed\n` };
    const words = line.split(' ');
    const name = words[words.indexOf('-a') + 1];
    if (words[0] === 'add-generic-password') { items.set(name, words[words.indexOf('-w') + 1]); return { status: 0, stdout: '', stderr: '' }; }
    if (!items.has(name)) return { status: 44, stdout: '', stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n' };
    if (words[0] === 'delete-generic-password') { items.delete(name); return { status: 0, stdout: 'keychain: "x"\n', stderr: '' }; }
    return { status: 0, stdout: `${items.get(name)}\n`, stderr: '' };
  };
  return { run, lines, items };
}

test('names: the pattern takes plain lower-case names and refuses anything a command line or a path could misread', () => {
  for (const name of ['work', 'a', 'acc-2', 'x_y', '9lives', 'a'.repeat(32)]) assert.match(name, NAME_PATTERN);
  for (const name of HOSTILE_NAMES) assert.doesNotMatch(name, NAME_PATTERN);
});

test('tokens: one line of the sk-ant- shape; a space, a quote or a newline inside it is refused', () => {
  assert.match(TOKEN_A, TOKEN_PATTERN);
  for (const bad of [`${TOKEN_A}\n`, `${TOKEN_A} x`, `"${TOKEN_A}"`, `${TOKEN_A}\nadd-generic-password -a evil`, 'sk-ant-short', `x${TOKEN_A}`, '']) assert.doesNotMatch(bad, TOKEN_PATTERN);
  assert.ok(looksLikeToken(`claude-as ${TOKEN_A}`));
  assert.ok(!looksLikeToken('claude-as work'));
});

test('the pasted line: a bare token, the whole export line (quoted or not) and a trailing newline are accepted; anything else is refused without echoing it', () => {
  for (const paste of [TOKEN_A, `${TOKEN_A}\n`, `  export CLAUDE_CODE_OAUTH_TOKEN="${TOKEN_A}"\r\n`, `export CLAUDE_CODE_OAUTH_TOKEN='${TOKEN_A}'`, `export CLAUDE_CODE_OAUTH_TOKEN=${TOKEN_A};`, `CLAUDE_CODE_OAUTH_TOKEN=${TOKEN_A}`]) {
    assert.equal(tokenFromPaste(paste), TOKEN_A);
  }
  for (const bad of ['', 'hello', `${TOKEN_A}\n${TOKEN_B}`, `export OTHER=${TOKEN_A}`, `${TOKEN_A} extra`, `export CLAUDE_CODE_OAUTH_TOKEN="${TOKEN_A}'`, `${TOKEN_A}; rm -rf x`]) {
    assert.throws(() => tokenFromPaste(bad), (error) => refuses('token')(error) && !error.message.includes('MadeUp'));
  }
});

test('the account list: written 0600 in a 0700 folder with no token in it; plan, credits-off and the default are kept', (t) => {
  const box = sandbox(t);
  const store = memoryStore();
  addAccount('work', TOKEN_A, { env: box.env, store, now: new Date('2026-11-21T10:00:00Z') });
  setPlan('work', 'max', { env: box.env });
  setCreditsOff('work', { env: box.env });
  setDefault('work', { env: box.env });
  const file = join(box.storeDir, 'accounts.json');
  if (POSIX) assert.deepEqual([modeOf(file), modeOf(box.storeDir)], [0o600, 0o700]);
  assert.deepEqual(filesHolding(box.dir, TOKEN_A), [], 'the token is in the (memory) store only');
  const registry = readRegistry(box.env);
  assert.equal(registry.default, 'work');
  assert.deepEqual([registry.accounts.work.plan, registry.accounts.work.creditsOff, registry.accounts.work.added], ['max', true, '2026-11-21T10:00:00.000Z']);
  assert.throws(() => setPlan('work', 'free', { env: box.env }), refuses('usage'));
  assert.throws(() => setDefault('nobody', { env: box.env }), refuses('unknown'));
  setDefault(null, { env: box.env });
  assert.equal(readRegistry(box.env).default, null);
});

test('the account list: days left of the one year, this terminal (name and token both match) and removal', (t) => {
  const box = sandbox(t);
  const store = memoryStore();
  addAccount('work', TOKEN_A, { env: box.env, store, now: new Date('2026-01-01T00:00:00Z') });
  addAccount('home', TOKEN_B, { env: box.env, store, now: new Date('2026-06-01T00:00:00Z') });
  setDefault('home', { env: box.env });
  const now = new Date('2026-12-02T00:00:00Z');
  const rows = listAccounts({ env: { ...box.env, CLAUDE_ACCOUNT: 'work', CLAUDE_CODE_OAUTH_TOKEN: TOKEN_A }, store, now });
  assert.deepEqual(rows.map((row) => [row.name, row.daysLeft, row.inThisTerminal, row.isDefault]), [['home', 181, 'no', true], ['work', 30, 'yes', false]]);
  const other = listAccounts({ env: { ...box.env, CLAUDE_ACCOUNT: 'work', CLAUDE_CODE_OAUTH_TOKEN: TOKEN_B }, store, now });
  assert.equal(other.find((row) => row.name === 'work').inThisTerminal, 'name only', 'the variable alone is not proof: the token must match the stored one');
  assert.ok(!JSON.stringify(rows).includes(TOKEN_A));
  assert.equal(removeAccount('home', { env: box.env, store }), true);
  assert.equal(readRegistry(box.env).default, null, 'removing the default account clears the default');
  assert.equal(store.get('home'), null);
  assert.equal(removeAccount('home', { env: box.env, store }), false);
});

posixTest('the account list: a link, a looser mode, a file over the cap or one that is not the list is refused, not read', (t) => {
  const box = sandbox(t);
  mkdirSync(box.storeDir, { recursive: true, mode: 0o700 });
  const file = join(box.storeDir, 'accounts.json');
  const elsewhere = join(box.dir, 'elsewhere.json');
  writeFileSync(elsewhere, '{"default":null,"accounts":{}}', { mode: 0o600 });
  symlinkSync(elsewhere, file);
  assert.throws(() => readRegistry(box.env), refuses('unsafe-file'));
  writeRegistry({ default: null, accounts: {} }, box.env); // the atomic write replaces the link, it never follows it
  assert.equal(readFileSync(elsewhere, 'utf8'), '{"default":null,"accounts":{}}');
  chmodSync(file, 0o644);
  assert.throws(() => readRegistry(box.env), refuses('unsafe-file'));
  writeFileSync(file, ' '.repeat(REGISTRY_MAX_BYTES + 1), { mode: 0o600 });
  chmodSync(file, 0o600);
  assert.throws(() => readRegistry(box.env), refuses('unsafe-file'));
  for (const text of ['[]', '{"default":"../x","accounts":{}}', '{"default":null,"accounts":{"A B":{}}}', '{"default":null,"accounts":{"a":{"added":"x","plan":"free","creditsOff":false,"checked":null}}}', 'not json']) {
    writeFileSync(file, text, { mode: 0o600 });
    assert.throws(() => readRegistry(box.env), refuses('registry'), text);
  }
  // R8: the error names the file and the way out (move it aside, add each account again), and holds no token.
  writeFileSync(file, 'not json', { mode: 0o600 });
  assert.throws(() => readRegistry(box.env), (error) => refuses('registry')(error) && error.message.includes(file) && error.message.includes(`mv "${file}" "${file}.bad"`) && error.message.includes('claude-as <name>'));
  assert.throws(() => writeRegistry({ default: '../x', accounts: {} }, box.env), (error) => refuses('registry')(error) && error.message.includes(file));
  const big = { default: null, accounts: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`a${i}`, { added: '2026-11-21T10:00:00.000Z', plan: null, creditsOff: false, checked: null }])) };
  assert.throws(() => writeRegistry(big, box.env), refuses('registry'), 'the writer has the same cap as the reader');
});

posixTest('the account list: bad data in memory is refused on write with no move-aside advice, and a good accounts.json stays as it was', (t) => {
  const box = sandbox(t);
  const good = { default: 'work', accounts: { work: { added: '2026-11-21T10:00:00.000Z', plan: 'max', creditsOff: true, checked: null } } };
  writeRegistry(good, box.env);
  const file = join(box.storeDir, 'accounts.json');
  const before = readFileSync(file, 'utf8');
  const bad = [{ default: '../x', accounts: {} }, { ...good, accounts: { work: { ...good.accounts.work, plan: 'free' } } }, { default: null }, null, undefined];
  for (const registry of bad) {
    assert.throws(() => writeRegistry(registry, box.env), (error) => refuses('registry')(error)
      && error.message.includes(`${file} was not changed`) && !error.message.includes('Move it aside') && !error.message.includes('mv "'), JSON.stringify(registry));
  }
  assert.equal(readFileSync(file, 'utf8'), before, 'the file on disk is not touched');
  assert.deepEqual(readRegistry(box.env), good, 'and it still reads as the good list');
});

posixTest('the file store: folder 0700 and file 0600 from the first write, read back equal, a second account kept apart', (t) => {
  const box = sandbox(t);
  const store = fileStore(box.storeDir);
  store.put('work', TOKEN_A);
  store.put('home', TOKEN_B);
  assert.deepEqual([modeOf(box.storeDir), modeOf(join(box.storeDir, 'work.token'))], [0o700, 0o600]);
  assert.deepEqual([store.get('work'), store.get('home'), store.get('nobody')], [TOKEN_A, TOKEN_B, null]);
  assert.equal(store.remove('home'), true);
  assert.deepEqual([store.get('home'), store.remove('home')], [null, false]);
});

posixTest('the file store: a link in place of the token file, a looser mode on the file or the folder, or a file that is not a token is refused', (t) => {
  const box = sandbox(t);
  const store = fileStore(box.storeDir);
  store.put('work', TOKEN_A);
  const file = join(box.storeDir, 'work.token');
  chmodSync(file, 0o640);
  assert.throws(() => store.get('work'), refuses('unsafe-file'));
  chmodSync(file, 0o600);
  symlinkSync(file, join(box.storeDir, 'link.token'));
  assert.throws(() => store.get('link'), refuses('unsafe-file'));
  writeFileSync(join(box.storeDir, 'junk.token'), 'hello\n', { mode: 0o600 });
  assert.throws(() => store.get('junk'), refuses('token'));
  chmodSync(box.storeDir, 0o755);
  assert.throws(() => store.put('home', TOKEN_B), refuses('unsafe-file'));
  assert.throws(() => store.get('work'), refuses('unsafe-file'));
  chmodSync(box.storeDir, 0o700);
});

posixTest('the file store: a FIFO in place of a token file is refused at once; the read never waits on it', (t) => {
  const box = sandbox(t);
  fileStore(box.storeDir).put('work', TOKEN_A);
  assert.equal(spawnSync('mkfifo', ['-m', '600', join(box.storeDir, 'pipe.token')]).status, 0);
  // In a child: a read that waits on a FIFO blocks its whole process, so only another process can see it hang.
  const script = `import { fileStore } from ${JSON.stringify(FILE_STORE.href)};
try { fileStore(process.argv[1]).get('pipe'); console.log('read'); } catch (error) { console.log(error.kind); }`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script, box.storeDir], { encoding: 'utf8', timeout: FIFO_GUARD_MS });
  assert.equal(run.error, undefined, 'the read came back');
  assert.equal(run.stdout.trim(), 'unsafe-file');
});

for (const [label, makeStore] of [['file', (box) => fileStore(box.storeDir)], ['keychain', () => keychainStore({ run: fakeSecurity().run })], ['dpapi', (box) => dpapiStore(box.storeDir, { run: () => { throw new Error('the runner must not be reached'); } })]]) {
  test(`the ${label} store: a hostile account name or a token that is not one line of the shape is refused before anything is run or written`, (t) => {
    const box = sandbox(t);
    const store = makeStore(box);
    for (const name of HOSTILE_NAMES) {
      assert.throws(() => store.put(name, TOKEN_A), refuses('name'), JSON.stringify(name));
      assert.throws(() => store.get(name), refuses('name'));
      assert.throws(() => store.remove(name), refuses('name'));
    }
    for (const token of [`${TOKEN_A}\nadd-generic-password -a evil -s x -w y`, `${TOKEN_A} -U`, `"${TOKEN_A}"`, '']) assert.throws(() => store.put('work', token), refuses('token'));
    assert.ok(!existsSync(join(box.storeDir, 'work.token')));
  });
}

test('the Keychain store: one fixed command line per call on the stdin of `security -i`, service claude-setup-account, the account name as the account attribute', (t) => {
  const box = sandbox(t);
  const fake = fakeSecurity();
  const dir = realpathSync(box.dir); // /var is a link on macOS: the store refuses a path with a link in it
  const keychain = join(dir, 'scratch dir', 'x.keychain-db');
  mkdirSync(join(dir, 'scratch dir'));
  writeFileSync(keychain, '');
  const store = keychainStore({ run: fake.run, keychain });
  store.put('work', TOKEN_A);
  assert.equal(KEYCHAIN_SERVICE, 'claude-setup-account');
  assert.deepEqual(fake.lines, [`add-generic-password -U -a work -s claude-setup-account -w ${TOKEN_A} "${keychain}"`]);
  assert.equal(store.get('work'), TOKEN_A);
  assert.equal(store.get('nobody'), null);
  assert.deepEqual([store.remove('work'), store.remove('work')], [true, false]);
  assert.ok(fake.lines.every((line) => !line.includes('\n')), 'never a second command on the same stdin');
  assert.throws(() => keychainStore({ run: fake.run, keychain: '/tmp/a"b' }), refuses('store'));
  // `security` given a keychain file that does not exist writes to the login keychain instead: nothing may be run for one.
  const missing = keychainStore({ run: () => { throw new Error('security must not be run for a keychain file that does not exist'); }, keychain: join(dir, 'no-such.keychain-db') });
  for (const act of [() => missing.put('work', TOKEN_A), () => missing.get('work'), () => missing.remove('work')]) assert.throws(act, refuses('store'));
});

posixTest('S6: the Keychain store runs `security` only for an absolute path to a regular file: a bare name, a relative path and a link are refused', (t) => {
  const box = sandbox(t);
  const dir = realpathSync(box.dir); // /var is a link on macOS: the store refuses a path with a link in it
  const real = join(dir, 'real.keychain-db');
  const link = join(dir, 'link.keychain-db');
  writeFileSync(real, '');
  symlinkSync(real, link);
  const mustNotRun = () => { throw new Error('security must not be run for a keychain path that is not an absolute regular file'); };
  // A bare name would be looked up in ~/Library/Keychains and a file it cannot open falls back to the login keychain.
  for (const keychain of ['login.keychain-db', './real.keychain-db', join('..', 'real.keychain-db'), link]) {
    const store = keychainStore({ run: mustNotRun, keychain });
    for (const act of [() => store.put('work', TOKEN_A), () => store.get('work'), () => store.remove('work')]) assert.throws(act, refuses('store'), keychain);
  }
  const fake = fakeSecurity();
  keychainStore({ run: fake.run, keychain: real }).put('work', TOKEN_A);
  assert.equal(fake.lines.length, 1, 'the absolute regular file is the one accepted');
  // The check is made right before each call: a file swapped for a link after the store was built is still refused.
  const swapped = keychainStore({ run: mustNotRun, keychain: join(dir, 'swap.keychain-db') });
  writeFileSync(join(dir, 'swap.keychain-db'), '');
  rmSync(join(dir, 'swap.keychain-db'));
  symlinkSync(real, join(dir, 'swap.keychain-db'));
  assert.throws(() => swapped.get('work'), refuses('store'));
  // A link in an earlier part of the path (a folder that is a link) is refused too: `lstat` of the last part alone passes it.
  mkdirSync(join(dir, 'elsewhere'));
  writeFileSync(join(dir, 'elsewhere', 'o.keychain-db'), '');
  symlinkSync(join(dir, 'elsewhere'), join(dir, 'linked-folder'));
  const viaFolder = keychainStore({ run: mustNotRun, keychain: join(dir, 'linked-folder', 'o.keychain-db') });
  for (const act of [() => viaFolder.put('work', TOKEN_A), () => viaFolder.get('work'), () => viaFolder.remove('work')]) assert.throws(act, refuses('store'));
  // The same path through the real folder is accepted.
  keychainStore({ run: fake.run, keychain: join(dir, 'elsewhere', 'o.keychain-db') }).remove('work');
});

posixTest('F2: a keychain file swapped, linked or removed while `security` runs makes the call fail; a read hands no token on', (t) => {
  const box = sandbox(t);
  const dir = realpathSync(box.dir); // /var is a link on macOS: the store refuses a path with a link in it
  const keychain = join(dir, 'k.keychain-db');
  const other = join(dir, 'other.keychain-db');
  const renamedOver = () => { writeFileSync(other, ''); renameSync(other, keychain); };
  const swaps = {
    'a link put in its place': () => { writeFileSync(other, ''); rmSync(keychain); symlinkSync(other, keychain); },
    'removed': () => rmSync(keychain),
  };
  const fresh = () => { rmSync(keychain, { force: true }); writeFileSync(keychain, ''); };
  const swappedError = (label) => [(error) => refuses('store')(error) && /swapped, moved or linked/.test(error.message) && !error.message.includes('MadeUp'), label];
  // The swap happens inside the call: after the store's check, while `security` would be opening the file by its path.
  const storeSwapping = (swap) => {
    const fake = fakeSecurity();
    fake.items.set('work', TOKEN_A);
    return keychainStore({ run: (line) => { swap(); return fake.run(line); }, keychain });
  };
  for (const [label, swap] of Object.entries(swaps)) {
    const store = storeSwapping(swap);
    for (const act of [() => store.put('work', TOKEN_A), () => store.get('work'), () => store.remove('work')]) {
      fresh();
      assert.throws(act, ...swappedError(label));
    }
  }
  // A read must find the very same file: another regular file renamed over it is refused and its token not handed on.
  fresh();
  assert.throws(() => storeSwapping(renamedOver).get('work'), ...swappedError('a read of a file renamed over'));
  // A write is not held to the inode: the real `security` replaces the file on add, replace and delete (probe 2026-11-22),
  // so a write that gives the file a new inode passes, as do the same calls with no swap.
  for (const act of [(store) => store.put('work', TOKEN_A), (store) => store.remove('work')]) {
    fresh();
    assert.doesNotThrow(() => act(storeSwapping(renamedOver)));
  }
  fresh();
  const store = keychainStore({ run: fakeSecurity().run, keychain });
  store.put('work', TOKEN_A);
  assert.deepEqual([store.get('work'), store.remove('work')], [TOKEN_A, true]);
});

for (const status of [45, 36, 1, null]) {
  test(`the Keychain store: a failed write or read (security exit ${status}) throws without any part of the token or of the command text`, (t) => {
    sandbox(t);
    const fake = fakeSecurity({ failWith: status });
    const store = keychainStore({ run: fake.run });
    for (const act of [() => store.put('work', TOKEN_A), () => store.get('work'), () => store.remove('work')]) {
      assert.throws(act, (error) => refuses('store')(error) && !error.message.includes('MadeUp') && !error.message.includes('add-generic-password -U'));
    }
  });
}

test('the Keychain store: a read that returns something that is not a token is refused, not handed on', (t) => {
  sandbox(t);
  const store = keychainStore({ run: () => ({ status: 0, stdout: 'password: "x"\n', stderr: '' }) });
  assert.throws(() => store.get('work'), refuses('token'));
});

test('the Windows store (not verified on Windows): the token reaches PowerShell only on stdin, and the file holds the protected text, never the token', (t) => {
  const box = sandbox(t);
  const calls = [];
  const run = (script, input) => {
    calls.push({ script, input });
    return script.includes('Unprotect') ? Buffer.from(input.trim(), 'base64').toString('utf8').split('').reverse().join('') : Buffer.from(input.trim().split('').reverse().join('')).toString('base64');
  };
  const store = dpapiStore(box.storeDir, { run });
  store.put('work', TOKEN_A);
  assert.ok(calls.every((call) => !call.script.includes(TOKEN_A)), 'the script text (a command argument) never holds the token');
  assert.deepEqual(filesHolding(box.dir, TOKEN_A), []);
  assert.equal(store.get('work'), TOKEN_A);
  assert.equal(store.get('nobody'), null);
  assert.deepEqual([store.remove('work'), store.get('work')], [true, null]);
});

test('which store: the Keychain on macOS, the 0600 file on Linux, DPAPI on Windows; only the file store can be forced', (t) => {
  const box = sandbox(t);
  const plain = { ...box.env };
  delete plain.CLAUDE_ACCOUNT_STORE;
  assert.deepEqual(['darwin', 'linux', 'win32', 'freebsd'].map(storeKind), ['keychain', 'file', 'dpapi', 'file']);
  assert.deepEqual(['linux', 'win32', 'freebsd'].map((platform) => openStore(plain, { platform }).kind), ['file', 'dpapi', 'file']);
  // S7: in a test run, or with a HOME that is not the user's, the login Keychain is refused, never opened.
  assert.throws(() => openStore(plain, { platform: 'darwin' }), refuses('store'));
  assert.equal(openStore(box.env, { platform: 'darwin' }).kind, 'file');
  assert.throws(() => openStore({ ...box.env, CLAUDE_ACCOUNT_STORE: 'memory' }, { platform: 'darwin' }), refuses('store'));
});

test('which account a call may spend: CLAUDE_ACCOUNT, else the default; `-`, an unknown or a hostile name gives none', (t) => {
  const box = sandbox(t);
  const store = memoryStore();
  assert.equal(accountForCall(box.env, store), null, 'no account list at all');
  addAccount('work', TOKEN_A, { env: box.env, store });
  addAccount('home', TOKEN_B, { env: box.env, store });
  assert.equal(accountForCall(box.env, store), null, 'no default: a terminal that picked nothing spends nothing');
  assert.deepEqual(accountForCall({ ...box.env, CLAUDE_ACCOUNT: 'work' }, store), { name: 'work', token: TOKEN_A });
  setDefault('home', { env: box.env });
  assert.deepEqual(accountForCall(box.env, store), { name: 'home', token: TOKEN_B });
  assert.deepEqual(accountForCall({ ...box.env, CLAUDE_ACCOUNT: 'work' }, store), { name: 'work', token: TOKEN_A });
  for (const name of ['-', 'gone', ...HOSTILE_NAMES.filter((name) => name !== '')]) assert.equal(accountForCall({ ...box.env, CLAUDE_ACCOUNT: name }, store), null, JSON.stringify(name));
});
