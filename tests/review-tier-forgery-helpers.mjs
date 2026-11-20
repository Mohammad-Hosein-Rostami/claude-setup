// What the writer of a fix can do to a lane's git dir without making a commit, for the review-tier tests: a commit-graph with other
// parents, an object rewritten in place (loose, or behind a forged pack index), a second copy of an object with other bytes in another
// pack, a tree entry made from bytes, and a `git` on PATH that records every call the tool makes and can misbehave on request.
// Exports: forgeCommitGraph(dir, edits), objectsOf(dir), looseObjectFile(dir, oid), rewriteLooseObject(dir, oid, type, body),
//   forgePackedBlob(dir, oid, text), forgePackedCopy(dir, oid, standIn, options), packOf(dir, oids, folder), renameIndexEntry(file, from, to),
//   commitEntries(dir, entries, message), spyGit() -> { env, calls }, spiedRun(dir, log, args, more) -> { result, real, laneSide, trusted }.
// Sources: the probes of the security reviews and spec checks of lane r7-delta, fix rounds 4 and 5 (`cg-patch.mjs`, p13 C, `forge-idx.mjs`,
//   `forge-idx2.mjs`, p20, p26).
// Invariants: every repo is a temp repo of the caller (the `git` helper refuses any other folder); nothing here reads the user's git config.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { TRUSTED_FLAGS } from '../home/tools/review-tier/lib/trusted-git.mjs';
import { CLEAN_ENV, git } from './git-tidy-helpers.mjs';
import { CLI } from './review-tier-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const GRAPH_HEADER_BYTES = 8;
const CHUNK_ROW_BYTES = 12;
const OID_BYTES = 20;
const COMMIT_DATA_BYTES = 36; // per commit: its tree oid, two parent slots, generation and date
const NO_PARENT = 0x70000000;
const FANOUT_ENTRIES = 256;
const WORD_BYTES = 4;
const IDX_HEADER_BYTES = 8;
const IDX_MAGIC = 0xff744f63;
const OLD_PACK_DATE = new Date('2026-01-01T00:00:00Z'); // git tries packs newest first: an older pack is tried after the honest one
/** The object folder of the repo `dir` (the one linked worktrees share). */
export const objectsOf = (dir) => join(realpathSync(join(dir, git(dir, 'rev-parse', '--git-common-dir'))), 'objects');

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
 * Renames one entry of a version-2 pack index (no large offsets) to another oid: the entries are sorted again, the fan-out table and the
 * trailer rewritten. The pack is untouched, so git then serves that entry's bytes under the new name (`forge-idx2.mjs` of the review).
 */
export function renameIndexEntry(file, from, to) {
  const index = Buffer.from(readFileSync(file));
  if (index.readUInt32BE(0) !== IDX_MAGIC) throw new Error(`not a version-2 pack index: ${file}`);
  const count = index.readUInt32BE(IDX_HEADER_BYTES + (FANOUT_ENTRIES - 1) * WORD_BYTES);
  const [oidsAt, crcAt, offsetsAt] = [0, OID_BYTES, OID_BYTES + WORD_BYTES].map((bytes) => IDX_HEADER_BYTES + FANOUT_ENTRIES * WORD_BYTES + count * bytes);
  const entries = Array.from({ length: count }, (_, at) => ({ oid: index.toString('hex', oidsAt + at * OID_BYTES, oidsAt + (at + 1) * OID_BYTES), crc: index.readUInt32BE(crcAt + at * WORD_BYTES), offset: index.readUInt32BE(offsetsAt + at * WORD_BYTES) }));
  const renamed = entries.find((entry) => entry.oid === from);
  if (renamed === undefined) throw new Error(`${from} is not in ${file}`);
  renamed.oid = to;
  entries.sort((a, b) => (a.oid < b.oid ? -1 : 1));
  for (let at = 0; at < FANOUT_ENTRIES; at++) index.writeUInt32BE(entries.filter((entry) => parseInt(entry.oid.slice(0, 2), 16) <= at).length, IDX_HEADER_BYTES + at * WORD_BYTES);
  entries.forEach((entry, at) => {
    Buffer.from(entry.oid, 'hex').copy(index, oidsAt + at * OID_BYTES);
    index.writeUInt32BE(entry.crc, crcAt + at * WORD_BYTES);
    index.writeUInt32BE(entry.offset, offsetsAt + at * WORD_BYTES);
  });
  writeWithTrailer(file, index);
}

/**
 * Packs the objects `oids` of the repo `dir` into `folder` (undeltified, no reverse index).
 * @returns {string} the path of the new pack without its extension (`<folder>/pack-<hash>`)
 */
export function packOf(dir, oids, folder) {
  mkdirSync(folder, { recursive: true });
  const packed = spawnSync('git', ['pack-objects', '-q', '--window=0', '--depth=0', join(folder, 'pack')], { cwd: dir, input: `${oids.join('\n')}\n`, encoding: 'utf8', env: CLEAN_ENV });
  if (packed.status !== 0) throw new Error(`git pack-objects: ${packed.stderr}`);
  const name = join(folder, `pack-${packed.stdout.trim()}`);
  rmSync(`${name}.rev`, { force: true });
  return name;
}

/**
 * Gives the object `oid` a second copy with the bytes of the object `standIn`: a pack of `standIn` (and of `lures`, objects no other
 * pack then needs to hold) whose index names `oid`. The honest copy of `oid` stays where it is unless `removeLoose`.
 * @param {{lures?: string[], folder?: string, old?: boolean, removeLoose?: boolean}} options `folder`: where the pack goes (default: the
 *   repo's own pack folder; another object folder for the alternates route); `old`: date the pack before every other, so git tries it
 *   last until it serves a lure (probe p26)
 */
export function forgePackedCopy(dir, oid, standIn, { lures = [], folder = join(objectsOf(dir), 'pack'), old = false, removeLoose = false } = {}) {
  const made = packOf(dir, [...lures, standIn], realpathSync(makeTempDir('review-tier-pack-')));
  renameIndexEntry(`${made}.idx`, standIn, oid);
  mkdirSync(folder, { recursive: true });
  for (const kind of ['pack', 'idx']) {
    if (old) utimesSync(`${made}.${kind}`, OLD_PACK_DATE, OLD_PACK_DATE);
    renameSync(`${made}.${kind}`, join(folder, `${made.split(/[\\/]/).at(-1)}.${kind}`));
  }
  if (removeLoose) rmSync(looseObjectFile(dir, oid));
}

/**
 * Makes the blob `oid` read as `text` through a pack: a one-object pack of `text` whose index is rewritten to name `oid`, put into the
 * repo's pack folder, and the loose copy of `oid` removed (spec check U3, `forge-idx.mjs`).
 */
export function forgePackedBlob(dir, oid, text) {
  const stored = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: text, encoding: 'utf8', env: CLEAN_ENV }).stdout.trim();
  forgePackedCopy(dir, oid, stored, { removeLoose: true });
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
 * got) and then runs the real git with the same arguments, input and output. Switches, read from its environment:
 * SPY_GIT_VERSION: the line `--version` prints (an old git);
 * SPY_AFTER_REFUSALS: a JSON argv the real git runs in the same folder right after the tool's last refusal check
 *   (`rev-parse --is-shallow-repository`): what a process the writer left running could still do;
 * SPY_AFTER_INIT: JSON `{file, text}`: a file written into the new repository right after `git init` made it;
 * SPY_AFTER_IMPORT: JSON `{nth, file, text}`: the same right after the nth import (`git index-pack`; 1: the commits, 2: trees and files);
 * SPY_SWAP: JSON `{from, to}`: in the listings the import makes on the lane's side (`rev-list`, `ls-tree`, `diff-tree` with the lane's
 *   objects borrowed) every `from` is printed as `to`, so the object `from` is left out of the import list;
 * SPY_FAIL: JSON `{word, status?, stderr}`: a call of the tool's own repository (no objects borrowed) whose arguments hold `word` also
 *   writes `stderr`, and exits `status` instead of running when one is given.
 * POSIX only (the script starts with `#!<node>`).
 * @returns {{env: Object<string, string>, calls: () => {cwd: string, argv: string[], env: Object<string, string>}[]}} `env`: PATH with the spy first
 */
export function spyGit() {
  const folder = realpathSync(makeTempDir('review-tier-spy-'));
  const log = join(folder, 'calls.jsonl');
  mkdirSync(join(folder, 'bin'));
  writeFileSync(join(folder, 'bin', 'git'), `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { spawnSync } = require('node:child_process');
const argv = process.argv.slice(2);
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(GIT_.*|HOME|XDG_CONFIG_HOME)$/.test(name)));
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), argv, env }) + '\\n');
const switchOf = (name) => (process.env[name] ? JSON.parse(process.env[name]) : null);
if (argv.includes('--version') && process.env.SPY_GIT_VERSION) { console.log(process.env.SPY_GIT_VERSION); process.exit(0); }
const borrows = env.GIT_ALTERNATE_OBJECT_DIRECTORIES !== undefined;
const fail = switchOf('SPY_FAIL');
if (fail && env.GIT_DIR !== undefined && !borrows && argv.includes(fail.word)) {
  process.stderr.write(fail.stderr + '\\n');
  if (fail.status !== undefined) process.exit(fail.status);
}
const swap = switchOf('SPY_SWAP');
const swapped = swap && borrows && argv.some((word) => ['rev-list', 'ls-tree', 'diff-tree'].includes(word));
const result = spawnSync(${JSON.stringify(realGit())}, argv, { stdio: swapped ? ['inherit', 'pipe', 'inherit'] : 'inherit', maxBuffer: 1 << 30 });
if (swapped) process.stdout.write(Buffer.from(result.stdout.toString('latin1').split(swap.from).join(swap.to), 'latin1'));
const plant = (planted) => { mkdirSync(dirname(join(env.GIT_DIR, planted.file)), { recursive: true }); writeFileSync(join(env.GIT_DIR, planted.file), planted.text); };
if (switchOf('SPY_AFTER_INIT') && argv.includes('init')) plant(switchOf('SPY_AFTER_INIT'));
const imports = argv.includes('index-pack') ? readFileSync(${JSON.stringify(log)}, 'utf8').split('\\n').filter((line) => line.includes('"index-pack"')).length : 0;
if (switchOf('SPY_AFTER_IMPORT') && imports === switchOf('SPY_AFTER_IMPORT').nth) plant(switchOf('SPY_AFTER_IMPORT'));
if (argv.includes('--is-shallow-repository') && process.env.SPY_AFTER_REFUSALS) spawnSync(${JSON.stringify(realGit())}, JSON.parse(process.env.SPY_AFTER_REFUSALS), { stdio: 'ignore' });
process.exit(result.status === null ? 1 : result.status);
`, { mode: 0o755 });
  const calls = () => (statSync(log, { throwIfNoEntry: false }) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { env: { PATH: `${join(folder, 'bin')}${delimiter}${process.env.PATH}` }, calls };
}

/**
 * Runs the CLI in `dir` with the recording git first on PATH and sorts its git calls by where they read.
 * @param {string} dir the lane's working folder
 * @param {string} log the path the CLI's own log goes to
 * @param {string[]} args the CLI's arguments
 * @param {Object<string, string>} more extra environment (the spy's switches, hostile variables)
 * @returns {{result: object, real: object[], laneSide: object[], trusted: object[]}} `real`: calls in the lane's own repository (no
 *   GIT_DIR); `laneSide`: the import's calls, in the tool's repository with the lane's objects borrowed; `trusted`: every other call of
 *   the tool's repository. Each call has `at` (its place among all calls), `command` (its arguments after the fixed flags and the
 *   attribute source) and `attrSource` (the sha of `--attr-source=`, or undefined)
 */
export function spiedRun(dir, log, args, more = {}) {
  const spy = spyGit();
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', env: { ...CLEAN_ENV, REVIEW_TIER_LOG: log, ...spy.env, ...more } });
  const calls = spy.calls().map((call, at) => {
    const words = call.argv.slice(call.env.GIT_DIR === undefined ? 0 : TRUSTED_FLAGS.length);
    const attrSource = /^--attr-source=(.*)$/.exec(words[0] ?? '')?.[1];
    return { ...call, at, attrSource, command: attrSource === undefined ? words : words.slice(1) };
  });
  const inTool = calls.filter((call) => call.env.GIT_DIR !== undefined);
  const borrows = (call) => call.env.GIT_ALTERNATE_OBJECT_DIRECTORIES !== undefined;
  return { result, real: calls.filter((call) => call.env.GIT_DIR === undefined), laneSide: inTool.filter(borrows), trusted: inTool.filter((call) => !borrows(call)) };
}
