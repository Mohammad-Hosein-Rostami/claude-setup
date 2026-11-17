// The PASS records of test-pass: which git tree passed which test command, kept per clone under ~/.claude/state/test-pass.
// Exports: declaredSuite(repoDir), treeOf(repoDir, rev), commitOf(repoDir, rev), isCleanTree(repoDir), recordPass(repoDir, row, env), hasPass(repoDir, rev, options),
// MAX_ROWS.
// Why: landing a branch should rerun the full suite only when no run already passed on that exact tree (hash of the files, not of
// the commit: a rebase that changes no file keeps the tree, so its PASS still counts).
// Invariants: a record is written only for a tree that has no uncommitted change; the file is a private regular file of this user
// (a link, folder or foreign file there makes the store unusable: nothing is read or written), the folder is 0700 and the file 0600.
// A row that cannot be parsed is skipped. A lost or unreadable record can only cost a rerun, never produce a false PASS.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isPrivateFile, lstatOrNull, privateFolder } from '../../../hooks/lib/session-store.mjs';

export const MAX_ROWS = 200; // the newest rows kept per clone
const FILE_MODE = 0o600;
const ID_LENGTH = 16; // hex characters of the clone's folder hash in the file name
const SUITE_LINE = /^\s*[-*]?\s*(?:Full suite|Tests?):\s*`([^`]+)`/im; // a CLAUDE.md bullet such as: - Tests: `node --test tests/*.test.mjs`
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

function git(repoDir, args) {
  const result = spawnSync('git', args, { cwd: repoDir, encoding: 'utf8', maxBuffer: 64 << 20 });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** The hash of the files at `rev` (a commit-ish) in the repo at `repoDir`, or null when git cannot resolve it. */
export const treeOf = (repoDir, rev) => (rev.startsWith('-') ? null : git(repoDir, ['rev-parse', '--verify', '--quiet', `${rev}^{tree}`]));

/** The full hash of the commit `rev` names, or null when git cannot resolve it. */
export const commitOf = (repoDir, rev) => (rev.startsWith('-') ? null : git(repoDir, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]));

/** True when the working tree has no tracked change (staged or not) and no untracked file git does not ignore. */
export const isCleanTree = (repoDir) => git(repoDir, ['status', '--porcelain', '--untracked-files=normal']) === '';

/**
 * The command that runs the whole test suite of the repo, as the repo declares it: the `test` script of the root package.json,
 * else a CLAUDE.md bullet `Full suite: `<cmd>`` or `Tests: `<cmd>``. There is no override: to change it, commit the change.
 * @param {string} repoDir any folder of the working tree
 * @returns {string | null} the command text, or null when the repo declares none
 */
export function declaredSuite(repoDir) {
  const top = git(repoDir, ['rev-parse', '--show-toplevel']);
  if (top === null) return null;
  try {
    const script = JSON.parse(readFileSync(join(top, 'package.json'), 'utf8')).scripts?.test;
    if (typeof script === 'string' && script.trim() !== '') return script.trim();
  } catch {
    // no package.json, or one that does not parse: look at CLAUDE.md
  }
  try {
    return SUITE_LINE.exec(readFileSync(join(top, 'CLAUDE.md'), 'utf8'))?.[1].trim() ?? null;
  } catch {
    return null; // no CLAUDE.md
  }
}

/** The state file of the clone that holds `repoDir`: one per git common dir, so every worktree of a clone shares it. */
function recordFile(repoDir, env) {
  const common = git(repoDir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common === null) return null;
  const id = createHash('sha256').update(realpathSync(common)).digest('hex').slice(0, ID_LENGTH);
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  return { dir: join(home, '.claude', 'state', 'test-pass'), path: join(home, '.claude', 'state', 'test-pass', `${id}.jsonl`) };
}

/** Parsed rows of the file, oldest first; [] when the file is missing, unsafe or unreadable. */
function readRows(path) {
  try {
    const entry = lstatOrNull(path);
    if (entry === null || !isPrivateFile(entry)) return [];
    return readFileSync(path, 'utf8').split('\n').flatMap((line) => {
      try {
        const row = JSON.parse(line);
        return typeof row?.tree === 'string' ? [row] : [];
      } catch {
        return []; // a half-written or foreign line
      }
    });
  } catch {
    return [];
  }
}

/** Appends one line with O_APPEND (one small write is atomic), refusing a link or a file that is not a regular file. */
function appendLine(path, line) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NO_FOLLOW, FILE_MODE);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${path} is not a regular file`);
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
}

/** Replaces the file with `rows` through a new temp file, so a reader never sees half of it. */
function rewrite(path, rows) {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, rows.map((row) => `${JSON.stringify(row)}\n`).join(''), { mode: FILE_MODE, flag: 'wx' });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * Stores one PASS row for the clone of `repoDir`, keeping the newest MAX_ROWS.
 * @param {string} repoDir folder inside the working tree
 * @param {{ tree: string, sha: string, cmd: string, suite: boolean, at: string, ms: number }} row
 * @param {{ HOME?: string, USERPROFILE?: string }} env decides the state folder (default: the real home)
 * @returns {boolean} true when stored; false when the clone, the folder or the file is not usable
 */
export function recordPass(repoDir, row, env = process.env) {
  try {
    const file = recordFile(repoDir, env);
    if (file === null || privateFolder(file.dir) === undefined) return false;
    const rows = readRows(file.path);
    if (rows.length < MAX_ROWS) appendLine(file.path, `${JSON.stringify(row)}\n`);
    else rewrite(file.path, [...rows.slice(-(MAX_ROWS - 1)), row]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a PASS is recorded for the tree of `rev`.
 * @param {string} repoDir folder inside the working tree
 * @param {string} rev commit-ish; only its tree counts, so a rebased copy of a passed commit passes too
 * @param {{ suite?: boolean, cmd?: string, env?: object }} [options] suite: only a record of the full-suite command counts
 *   (a record of related tests never does); that command is `cmd` when given, else the repo's declaredSuite; none declared: false
 * @returns {boolean}
 */
export function hasPass(repoDir, rev, { suite = false, cmd, env = process.env } = {}) {
  const tree = treeOf(repoDir, rev);
  const file = recordFile(repoDir, env);
  if (tree === null || file === null) return false;
  const wanted = suite ? (cmd ?? declaredSuite(repoDir)) : null;
  if (suite && wanted === null) return false;
  return readRows(file.path).some((row) => row.tree === tree && (!suite || (row.suite === true && row.cmd === wanted)));
}
