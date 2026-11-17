// Purpose: append one JSON line per review-tier run to ~/.claude/logs/review-tier.jsonl (REVIEW_TIER_LOG overrides).
// Exports: appendLog(record, env).
// Invariants: the folder is made 0700 and the file 0600 (the record holds no paths or line text, but is still private);
//   a write failure is returned as a message for the caller to print, never thrown, so a full disk cannot fail a review.
import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** @returns {string | null} null on success, else why the line was not written */
export function appendLog(record, env = process.env) {
  const file = env.REVIEW_TIER_LOG || join(homedir(), '.claude', 'logs', 'review-tier.jsonl');
  try {
    mkdirSync(dirname(file), { recursive: true, mode: DIR_MODE });
    appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: FILE_MODE });
    chmodSync(file, FILE_MODE);
    return null;
  } catch (error) {
    return `log not written (${file}): ${error.message}`;
  }
}
