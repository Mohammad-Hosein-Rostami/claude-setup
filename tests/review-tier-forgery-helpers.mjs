// What the writer of a fix can do to a lane's git dir without making a commit, for the review-tier tests: a commit-graph with other
// parents, an object rewritten in place (loose, or behind a forged pack index), a tree entry made from bytes, and a `git` on PATH that
// records every call the tool makes.
// Exports: forgeCommitGraph(dir, edits), looseObjectFile(dir, oid), rewriteLooseObject(dir, oid, type, body), forgePackedBlob(dir, oid, text),
//   commitEntries(dir, entries, message), spyGit() -> { env, calls }.
// Sources: the probes of the security review and of the spec check of lane r7-delta, fix round 4 (`cg-patch.mjs`, p13 C, `forge-idx.mjs`).
// Invariants: every repo is a temp repo of the caller (the `git` helper refuses any other folder); nothing here reads the user's git config.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { CLEAN_ENV, git } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const GRAPH_HEADER_BYTES = 8;
const CHUNK_ROW_BYTES = 12;
const OID_BYTES = 20;
const COMMIT_DATA_BYTES = 36; // per commit: its tree oid, two parent slots, generation and date
const NO_PARENT = 0x70000000;
const FANOUT_ENTRIES = 256;
const WORD_BYTES = 4;
const IDX_HEADER_BYTES = 8;
const objectsOf = (dir) => join(realpathSync(join(dir, git(dir, 'rev-parse', '--git-common-dir'))), 'objects');

/** Writes `buffer` back with a fresh SHA-1 trailer over everything before it (commit-graph and pack index files end with one). */
function writeWithTrailer(file, buffer) {
  createHash('sha1').update(buffer.subarray(0, buffer.length - OID_BYTES)).digest().copy(buffer, buffer.length - OID_BYTES);
  chmodSync(file, 0o644);
  writeFileSync(file, buffer);
}

/**
 * Writes a commit-graph for every reachable commit, then gives commits other parents in it (security B8): git takes parents from this
 * file for every commit past the endpoints of a walk, and no commit changes.
 * @param {string} dir the repo
 * @param {[string, string | null, number][]} edits `[child, parent, level]`: the commit, its one parent in the forged graph (null: a root)
 *   and its topological level there; full shas of commits a ref reaches
 */
export function forgeCommitGraph(dir, edits) {
  git(dir, '-c', 'commitGraph.generationVersion=1', 'commit-graph', 'write', '--reachable');
  const file = join(objectsOf(dir), 'info', 'commit-graph');
  const graph = Buffer.from(readFileSync(file));
  const chunks = {};
  for (let at = 0; at <= graph[6]; at++) {
    const row = GRAPH_HEADER_BYTES + at * CHUNK_ROW_BYTES;
    chunks[graph.toString('latin1', row, row + WORD_BYTES)] = Number(graph.readBigUInt64BE(row + WORD_BYTES));
  }
  const count = graph.readUInt32BE(chunks.OIDF + (FANOUT_ENTRIES - 1) * WORD_BYTES);
  const oids = Array.from({ length: count }, (_, at) => graph.toString('hex', chunks.OIDL + at * OID_BYTES, chunks.OIDL + (at + 1) * OID_BYTES));
  const indexOf = (oid) => {
    if (!oids.includes(oid)) throw new Error(`not in the commit-graph: ${oid}`);
    return oids.indexOf(oid);
  };
  for (const [child, parent, level] of edits) {
    const at = chunks.CDAT + indexOf(child) * COMMIT_DATA_BYTES + OID_BYTES;
    graph.writeUInt32BE(parent === null ? NO_PARENT : indexOf(parent), at);
    graph.writeUInt32BE(NO_PARENT, at + WORD_BYTES);
    graph.writeUInt32BE(((level << 2) | (graph.readUInt32BE(at + 2 * WORD_BYTES) & 3)) >>> 0, at + 2 * WORD_BYTES);
  }
  writeWithTrailer(file, graph);
}

/** The file of the loose object `oid` in the repo's object folder. */
export const looseObjectFile = (dir, oid) => join(objectsOf(dir), oid.slice(0, 2), oid.slice(2));

/** Writes other content over the loose object `oid` (security B11): git reads it back under the old name without hashing it. */
export function rewriteLooseObject(dir, oid, type, body) {
  const file = looseObjectFile(dir, oid);
  const content = Buffer.from(body);
  chmodSync(file, 0o644);
  writeFileSync(file, deflateSync(Buffer.concat([Buffer.from(`${type} ${content.length}\0`), content])));
}

/**
 * Makes the blob `oid` read as `text` through a pack: a one-object pack of `text` whose index is rewritten to name `oid`, put into the
 * repo's pack folder, and the loose copy of `oid` removed (spec check U3, `forge-idx.mjs`).
 */
export function forgePackedBlob(dir, oid, text) {
  const packs = join(objectsOf(dir), 'pack');
  mkdirSync(packs, { recursive: true });
  const stored = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: text, encoding: 'utf8', env: CLEAN_ENV }).stdout.trim();
  const packed = spawnSync('git', ['pack-objects', '-q', join(packs, 'pack')], { cwd: dir, input: `${stored}\n`, encoding: 'utf8', env: CLEAN_ENV });
  if (packed.status !== 0) throw new Error(`git pack-objects: ${packed.stderr}`);
  const name = `pack-${packed.stdout.trim()}`;
  rmSync(join(packs, `${name}.rev`), { force: true });
  const file = join(packs, `${name}.idx`);
  const index = Buffer.from(readFileSync(file));
  const first = parseInt(oid.slice(0, 2), 16);
  for (let at = 0; at < FANOUT_ENTRIES; at++) index.writeUInt32BE(at >= first ? 1 : 0, IDX_HEADER_BYTES + at * WORD_BYTES);
  Buffer.from(oid, 'hex').copy(index, IDX_HEADER_BYTES + FANOUT_ENTRIES * WORD_BYTES);
  writeWithTrailer(file, index);
  rmSync(looseObjectFile(dir, oid));
}

/**
 * Commits tree entries made from bytes, without the working tree: a path the file system cannot hold (not UTF-8, or the NFD twin of an
 * NFC name on macOS) and a submodule pointer are entries like any other.
 * @param {string} dir the repo
 * @param {{mode?: string, oid?: string, text?: string, path: string | Buffer}[]} entries `text`: the content of a new blob; `oid` with
 *   mode 160000: a submodule pointer; an `oid` of 40 zeros removes the path
 * @returns {string} the new commit's full sha
 */
export function commitEntries(dir, entries, message) {
  const rows = entries.map(({ mode = '100644', oid, text, path }) => {
    const blob = oid ?? spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: text, encoding: 'utf8', env: CLEAN_ENV }).stdout.trim();
    return Buffer.concat([Buffer.from(`${/^0+$/.test(blob) ? '0' : mode} ${blob}\t`), Buffer.from(path), Buffer.from([0])]);
  });
  const updated = spawnSync('git', ['-c', 'core.precomposeUnicode=false', 'update-index', '-z', '--index-info'], { cwd: dir, input: Buffer.concat(rows), env: CLEAN_ENV });
  if (updated.status !== 0) throw new Error(`git update-index: ${updated.stderr}`);
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

/** The real git on PATH, as an absolute path. */
function realGit() {
  const found = process.env.PATH.split(delimiter).map((folder) => join(folder, 'git')).find((file) => statSync(file, { throwIfNoEntry: false })?.isFile());
  if (found === undefined) throw new Error('no git on PATH');
  return found;
}

/**
 * A `git` put first on PATH that appends one JSON line per call to a log (cwd, argv, and the GIT_*, HOME and XDG_CONFIG_HOME variables it
 * got) and then runs the real git with the same arguments, input and output. Two switches, read from its environment:
 * SPY_GIT_VERSION: the line `--version` prints (an old git); SPY_AFTER_REFUSALS: a JSON argv the real git runs in the same folder right
 * after the tool's last refusal check (`rev-parse --is-shallow-repository`): what a process the writer left running could still do.
 * POSIX only (the script starts with `#!<node>`).
 * @returns {{env: Object<string, string>, calls: () => {cwd: string, argv: string[], env: Object<string, string>}[]}} `env`: PATH with the spy first
 */
export function spyGit() {
  const folder = realpathSync(makeTempDir('review-tier-spy-'));
  const log = join(folder, 'calls.jsonl');
  mkdirSync(join(folder, 'bin'));
  writeFileSync(join(folder, 'bin', 'git'), `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const argv = process.argv.slice(2);
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(GIT_.*|HOME|XDG_CONFIG_HOME)$/.test(name)));
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), argv, env }) + '\\n');
if (argv.includes('--version') && process.env.SPY_GIT_VERSION) { console.log(process.env.SPY_GIT_VERSION); process.exit(0); }
const result = spawnSync(${JSON.stringify(realGit())}, argv, { stdio: 'inherit' });
if (argv.includes('--is-shallow-repository') && process.env.SPY_AFTER_REFUSALS) spawnSync(${JSON.stringify(realGit())}, JSON.parse(process.env.SPY_AFTER_REFUSALS), { stdio: 'ignore' });
process.exit(result.status === null ? 1 : result.status);
`, { mode: 0o755 });
  const calls = () => (statSync(log, { throwIfNoEntry: false }) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { env: { PATH: `${join(folder, 'bin')}${delimiter}${process.env.PATH}` }, calls };
}
