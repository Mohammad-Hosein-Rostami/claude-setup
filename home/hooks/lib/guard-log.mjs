// Decision log for the guard hooks. Exports: GUARD_LOG_FILE, guardLogPath(env), logDecision(record, env).
// One JSON line per guarded decision (every ask and its outcome allow / deny / timeout / no-gui / dialog-failed), appended to
// ~/.claude/logs/guard.jsonl (override: CLAUDE_GUARD_LOG) so a monitor can report them. Fields: ts, hook, tool, decision,
// outcome, reason, command, cwd, session. Invariants: command and reason are masked with maskSecrets and the command is cut
// to 200 characters, so the log never holds a secret; the directory is created 0700 and the file 0600; best effort, a write failure never affects the hook.
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { maskSecrets } from './secrets.mjs';

export const GUARD_LOG_FILE = join(homedir(), '.claude', 'logs', 'guard.jsonl');
const MAX_LOGGED_CHARS = 200;
const LOG_DIR_MODE = 0o700; // the log holds commands: only the owner reads it
const LOG_FILE_MODE = 0o600;

/** @returns {string} where decisions are logged: CLAUDE_GUARD_LOG or ~/.claude/logs/guard.jsonl */
export const guardLogPath = (env = process.env) => env.CLAUDE_GUARD_LOG || GUARD_LOG_FILE;

const safe = (text) => maskSecrets(String(text ?? '')).slice(0, MAX_LOGGED_CHARS);

/**
 * @param {{hook: string, tool: string, decision: string, outcome: string, reason: string, command?: string, cwd?: string, session?: string}} record what was decided
 * @param {Record<string, string | undefined>} env process environment
 * @returns {void}
 */
export function logDecision(record, env = process.env) {
  try {
    const path = guardLogPath(env);
    mkdirSync(dirname(path), { recursive: true, mode: LOG_DIR_MODE });
    const line = { ts: new Date().toISOString(), ...record, reason: safe(record.reason), command: safe(record.command) };
    appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: LOG_FILE_MODE });
  } catch {
    // logging is best effort: a failure here must never change a decision
  }
}
