// Purpose: read the review report of the round before a fix round (`--prior`): its sha256 and how many blocking and should-fix
//   findings it holds, so a reviewer can tell the file was not changed and a lead can tell no finding was taken out.
// Exports: MAX_PRIOR_BYTES, countFindings(text), readPrior(path).
// Invariants: the file's text never leaves this module: only its path, hash and counts do. Only a regular file is opened (a FIFO,
//   a device or a folder is refused before any read), and none over MAX_PRIOR_BYTES.
//   A finding is a line that carries its severity as a table cell (`| blocking |`) or as a tag (`[should-fix]`): the two forms the
//   setup's reports use (review reports are tables, the review workflow lists `- [severity] id file:line`). A line counts once, by
//   its first mark; a sentence that only uses the words is no finding.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { UsageError } from '../../git-tidy/lib/git.mjs';

export const MAX_PRIOR_BYTES = 4 << 20;
const SEVERITY_MARK = /\|\s*(blocking|should-fix)\s*\||\[(blocking|should-fix)\]/i;

/**
 * Counts the findings of a review report by severity.
 * @param {string} text the report
 * @returns {{blocking: number, shouldFix: number, findings: number}} `findings` is their sum
 */
export function countFindings(text) {
  let blocking = 0;
  let shouldFix = 0;
  for (const line of text.split('\n')) {
    const mark = SEVERITY_MARK.exec(line);
    if (mark === null) continue;
    if ((mark[1] ?? mark[2]).toLowerCase() === 'blocking') blocking += 1;
    else shouldFix += 1;
  }
  return { blocking, shouldFix, findings: blocking + shouldFix };
}

/**
 * Reads the prior findings file of a delta round.
 * @param {string} path a plain absolute path (the CLI checks that before it calls)
 * @returns {{file: string, sha256: string, blocking: number, shouldFix: number, findings: number}}
 * @throws {UsageError} when the path is no regular file, is over MAX_PRIOR_BYTES or cannot be read (the cause is in the message)
 */
export function readPrior(path) {
  let bytes;
  try {
    const stats = statSync(path);
    if (!stats.isFile()) throw new Error('not a regular file');
    if (stats.size > MAX_PRIOR_BYTES) throw new Error(`over ${MAX_PRIOR_BYTES} bytes`);
    bytes = readFileSync(path);
  } catch (error) {
    throw new UsageError(`cannot read --prior ${path}: ${error.message}`);
  }
  return { file: path, sha256: createHash('sha256').update(bytes).digest('hex'), ...countFindings(bytes.toString('utf8')) };
}
