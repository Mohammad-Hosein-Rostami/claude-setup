// Temp folders for tests that remove themselves. Exports: TEST_TEMP_PREFIX, makeTempDir, removeTempDir.
// Why: 82 of 107 test files used to call mkdtemp and never remove the folder, so every test run left thousands of folders in
// os.tmpdir() (1.1 million entries measured). Every test makes its folders here; the process-exit hook below removes whatever
// is left, also when a test throws. The prefix lets home/tools/disk-free/disk-clean.mjs find leftovers of a killed run.
// Invariants: os.tmpdir() is read at call time (so a launcher's TMPDIR counts) unless it is inside Claude Code's temp tree or long
// (testTempRoot); only folders this process made are removed.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

export const TEST_TEMP_PREFIX = 'cs-test-';

// A session's TMPDIR can be its scratchpad, `/private/tmp/claude-501/<project>/<session>/scratchpad/...` (180 chars and more). There
// a fixture path passes the 160-char cuts of doctor's project rows and the writer gate's quotes, so a test no longer finds its own
// path in the output, and the guard reads every fixture as inside that real session tree (the `claude-<uid>` tree nearest the temp
// root), not as the fake tree a test builds. A root inside such a tree or past this length is replaced (testTempRoot).
export const MAX_TEMP_ROOT_CHARS = 80; // macOS's own temp root is 49 chars; one cs-test folder made a TMPDIR stays below this
const CLAUDE_TREE_FOLDER = /^claude-\d+$/; // Claude Code keeps `<temp>/claude-<uid>/<project>/<session>/`
const SHORT_POSIX_ROOT = '/tmp';
const PATH_PARTS = process.platform === 'win32' ? /[\\/]/ : /\//; // on POSIX a backslash is part of a name

/**
 * The folder test folders are made in by default: os.tmpdir(), or the folder that holds Claude Code's `claude-<uid>` tree when
 * os.tmpdir() lies inside one, or `/tmp` (POSIX) when that is still longer than MAX_TEMP_ROOT_CHARS.
 * @param {string} temp the temp root to start from
 * @returns {string} a root outside every `claude-<uid>` tree, short where the platform has a short root
 */
export function testTempRoot(temp = tmpdir()) {
  const parts = temp.split(PATH_PARTS);
  const tree = parts.findIndex((part) => CLAUDE_TREE_FOLDER.test(part));
  const root = tree === -1 ? temp : parts.slice(0, tree).join(sep) || sep;
  return root.length > MAX_TEMP_ROOT_CHARS && process.platform !== 'win32' ? SHORT_POSIX_ROOT : root;
}

const madeHere = new Set();

/** Removes one folder now (and forgets it). Prints a line to stderr when removing fails: a leftover must be seen, not hidden. */
export function removeTempDir(dir) {
  madeHere.delete(dir);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    console.error(`temp-dir-helpers: could not remove ${dir}: ${error.message}`);
  }
}

/**
 * Makes a fresh folder `<root>/cs-test-<label>XXXXXX` that is removed when this process ends.
 * @param {string} label what the folder is for, usually ending in `-` (like the prefix of an mkdtemp call)
 * @param {string} root where to make it (default testTempRoot()); only a test that needs a short path (a unix socket path holds about
 *   100 bytes) passes '/tmp'
 * @returns {string} the folder path
 */
export function makeTempDir(label = '', root = testTempRoot()) {
  const dir = mkdtempSync(join(root, `${TEST_TEMP_PREFIX}${label}`));
  madeHere.add(dir);
  return dir;
}

process.on('exit', () => {
  for (const dir of [...madeHere]) removeTempDir(dir);
});
