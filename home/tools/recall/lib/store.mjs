// Purpose: SQLite store for recall (chunks, two FTS5 indexes, per-file incremental state, seen cwds, vectors).
// Exports: defaultDbPath, openStore, isBusyError. Store methods: addChunk, deleteSource, getFile, putFile, deleteFile,
// listFilePaths, addCwd, listCwds, neighbours, stats, transaction, putVectors, chunksWithoutVector, vectorCount,
// iterateVectors, close, db.
// Invariants: busy_timeout is set before any other statement and the open is retried once on SQLITE_BUSY; writes use
// BEGIN IMMEDIATE; a DB dir that recall creates is 0700 (an existing parent such as /tmp is never chmod-ed) and the
// db/-wal/-shm files are 0600 (POSIX); addChunk skips a chunk whose hash
// already exists for the same session; FTS tables and vecs are kept in step with `chunks` by this module only.
import './quiet-sqlite-warning.mjs'; // first: it must run before node:sqlite loads
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { sha1 } from './extract.mjs';
import { defaultDbPath } from './paths.mjs';

// Loaded here, not with a static import: Node loads a static `node:sqlite` import (and prints its warning) before any
// module body runs, so the quiet-sqlite-warning import above would be too late.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite');

const BUSY_TIMEOUT_MS = 5000;
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const RETRY_DELAY_MS = 250;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chunks(
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, project TEXT, session TEXT, source TEXT, line INTEGER,
  ts TEXT, role TEXT, text TEXT NOT NULL, hash TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS chunks_session_hash ON chunks(session, hash);
CREATE INDEX IF NOT EXISTS chunks_source ON chunks(source, id);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text, content='chunks', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_tri USING fts5(
  text, content='chunks', content_rowid='id', tokenize='trigram');
CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, size INTEGER, mtime INTEGER, offset INTEGER, lines INTEGER, head TEXT);
CREATE TABLE IF NOT EXISTS cwds(path TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS vecs(chunk_id INTEGER NOT NULL, model TEXT NOT NULL, dim INTEGER NOT NULL, vec BLOB NOT NULL,
  PRIMARY KEY(chunk_id, model));
`;

export { defaultDbPath };

/** True for a "database is locked / busy" error from node:sqlite. */
export function isBusyError(error) {
  return error?.errcode === SQLITE_BUSY || error?.errcode === SQLITE_LOCKED || /database is locked|busy/i.test(error?.message ?? '');
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** chmod that is a no-op where the platform has no POSIX modes (Windows ignores it) and the file may not exist yet. */
function restrict(path, mode) {
  if (process.platform === 'win32' || !existsSync(path)) return;
  chmodSync(path, mode);
}

function prepareLocation(path) {
  const created = mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
  if (created) restrict(dirname(path), DIR_MODE); // never chmod a parent that already existed (RECALL_DB=/tmp/x.db)
  if (!existsSync(path)) closeSync(openSync(path, 'a', FILE_MODE)); // sqlite copies this mode to -wal/-shm
  restrict(path, FILE_MODE);
}

/** RECALL_BUSY_TIMEOUT_MS (tests), else 5 s. */
const busyTimeoutMs = (env = process.env) => Number(env.RECALL_BUSY_TIMEOUT_MS) || BUSY_TIMEOUT_MS;

function configure(db) {
  db.exec(`PRAGMA busy_timeout=${busyTimeoutMs()}`);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
  db.exec(SCHEMA);
  if (!db.prepare('PRAGMA table_info(files)').all().some((c) => c.name === 'head')) db.exec('ALTER TABLE files ADD COLUMN head TEXT');
}

function openDatabase(path) {
  prepareLocation(path);
  let db = new DatabaseSync(path);
  try {
    configure(db);
  } catch (error) {
    db.close();
    if (!isBusyError(error)) throw error;
    sleepSync(RETRY_DELAY_MS); // another recall process holds the lock: retry once
    db = new DatabaseSync(path);
    configure(db);
  }
  for (const suffix of ['-wal', '-shm']) restrict(path + suffix, FILE_MODE);
  return db;
}

const COLS = 'id,kind,project,session,source,line,ts,role,text';

function prepareStatements(db) {
  const p = (sql) => db.prepare(sql);
  return {
    insertChunk: p('INSERT INTO chunks(kind,project,session,source,line,ts,role,text,hash) VALUES(?,?,?,?,?,?,?,?,?)'),
    insertFts: p('INSERT INTO chunks_fts(rowid,text) VALUES(?,?)'),
    insertTri: p('INSERT INTO chunks_tri(rowid,text) VALUES(?,?)'),
    hasHash: p('SELECT 1 FROM chunks WHERE session=? AND hash=? LIMIT 1'),
    bySource: p('SELECT id,text FROM chunks WHERE source=?'),
    deleteFts: p("INSERT INTO chunks_fts(chunks_fts,rowid,text) VALUES('delete',?,?)"),
    deleteTri: p("INSERT INTO chunks_tri(chunks_tri,rowid,text) VALUES('delete',?,?)"),
    deleteChunks: p('DELETE FROM chunks WHERE source=?'),
    deleteVecs: p('DELETE FROM vecs WHERE chunk_id=?'),
    getFile: p('SELECT path,size,mtime,offset,lines,head FROM files WHERE path=?'),
    putFile: p('INSERT OR REPLACE INTO files(path,size,mtime,offset,lines,head) VALUES(?,?,?,?,?,?)'),
    deleteFile: p('DELETE FROM files WHERE path=?'),
    before: p(`SELECT ${COLS} FROM chunks WHERE source=? AND id<? ORDER BY id DESC LIMIT ?`),
    after: p(`SELECT ${COLS} FROM chunks WHERE source=? AND id>? ORDER BY id LIMIT ?`),
    one: p(`SELECT ${COLS} FROM chunks WHERE id=?`),
    putVec: p('INSERT OR REPLACE INTO vecs(chunk_id,model,dim,vec) VALUES(?,?,?,?)'),
    unembedded: p('SELECT c.id,c.text FROM chunks c WHERE NOT EXISTS (SELECT 1 FROM vecs v WHERE v.chunk_id=c.id AND v.model=?) LIMIT ?'),
    loadVecs: p('SELECT chunk_id,dim,vec FROM vecs WHERE model=?'),
    countVecs: p('SELECT COUNT(*) AS n FROM vecs WHERE model=?'),
  };
}


/** Run fn inside one write transaction (BEGIN IMMEDIATE); rolls back and rethrows on error. */
function makeTransaction(db) {
  return (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
}

function chunkWrites(st) {
  return {
    /** Insert a chunk unless the session already has its text. Returns true when added. */
    addChunk(chunk) {
      const hash = sha1(chunk.text);
      if (st.hasHash.get(chunk.session, hash)) return false;
      const { lastInsertRowid: id } = st.insertChunk.run(
        chunk.kind, chunk.project, chunk.session, chunk.source, chunk.line, chunk.ts, chunk.role, chunk.text, hash);
      st.insertFts.run(id, chunk.text);
      st.insertTri.run(id, chunk.text);
      return true;
    },
    /** Remove every chunk (and vector) of one source file: before re-indexing it, or when it was deleted. */
    deleteSource(source) {
      for (const row of st.bySource.all(source)) {
        st.deleteFts.run(row.id, row.text);
        st.deleteTri.run(row.id, row.text);
        st.deleteVecs.run(row.id);
      }
      st.deleteChunks.run(source);
    },
  };
}

function fileState(db, st) {
  return {
    getFile: (file) => st.getFile.get(file),
    putFile: (row) => st.putFile.run(row.path, row.size, row.mtime, row.offset, row.lines, row.head ?? null),
    deleteFile: (file) => st.deleteFile.run(file),
    listFilePaths: () => db.prepare('SELECT path FROM files').all().map((r) => r.path),
    addCwd: (cwd) => db.prepare('INSERT OR IGNORE INTO cwds(path) VALUES(?)').run(cwd),
    listCwds: () => db.prepare('SELECT path FROM cwds').all().map((r) => r.path),
  };
}

function reads(db, st) {
  return {
    /** The chunk with `id` plus `around` neighbours on each side from the same source, in order; null if unknown. */
    neighbours(id, around) {
      const target = st.one.get(id);
      if (!target) return null;
      const prev = st.before.all(target.source, id, around).reverse();
      return [...prev, target, ...st.after.all(target.source, id, around)];
    },
    stats() {
      const kinds = db.prepare('SELECT kind, COUNT(*) AS n FROM chunks GROUP BY kind ORDER BY kind').all();
      const files = db.prepare('SELECT COUNT(*) AS n FROM files').get().n;
      const sessions = db.prepare('SELECT COUNT(DISTINCT session) AS n FROM chunks').get().n;
      const vectors = db.prepare('SELECT model, COUNT(*) AS n FROM vecs GROUP BY model').all();
      return { kinds, files, sessions, vectors, total: kinds.reduce((sum, k) => sum + k.n, 0) };
    },
  };
}

function vectorOps(st, transaction) {
  return {
    /** Store Float32Array vectors for `model`: rows are [{id, vec}]. */
    putVectors(model, rows) {
      transaction(() => {
        for (const r of rows) st.putVec.run(r.id, model, r.vec.length, Buffer.from(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength));
      });
    },
    /** Up to `limit` chunks that have no vector for `model`: [{id, text}]. */
    chunksWithoutVector: (model, limit) => st.unembedded.all(model, limit),
    /** Number of stored vectors for `model`. */
    vectorCount: (model) => st.countVecs.get(model).n,
    /** Stream every stored vector for `model` as {id, vec: Float32Array}, one row at a time (never all in memory). */
    * iterateVectors(model) {
      for (const r of st.loadVecs.iterate(model)) {
        yield { id: r.chunk_id, vec: new Float32Array(r.vec.buffer.slice(r.vec.byteOffset, r.vec.byteOffset + r.dim * 4)) };
      }
    },
  };
}

/** Open (creating the directory and schema) the recall database and return its store API. */
export function openStore(path = defaultDbPath()) {
  const db = openDatabase(path);
  const st = prepareStatements(db);
  const transaction = makeTransaction(db);
  return {
    db, transaction, close: () => db.close(),
    ...chunkWrites(st), ...fileState(db, st), ...reads(db, st), ...vectorOps(st, transaction),
  };
}
