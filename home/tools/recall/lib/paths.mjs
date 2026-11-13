// Purpose: where recall keeps its non-index state (reranker pid file, checkpoint state and locks, usage log).
// Exports: defaultDbPath, stateDir, usageLogPath.
// Invariants: dependency-free on purpose (the checkpoint hook imports this and must start fast); pure path computation, nothing is created here; RECALL_STATE_DIR overrides, else the directory of the
// index DB (RECALL_DB or ~/.claude/recall), so a test that points RECALL_DB into a temp dir is isolated automatically.
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** RECALL_DB, else ~/.claude/recall/index.db. */
export function defaultDbPath(env = process.env) {
  return env.RECALL_DB || join(homedir(), '.claude', 'recall', 'index.db');
}

/** Directory for recall's runtime state files. */
export const stateDir = (env = process.env) => env.RECALL_STATE_DIR || dirname(defaultDbPath(env));

/** The JSONL file that gets one row per Haiku call (RECALL_USAGE_LOG, else <state>/usage.jsonl). */
export const usageLogPath = (env = process.env) => env.RECALL_USAGE_LOG || join(stateDir(env), 'usage.jsonl');
