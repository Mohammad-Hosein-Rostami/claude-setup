// Purpose: the land ledger: one JSON line per landing, so a reader (board's `tick`) knows what landed and when without asking an
//   agent. land.mjs appends a line right after its fast-forward; land itself never reads it.
// Exports: landLedgerPath, appendLandEntry, readLandEntries.
// File: <HOME>/.claude/state/land/<repo-key>.jsonl. <repo-key> is the first 16 hex of the sha256 of the real path of the
//   repository's git common dir (`git rev-parse --path-format=absolute --git-common-dir`), so every worktree of one repository and
//   every path to it through a link (`~/.claude` is one) or in another letter case give the same file.
// Line: {"at": "<ISO time>", "repo": "<base checkout>", "branch": "<lane>", "from": "<base sha before>", "to": "<landed sha>",
//   "commits": <n>}.
// Invariants:
// - This file is the one place for the format: the writer and the reader both take the fields from ENTRY_FIELDS, in its order.
// - An append never throws: a line that cannot be written is one warning line for stderr and the landing stands (`git-tidy range`
//   finds its range again from the base's reflog). The file is opened without following a link or waiting on a FIFO, never
//   through a second hard link, and never grows past MAX_LEDGER_BYTES, the most a read takes (hooks/lib/plain-file.mjs).
// - A read skips, and counts, every line that does not parse or lacks a field; a missing file has no entries. Any other failure
//   (git, a link, FIFO or folder at the path, a file past the cap) throws.
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { appendPlainFile, readPlainFile } from '../../hooks/lib/plain-file.mjs';
import { gitText } from '../git-tidy/lib/git.mjs';
import { firstLine } from './refusal.mjs';

const REPO_KEY_HEX = 16;
// A line is about 300 bytes, so this holds some 100,000 landings; the writer stops there with a warning, so a read never fails on size.
const MAX_LEDGER_BYTES = 32 * 1024 * 1024;
const FOLDER_MODE = 0o700;
const COMMIT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/; // a full SHA-1 or SHA-256 object name

const isText = (value) => typeof value === 'string' && value !== '';
const isCommitName = (value) => typeof value === 'string' && COMMIT_NAME.test(value);

/** Each field of a ledger line, in the order it is written, with the check a line read back must pass. */
const ENTRY_FIELDS = Object.freeze({
  at: (value) => isText(value) && !Number.isNaN(Date.parse(value)),
  repo: isText,
  branch: isText,
  from: isCommitName,
  to: isCommitName,
  commits: (value) => Number.isSafeInteger(value) && value >= 0,
});

/** The ledger fields of `source`, in the ledger's order, and nothing else. */
const ledgerFields = (source) => Object.fromEntries(Object.keys(ENTRY_FIELDS).map((name) => [name, source[name]]));

/**
 * The ledger file of the repository that holds `repoDir`.
 * @param {string} repoDir any folder of the repository (the base checkout, a lane's worktree)
 * @param {Record<string, string | undefined>} [env] HOME (a test or a smoke run passes a scratch home)
 * @returns {string} the absolute path `<HOME>/.claude/state/land/<repo-key>.jsonl`
 * @throws {Error} when git cannot name the repository's common dir
 */
export function landLedgerPath(repoDir, env = process.env) {
  // realpath(3), not the JS one: it also gives the disk's own letter case, so `~/desktop/app` and `~/Desktop/app` share one key.
  const commonDir = realpathSync.native(gitText(repoDir, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const repoKey = createHash('sha256').update(commonDir).digest('hex').slice(0, REPO_KEY_HEX);
  return join(env.HOME || homedir(), '.claude', 'state', 'land', `${repoKey}.jsonl`);
}

const notWritten = ({ branch, to }, why) => `land: the ledger line of ${branch} was not written (${why}); the landing stands, and git-tidy range ${to} finds its range again`;

/**
 * Appends one landing to the ledger of the repository that holds `repoDir`, creating the ledger's folder when missing.
 * @param {string} repoDir any folder of the repository
 * @param {{ at: string, repo: string, branch: string, from: string, to: string, commits: number }} entry `at` an ISO time, `repo`
 *   the base checkout, `from` the base's sha before the fast-forward, `to` the landed sha, `commits` how many commits landed
 * @param {Record<string, string | undefined>} [env] HOME
 * @returns {string|null} null when the line is written, else a one-line warning for stderr; never throws (the landing stands)
 */
export function appendLandEntry(repoDir, entry, env = process.env) {
  try {
    const path = landLedgerPath(repoDir, env);
    mkdirSync(dirname(path), { recursive: true, mode: FOLDER_MODE });
    if (appendPlainFile(path, `${JSON.stringify(ledgerFields(entry))}\n`, { maxBytes: MAX_LEDGER_BYTES })) return null;
    return notWritten(entry, `${path} is not a plain file with one link, or would pass ${MAX_LEDGER_BYTES} bytes: move it away`);
  } catch (error) {
    return notWritten(entry, firstLine(error.message));
  }
}

/** The ledger's text; '' when the file does not exist yet. */
function ledgerText(path) {
  try {
    return readPlainFile(path, MAX_LEDGER_BYTES);
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

/** One ledger line as an entry with exactly the ledger fields, or null when it does not parse or a field is missing or malformed. */
function parseEntry(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null; // a torn or hand-edited line: the caller skips and counts it
  }
  const isEntry = value !== null && typeof value === 'object' && Object.entries(ENTRY_FIELDS).every(([name, isValid]) => isValid(value[name]));
  return isEntry ? ledgerFields(value) : null;
}

/**
 * The landings in the ledger of the repository that holds `repoDir`, oldest first.
 * @param {string} repoDir any folder of the repository
 * @param {Record<string, string | undefined>} [env] HOME
 * @returns {{ entries: Array<{ at: string, repo: string, branch: string, from: string, to: string, commits: number }>, skipped: number }}
 *   no entries for a missing file; `skipped` counts the lines that do not parse or lack a field (blank lines are not counted)
 * @throws {Error} when git cannot name the repository, or the file cannot be read (a link, FIFO or folder, past MAX_LEDGER_BYTES)
 */
export function readLandEntries(repoDir, env = process.env) {
  const entries = [];
  let skipped = 0;
  for (const line of ledgerText(landLedgerPath(repoDir, env)).split('\n').filter((text) => text.trim() !== '')) {
    const entry = parseEntry(line);
    if (entry === null) skipped += 1;
    else entries.push(entry);
  }
  return { entries, skipped };
}
