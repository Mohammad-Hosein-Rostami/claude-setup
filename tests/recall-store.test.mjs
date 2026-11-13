// Tests for recall store and indexer hardening: busy handling, unterminated lines, rewritten and deleted files, perms,
// doc globs, bash-capture skipping. Temp dirs with RECALL_DB / RECALL_ROOT overrides; never touches the real ~/.claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexAll } from '../home/tools/recall/lib/indexer.mjs';
import { isBusyError, openStore } from '../home/tools/recall/lib/store.mjs';
import { createTranscriptParser } from '../home/tools/recall/lib/extract.mjs';

const CLI = fileURLToPath(new URL('../home/tools/recall/recall.mjs', import.meta.url));
const SESSION = 'aaaaaaaa-1111-2222-3333-444444444444';
const j = (o) => `${JSON.stringify(o)}\n`;
const user = (text) => j({ type: 'user', timestamp: '2026-01-05T10:00:00Z', message: { content: text } });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'recall-store-'));
  const root = join(dir, 'projects');
  mkdirSync(join(root, '-p'), { recursive: true });
  const file = join(root, '-p', `${SESSION}.jsonl`);
  const env = { ...process.env, RECALL_DB: join(dir, 'db', 'index.db'), RECALL_ROOT: root, RECALL_BUSY_TIMEOUT_MS: '300', RECALL_OLLAMA_URL: 'http://127.0.0.1:9' };
  return { dir, root, file, env };
}
const lines = (store, source) => store.db.prepare('SELECT line,text FROM chunks WHERE source=? ORDER BY line').all(source);

/** Child process that holds a write lock on `dbPath` until `ms` pass; resolves once the lock is held. */
function holdWriteLock(dbPath, ms) {
  const code = `const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(process.argv[1]);
    d.exec('BEGIN IMMEDIATE'); console.log('locked'); setTimeout(() => { d.exec('COMMIT'); process.exit(0); }, ${ms});`;
  const child = spawn(process.execPath, ['-e', code, dbPath], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve) => child.stdout.once('data', () => resolve(child)));
}
const exited = (child) => new Promise((resolve) => child.once('exit', resolve));

test('openStore waits for a lock held by another process instead of failing at once', async () => {
  const { env } = setup();
  const store = openStore(env.RECALL_DB);
  store.close();
  const child = await holdWriteLock(env.RECALL_DB, 400);
  const second = openStore(env.RECALL_DB); // busy_timeout is set before the WAL/schema statements
  second.close();
  await exited(child);
});

test('isBusyError recognises sqlite lock errors only', () => {
  assert.ok(isBusyError(Object.assign(new Error('database is locked'), { errcode: 5 })));
  assert.ok(!isBusyError(new Error('no such table')));
});

test('search falls back to the existing index (with a stderr note) when the quick index hits a lock', async () => {
  const { file, env } = setup();
  writeFileSync(file, user('we chose sqlite for storage'));
  assert.equal(spawnSync(process.execPath, [CLI, 'index'], { env, encoding: 'utf8' }).status, 0);
  appendFileSync(file, user('a new line that needs indexing')); // gives the quick index real work to do
  const child = await holdWriteLock(env.RECALL_DB, 1500);
  const found = spawnSync(process.execPath, [CLI, 'search', 'sqlite storage'], { env, encoding: 'utf8' });
  child.kill();
  assert.equal(found.status, 0, found.stderr);
  assert.match(found.stderr, /busy/);
  assert.match(found.stdout, /chose sqlite for storage/);
});

test('an unterminated last line is never consumed, so later line numbers do not drift', () => {
  const { file, env } = setup();
  writeFileSync(file, user('first line') + user('second line') + JSON.stringify({ type: 'user', message: { content: 'third line' } }));
  const store = openStore(env.RECALL_DB);
  indexAll(store, { root: env.RECALL_ROOT });
  assert.deepEqual(lines(store, file).map((r) => r.line), [1, 2]);
  appendFileSync(file, `\n${user('fourth line')}`);
  indexAll(store, { root: env.RECALL_ROOT });
  assert.deepEqual(lines(store, file).map((r) => [r.line, r.text]), [[1, 'first line'], [2, 'second line'], [3, 'third line'], [4, 'fourth line']]);
  store.close();
});

test('a rewritten file (new first 4 KB, larger, newer) is fully re-indexed', () => {
  const { file, env } = setup();
  writeFileSync(file, user('old alpha content') + user('old beta content'));
  const store = openStore(env.RECALL_DB);
  indexAll(store, { root: env.RECALL_ROOT });
  const rewritten = user('brand new opening line that is much longer than before') + user('another new line') + user('third new line') + user('fourth new line');
  writeFileSync(file, rewritten, { flag: 'w' });
  indexAll(store, { root: env.RECALL_ROOT });
  assert.deepEqual(lines(store, file).map((r) => r.text.split(' ')[0]), ['brand', 'another', 'third', 'fourth']);
  store.close();
});

test('an appended file is not mistaken for a rewrite while its head is still under 4 KB', () => {
  const { file, env } = setup();
  writeFileSync(file, user('short head'));
  const store = openStore(env.RECALL_DB);
  indexAll(store, { root: env.RECALL_ROOT });
  appendFileSync(file, user('appended later'));
  const result = indexAll(store, { root: env.RECALL_ROOT });
  assert.equal(result.added, 1);
  assert.deepEqual(lines(store, file).map((r) => r.line), [1, 2]);
  store.close();
});

test('deleting a transcript removes its chunks on the next index', () => {
  const { file, env } = setup();
  writeFileSync(file, user('doomed content'));
  const store = openStore(env.RECALL_DB);
  indexAll(store, { root: env.RECALL_ROOT });
  assert.equal(lines(store, file).length, 1);
  rmSync(file);
  indexAll(store, { root: env.RECALL_ROOT });
  assert.equal(lines(store, file).length, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'doomed'").get().n, 0);
  assert.equal(store.listFilePaths().includes(file), false);
  store.close();
});

test('a missing root is silent; an unreadable one is reported on stderr', () => {
  const { dir, env } = setup();
  const missing = spawnSync(process.execPath, [CLI, 'index'], { env: { ...env, RECALL_ROOT: join(dir, 'nope') }, encoding: 'utf8' });
  assert.equal(missing.stderr, '');
  const notADir = join(dir, 'afile');
  writeFileSync(notADir, 'x');
  const broken = spawnSync(process.execPath, [CLI, 'index'], { env: { ...env, RECALL_ROOT: notADir }, encoding: 'utf8' });
  assert.match(broken.stderr, /cannot read/);
});

test('the DB dir is 0700 and the db files 0600', { skip: process.platform === 'win32' }, () => {
  const { dir } = setup();
  const path = join(dir, 'private', 'index.db');
  const store = openStore(path);
  store.db.exec('CREATE TABLE IF NOT EXISTS t(x); INSERT INTO t VALUES(1);'); // forces -wal/-shm into existence
  const mode = (p) => statSync(p).mode & 0o777;
  assert.equal(mode(join(dir, 'private')), 0o700);
  assert.equal(mode(path), 0o600);
  for (const suffix of ['-wal', '-shm']) assert.equal(mode(path + suffix), 0o600);
  store.close();
});

test('recall.json globs index only .md files and symlinked docs are skipped', { skip: process.platform === 'win32' }, () => {
  const { dir, env } = setup();
  const home = join(dir, 'home');
  const docs = join(dir, 'docs');
  mkdirSync(home);
  mkdirSync(docs);
  writeFileSync(join(docs, 'keep.md'), 'plain markdown note');
  writeFileSync(join(docs, 'secret.txt'), 'text file that must not be indexed');
  writeFileSync(join(dir, 'outside.md'), 'outside the glob but linked in');
  symlinkSync(join(dir, 'outside.md'), join(docs, 'link.md'));
  writeFileSync(join(home, 'recall.json'), JSON.stringify({ docs: [join(docs, '*')] }));
  const store = openStore(env.RECALL_DB);
  indexAll(store, { root: env.RECALL_ROOT, home });
  const texts = store.db.prepare("SELECT text FROM chunks WHERE kind='doc'").all().map((r) => r.text);
  assert.deepEqual(texts, ['plain markdown note']);
  store.close();
});

test('user text with bash-input, bash-stdout or bash-stderr is never indexed (also when the tag is not first)', () => {
  const parser = createTranscriptParser();
  const feed = (text, n) => parser.feed(JSON.stringify({ type: 'user', message: { content: text } }), n);
  assert.deepEqual(feed('<bash-input>mysql -pHunter2</bash-input>', 1), []);
  assert.deepEqual(feed('<bash-stdout>token abc</bash-stdout>', 2), []);
  assert.deepEqual(feed('<bash-stderr>denied</bash-stderr>', 3), []);
  assert.deepEqual(feed('see this: <bash-input>echo hi</bash-input>', 4), []);
  assert.equal(feed('a normal prompt', 5).length, 1);
});
