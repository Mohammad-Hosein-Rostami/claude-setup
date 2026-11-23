// Purpose: discover transcripts and docs under RECALL_ROOT and write their chunks into the store, incrementally.
// Exports: indexAll, discoverFiles, resolveRoot, resolveHome.
// Invariants: main transcripts resume from the stored byte offset and only consume newline-terminated lines (an
// unterminated last line waits for its newline, so line numbers never drift); a rewritten file (hash of its first
// 4 KB changed) is re-indexed whole, as are subagent files and docs when size or mtime change; files that vanished
// lose their chunks; docs are regular .md files only (symlinks skipped, also symlinked directories below a recall.json
// glob root); files are read in 1 MiB pieces; a deadline stops work between lines, and a capped subagent file yields
// no partial brief/report.
import { closeSync, existsSync, globSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { createTranscriptParser, extractDoc } from './extract.mjs';

const NEWLINE = 10;
const DEADLINE_CHECK_EVERY = 200;
const CWD_DOC_NAMES = ['CLAUDE.md', 'HANDOFF.md', 'STATUS.md'];
const MAX_DOC_DEPTH = 3;
const HEAD_BYTES = 4096;
const READ_CHUNK_BYTES = 1 << 20;

/** Transcript root: RECALL_ROOT, else ~/.claude/projects. */
export const resolveRoot = (env = process.env) => env.RECALL_ROOT || join(homedir(), '.claude', 'projects');
/** Home of project-notes/ (the personal notes) and recall.json: RECALL_HOME, else the parent of the root. */
export const resolveHome = (root, env = process.env) => env.RECALL_HOME || dirname(root);
/** The core repo's shared notes: project-notes beside the folder <home>/tools links to (the repo's home/); null without that. */
const sharedNotesDir = (home) => (existsSync(join(home, 'tools')) ? join(dirname(realpathSync(join(home, 'tools'))), 'project-notes') : null);

/** Directory entries; a missing dir is silently empty, any other failure is reported on stderr and treated as empty. */
function listDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`recall: cannot read ${dir}: ${error.code ?? error.message}`);
    return [];
  }
}

/** lstat of `path` (never follows a link); null when it is gone, other failures are reported on stderr. */
function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`recall: cannot stat ${path}: ${error.code ?? error.message}`);
    return null;
  }
}

/** True for a regular file that is not a symlink (docs are never followed through links). */
const isPlainFile = (path) => lstatOrNull(path)?.isFile() ?? false;

/** True for a path that exists and is not itself a symlink. */
const isPlainEntry = (path) => {
  const stat = lstatOrNull(path);
  return stat !== null && !stat.isSymbolicLink();
};

const mdFiles = (dir) => listDir(dir).filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => join(dir, e.name));

function decisionDocs(dir, depth = 0) {
  if (depth > MAX_DOC_DEPTH) return [];
  return listDir(dir).flatMap((e) => {
    if (e.isDirectory()) return decisionDocs(join(dir, e.name), depth + 1);
    return e.isFile() && /^decisions.*\.md$/i.test(e.name) ? [join(dir, e.name)] : [];
  });
}

function projectFiles(root, project) {
  const dir = join(root, project);
  const files = [];
  for (const e of listDir(dir)) {
    if (e.isFile() && e.name.endsWith('.jsonl')) {
      files.push({ path: join(dir, e.name), type: 'main', project, session: basename(e.name, '.jsonl') });
    } else if (e.isDirectory() && e.name !== 'memory') {
      const sub = join(dir, e.name, 'subagents');
      for (const s of listDir(sub).filter((x) => x.isFile() && x.name.endsWith('.jsonl'))) {
        files.push({ path: join(sub, s.name), type: 'agent', project, session: e.name });
      }
    }
  }
  for (const doc of mdFiles(join(dir, 'memory'))) files.push({ path: doc, type: 'doc', project, session: basename(doc) });
  return files;
}

const GLOB_CHARS = /[*?[\]{}()!+@]/;

/** The literal leading directory of a glob pattern (the part before the first segment with a wildcard). */
function globRoot(pattern) {
  const segments = pattern.split(/[\\/]/);
  const wild = segments.findIndex((s) => GLOB_CHARS.test(s));
  const literal = wild === -1 ? segments.slice(0, -1) : segments.slice(0, wild);
  return literal.join('/') || (segments[0] === '' ? '/' : '.');
}

/** True when any path segment below `root` down to `path` (itself included) is a symlink, or cannot be inspected. */
function crossesSymlink(root, path) {
  let current = root;
  for (const segment of relative(root, path).split(sep)) {
    current = join(current, segment);
    if (!isPlainEntry(current)) return true;
  }
  return false;
}

function extraGlobDocs(home) {
  const configPath = join(home, 'recall.json');
  if (!existsSync(configPath)) return [];
  const config = JSON.parse(readFileSync(configPath, 'utf8')); // a broken config should fail loudly
  const patterns = Array.isArray(config.docs) ? config.docs : [];
  return patterns.flatMap((pattern) => {
    const root = globRoot(pattern);
    return globSync(pattern).filter((path) => /\.md$/i.test(path) && isPlainFile(path) && !crossesSymlink(root, path));
  });
}

/** Every file recall indexes: transcripts, subagent transcripts and docs (personal and shared project notes among them). */
export function discoverFiles({ root, home, cwds, sharedNotes = sharedNotesDir(home) }) {
  const files = listDir(root).filter((e) => e.isDirectory()).flatMap((e) => projectFiles(root, e.name));
  const asDoc = (path, project) => ({ path, type: 'doc', project, session: basename(path) });
  const notes = [...mdFiles(join(home, 'project-notes')), ...(sharedNotes ? mdFiles(sharedNotes) : [])];
  for (const note of notes) files.push(asDoc(note, 'project-notes'));
  for (const cwd of cwds.filter(existsSync)) {
    const project = basename(cwd);
    const named = CWD_DOC_NAMES.map((n) => join(cwd, n)).filter(isPlainFile);
    for (const doc of [...named, ...decisionDocs(join(cwd, 'docs'))]) files.push(asDoc(doc, project));
  }
  for (const doc of extraGlobDocs(home)) files.push(asDoc(doc, 'extra'));
  const seen = new Set();
  return files.filter((f) => !seen.has(f.path) && seen.add(f.path));
}

/** The agentType from the optional `.meta.json`; a missing file is normal, any other failure is counted and reported. */
function readAgentType(path, totals) {
  const metaPath = path.replace(/\.jsonl$/, '.meta.json');
  try {
    return JSON.parse(readFileSync(metaPath, 'utf8')).agentType || 'agent';
  } catch (error) {
    if (error.code !== 'ENOENT') {
      totals.bad += 1;
      console.error(`recall: cannot read ${metaPath}: ${error.code ?? error.message}`);
    }
    return 'agent';
  }
}

/** Up to `length` bytes of the open file starting at `offset` (fewer at end of file). */
function readRange(fd, offset, length) {
  const buffer = Buffer.alloc(length);
  const got = readSync(fd, buffer, 0, length, offset);
  return got < length ? buffer.subarray(0, got) : buffer;
}

function readHead(path, length) {
  const fd = openSync(path, 'r');
  try {
    return readRange(fd, 0, length);
  } finally {
    closeSync(fd);
  }
}

/**
 * Feed newline-terminated lines of `buffer` to the parser. An unterminated last line is never consumed: the offset
 * stops after the last newline. Returns bytes consumed, lines consumed and whether time ran out.
 */
function consumeLines(buffer, startLine, parser, emit, deadline) {
  let pos = 0;
  let line = startLine;
  for (let end = buffer.indexOf(NEWLINE, pos); end !== -1; end = buffer.indexOf(NEWLINE, pos)) {
    line += 1;
    emit(parser.feed(buffer.subarray(pos, end).toString('utf8'), line));
    pos = end + 1;
    if (line % DEADLINE_CHECK_EVERY === 0 && Date.now() > deadline) return { pos, line, capped: true };
  }
  return { pos, line, capped: false };
}

/**
 * Read the file from `start.offset` to `size` in READ_CHUNK_BYTES pieces (never the whole file at once), feeding the
 * newline-terminated lines to the parser; a line split across pieces is carried over. Returns what consumeLines does,
 * with `pos` counted from `start.offset`.
 */
function consumeFile(path, start, size, parser, emit, deadline) {
  const fd = openSync(path, 'r');
  try {
    let readAt = start.offset;
    let consumed = 0;
    let line = start.lines;
    let carry = Buffer.alloc(0);
    while (readAt < size) {
      const chunk = readRange(fd, readAt, Math.min(READ_CHUNK_BYTES, size - readAt));
      if (!chunk.length) break;
      readAt += chunk.length;
      const buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const result = consumeLines(buffer, line, parser, emit, deadline);
      consumed += result.pos;
      line = result.line;
      if (result.capped) return { pos: consumed, line, capped: true };
      carry = buffer.subarray(result.pos);
    }
    return { pos: consumed, line, capped: false };
  } finally {
    closeSync(fd);
  }
}

/** Fingerprint of the first min(4 KB, `length`) bytes: "<bytes>:<sha1>". A rewrite changes it; an append does not. */
function headFingerprint(path, length) {
  const bytes = Math.min(HEAD_BYTES, length);
  return `${bytes}:${createHash('sha1').update(readHead(path, bytes)).digest('hex')}`;
}

/** True when the first bytes of the file still hash to what was stored (false: the file was rewritten). */
function headUnchanged(path, row) {
  if (!row.head) return false;
  const bytes = Number(row.head.split(':')[0]);
  return statSync(path).size >= bytes && headFingerprint(path, bytes) === row.head;
}

function plan(file, stat, row, full) {
  if (!row || full) return { reset: true, offset: 0, lines: 0 };
  if (row.size === stat.size && row.mtime === stat.mtime) return null;
  if (file.type === 'main' && stat.size >= row.offset && stat.mtime >= row.mtime && headUnchanged(file.path, row)) {
    return { reset: false, offset: row.offset, lines: row.lines };
  }
  return { reset: true, offset: 0, lines: 0 };
}

function indexTranscript(store, file, stat, start, deadline, totals) {
  const meta = { project: file.project, session: file.session, source: file.path };
  const agent = file.type === 'agent';
  const parser = createTranscriptParser({ mode: agent ? 'agent' : 'main', agentType: agent ? readAgentType(file.path, totals) : undefined });
  const emit = (chunks) => { for (const c of chunks) if (store.addChunk({ ...meta, ...c })) totals.added += 1; };
  const result = consumeFile(file.path, start, stat.size, parser, emit, deadline);
  if (agent && !result.capped) emit(parser.finish()); // a capped agent file would yield a partial brief/report
  for (const cwd of parser.cwds) store.addCwd(cwd);
  totals.bad += parser.bad;
  // mtime 0 marks a partial run so the next index resumes instead of treating the file as unchanged.
  const mtime = result.capped ? 0 : stat.mtime;
  const offset = start.offset + result.pos;
  const head = headFingerprint(file.path, offset);
  store.putFile({ path: file.path, size: stat.size, mtime, offset, lines: result.line, head });
  return result.capped;
}

function indexDoc(store, file, stat, totals) {
  const meta = { project: file.project, session: file.path, source: file.path };
  for (const c of extractDoc(readFileSync(file.path, 'utf8'), stat.mtime)) {
    if (store.addChunk({ ...meta, ...c })) totals.added += 1;
  }
  store.putFile({ path: file.path, size: stat.size, mtime: stat.mtime, offset: stat.size, lines: 0 });
}

/**
 * Index everything under root/home into the store. `deadline` is an epoch ms cutoff (default none), `full` re-indexes
 * all files. Returns { added, files, bad, capped }.
 */
export function indexAll(store, { root, home = resolveHome(root), deadline = Infinity, full = false }) {
  const totals = { added: 0, files: 0, bad: 0, capped: false };
  const cwdCount = store.listCwds().length;
  pruneVanished(store);
  runPass(store, { root, home, deadline, full }, totals);
  // Transcripts reveal new cwds; a second cheap pass picks up their docs (unchanged files are skipped).
  if (!totals.capped && store.listCwds().length !== cwdCount) runPass(store, { root, home, deadline, full: false }, totals);
  return totals;
}

/** Delete the chunks and state of indexed files that no longer exist on disk. */
function pruneVanished(store) {
  for (const path of store.listFilePaths()) {
    if (existsSync(path)) continue;
    store.transaction(() => {
      store.deleteSource(path);
      store.deleteFile(path);
    });
  }
}

function runPass(store, { root, home, deadline, full }, totals) {
  for (const file of discoverFiles({ root, home, cwds: store.listCwds() })) {
    if (Date.now() > deadline) { totals.capped = true; break; }
    let stat;
    try {
      const s = statSync(file.path);
      stat = { size: s.size, mtime: Math.floor(s.mtimeMs) };
    } catch {
      continue; // vanished between discovery and stat
    }
    const start = plan(file, stat, store.getFile(file.path), full);
    if (!start) continue;
    totals.files += 1;
    store.transaction(() => {
      if (start.reset) store.deleteSource(file.path);
      if (file.type === 'doc') indexDoc(store, file, stat, totals);
      else totals.capped = indexTranscript(store, file, stat, start, deadline, totals) || totals.capped;
    });
    if (totals.capped) break;
  }
}
