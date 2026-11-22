// The last done-check verdict of a repository, for the board's git row (`check ok`, `check failed: tests`; spec R18 "Git facts").
// Run only by the detached board refresh.
// Exports: repoIdOfCommon(common, platform) -> string; latestCheck(common, { env, platform }) -> { verdict, atMs, failed } | null.
// The ledger (done-check/lib/ledger.mjs, one JSON row per line, append only) names a repository by the first 16 hex of the sha256 of
// its shared git folder as `git rev-parse --path-format=absolute --git-common-dir` prints it (done-check/lib/check-change.mjs
// repoIdOf). The board has that folder from the file system (trusted-repos.mjs, real path in the disk's case); git prints it with
// forward slashes on Windows, so the board's backslashes are turned first (spec U3: the ids must match, else no check shows).
// Only the last TAIL_BYTES of the ledger are read (it grows to 16 MiB; `lastRun` parses the whole file, too slow for a refresh): a
// repository whose newest run is older than that tail shows no check.
// Invariants: never throws; reads one plain file (never a link or a FIFO: read-part.mjs); only a verdict word and check kind words
// leave here, each matching WORD.
import { createHash } from 'node:crypto';
import { ledgerFile } from '../../done-check/lib/ledger.mjs';
import { readPart } from './read-part.mjs';

const TAIL_BYTES = 64 * 1024;
const REPO_ID_CHARS = 16; // done-check/lib/check-change.mjs REPO_ID_CHARS
const ROW_VERSION = 1;
const WORD = /^[a-z][a-z-]{0,23}$/;

/**
 * The done-check ledger's id of a repository.
 * @param {string} common the repository's shared git folder (absolute)
 * @param {string} [platform] process.platform; on win32 backslashes become `/`, as git prints the folder
 * @returns {string} 16 hex characters
 */
export function repoIdOfCommon(common, platform = process.platform) {
  const asGitPrintsIt = platform === 'win32' ? common.replaceAll('\\', '/') : common;
  return createHash('sha256').update(asGitPrintsIt).digest('hex').slice(0, REPO_ID_CHARS);
}

/** The board's form of one ledger run row: its verdict, when, and the check kinds that failed. */
function checkOfRow(row) {
  const atMs = Date.parse(row.at);
  const failed = Object.entries(row.checks).filter(([kind, check]) => WORD.test(kind) && check?.result === 'fail').map(([kind]) => kind);
  return { verdict: row.verdict, atMs: Number.isFinite(atMs) ? atMs : null, failed };
}

const isRunRowOf = (row, repoId) => row !== null && typeof row === 'object' && row.v === ROW_VERSION && row.repo === repoId
  && typeof row.verdict === 'string' && WORD.test(row.verdict) && row.checks !== null && typeof row.checks === 'object' && !Array.isArray(row.checks);

/**
 * The newest done-check run of a repository in the ledger's tail.
 * @param {string | null} common the repository's shared git folder
 * @param {{ env?: object, platform?: string }} [options] env: HOME of the ledger (tests pass a temp one)
 * @returns {{ verdict: string, atMs: number | null, failed: string[] } | null} null with no run in the tail or no readable ledger
 */
export function latestCheck(common, { env = process.env, platform = process.platform } = {}) {
  try {
    if (typeof common !== 'string' || common === '') return null;
    const part = readPart(ledgerFile(env), TAIL_BYTES, true);
    if (part === null) return null;
    const lines = part.text.split('\n');
    if (part.truncated) lines.shift(); // the tail starts inside a row
    const repoId = repoIdOfCommon(common, platform);
    for (let at = lines.length - 1; at >= 0; at -= 1) {
      let row;
      try {
        row = JSON.parse(lines[at]);
      } catch {
        continue; // a blank line or a half line left by a crash
      }
      if (isRunRowOf(row, repoId)) return checkOfRow(row);
    }
    return null;
  } catch {
    return null; // an unreadable ledger: no check shown
  }
}
