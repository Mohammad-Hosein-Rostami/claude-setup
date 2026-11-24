// Fake executables written once and shared by every test file and every suite run. Exports: SHARED_TOOLS_PREFIX,
// sharedToolDir(files), sharedTool(name, body), linkSharedTool(dir, name, body), sharedNodeToolDir(name, script).
// Why: macOS checks each newly written executable on its first run (about 1 s, more on a loaded machine). A test that writes its
// own fake per test pays that every time; a shared fake pays it once, when it is first written, and never again.
// How: one fixed folder per user under testTempRoot() (`cs-test-shared-tools-<uid>`, like clean-env.mjs's quiet tools), and in it
// one folder per content hash of the tool set, so two bodies with the same tool name never collide and a folder never changes
// once written. Each file is written to `<file>.<pid>.tmp`, made runnable and renamed into place, so a parallel test file never
// runs a half-written tool; the process that writes a tool warms it (warmExecInert: the OS check without running the tool), a
// process that finds it ready does not.
// Invariants: POSIX only (on win32 a test keeps its own per-test `.cmd`); a body holds no per-test data (a test passes its log
// file, answer, delay or repo path in environment variables the tool reads when it runs), so a shared tool is the same for every
// test; the folders are this user's own (owner-only, no symlink) or this module throws. Nothing removes them during a run: each
// use sets their time to now, so disk-clean's test-temp rule (cs-test-* idle 1 day) removes them only after a day with no test run.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEST_TEMP_PREFIX, testTempRoot } from './temp-dir-helpers.mjs';
import { warmExecInert } from './warm-exec.mjs';

export const SHARED_TOOLS_PREFIX = `${TEST_TEMP_PREFIX}shared-tools-`;
const OWNER_ONLY = 0o700;
const RUNNABLE = 0o755;
const WRITABLE_BY_OTHERS = 0o022;
const HASH_CHARS = 20; // 80 bits of sha256: no two tool sets of this suite share a folder
const ready = new Map(); // hash -> folder, the tool sets this process has checked or written

/** Makes `dir` if needed and throws unless it is a real folder of this user that no one else can write to. */
function ownFolder(dir) {
  mkdirSync(dir, { recursive: true, mode: OWNER_ONLY });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & WRITABLE_BY_OTHERS) !== 0) {
    throw new Error(`shared-tools: ${dir} is not this user's own folder; remove it and rerun`);
  }
}

/** @returns {boolean} true when `file` is this user's own runnable regular file holding exactly `body` */
function isReady(file, body) {
  if (!existsSync(file)) return false;
  const stat = lstatSync(file);
  return stat.isFile() && stat.uid === process.getuid() && (stat.mode & RUNNABLE) === RUNNABLE && readFileSync(file, 'utf8') === body;
}

/**
 * The folder that holds this set of fake tools, written (and warmed) on first use.
 * @param {Record<string, string>} files tool name -> script text (with its `#!` line)
 * @returns {string} a folder holding exactly these tools, the same path for the same set in every test file
 */
export function sharedToolDir(files) {
  if (process.platform === 'win32') throw new Error('shared-tools: POSIX only; a Windows test writes its own .cmd');
  const entries = Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1));
  const hash = createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, HASH_CHARS);
  const known = ready.get(hash);
  if (known !== undefined) return known;
  const root = join(testTempRoot(), `${SHARED_TOOLS_PREFIX}${process.getuid()}`);
  const dir = join(root, hash);
  ownFolder(root);
  ownFolder(dir);
  const written = [];
  for (const [name, body] of entries) {
    const file = join(dir, name);
    if (isReady(file, body)) continue;
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, body);
    chmodSync(temp, RUNNABLE);
    renameSync(temp, file);
    written.push(file);
  }
  for (const file of written) warmExecInert(file);
  const now = new Date();
  for (const folder of [root, dir]) utimesSync(folder, now, now);
  ready.set(hash, dir);
  return dir;
}

/**
 * @param {string} name the tool's file name (what a PATH lookup finds)
 * @param {string} body the script text
 * @returns {string} the path of the shared tool
 */
export const sharedTool = (name, body) => join(sharedToolDir({ [name]: body }), name);

/**
 * Puts the shared tool `name` into a test's own folder as a symlink (a link is not a new executable, so it costs no first-run check).
 * @param {string} dir the test's folder (usually a bin folder first on its PATH)
 * @param {string} name the tool's file name
 * @param {string} body the script text
 * @returns {string} the link's path
 */
export function linkSharedTool(dir, name, body) {
  const link = join(dir, name);
  symlinkSync(sharedTool(name, body), link);
  return link;
}

/**
 * A shared folder holding the fake tool `name`: a sh wrapper that exits 0 under FAKE_WARM and otherwise runs `script` (kept beside
 * it as fake.cjs) with node, passing its arguments on. `exec` keeps one process, so a pid the script writes is the tool's own.
 * @param {string} name the tool's file name (e.g. osascript, zenity)
 * @param {string} script the CommonJS text node runs
 * @returns {string} the folder, to put first on PATH
 */
export const sharedNodeToolDir = (name, script) =>
  sharedToolDir({ 'fake.cjs': script, [name]: '#!/bin/sh\n[ -n "$FAKE_WARM" ] && exit 0\nexec node "$(dirname "$0")/fake.cjs" "$@"\n' });
