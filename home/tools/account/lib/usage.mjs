// Purpose: where the account tool keeps its runtime state, and one usage row per headless Haiku call (claude-call.mjs).
// Exports: accountStateDir, usageLogPath, logUsage.
// Invariants: one JSON row per call (ts, session, label, attempt, account, model, input, cache_creation, cache_read, output,
// cost_usd_list, ms, is_error); `account` is the name of the account the call ran on (null when the terminal's token has
// no name), never a token; a call that was not made for want of a login is one row with `account: null, error: "auth",
// is_error: true` and no token fields (claude-call.mjs). ACCOUNT_STATE_DIR overrides the folder (tests).
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { PRIVATE_FILE_MODE, ensurePrivateDir } from './private-fs.mjs';

/** ACCOUNT_STATE_DIR, else ~/.claude/state/account: the Haiku call's empty working folder and the usage log live here. */
export const accountStateDir = (env = process.env) => env.ACCOUNT_STATE_DIR || join(homedir(), '.claude', 'state', 'account');

/** The JSONL file that gets one row per Haiku call. */
export const usageLogPath = (env = process.env) => join(accountStateDir(env), 'usage.jsonl');

/** Append one usage row ({ts} is added). */
export function logUsage(row, env = process.env) {
  const path = usageLogPath(env);
  ensurePrivateDir(dirname(path));
  appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...row })}\n`, { mode: PRIVATE_FILE_MODE });
}
