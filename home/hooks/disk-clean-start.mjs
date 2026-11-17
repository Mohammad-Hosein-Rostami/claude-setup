// SessionStart(startup): starts `disk-clean --apply` in the background at most once every 24 hours, so old scratchpads, test leftovers
// and hook counters never pile up. The stamp file `~/.claude/state/disk-clean.stamp` records the last start (its mtime).
// Exports: startIfDue(input, deps) -> 'started' | 'not-due' | 'skipped'.
// Invariants: never waits for the clean-up (detached child, stdio to a log file, unref); never fails the session start (an error goes to stderr,
//   the exit code stays 0); skips subagents and any source other than startup; the stamp is written BEFORE the child starts, so two sessions
//   that start together run one clean-up. Test hooks: DISK_CLEAN_TOOL replaces the tool path, HOME the state and log folders.
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_INPUT_BYTES = 1 << 20;
const SESSION_ID = /^[\w-]{1,128}$/;
const TOOL = fileURLToPath(new URL('../tools/disk-free/disk-clean.mjs', import.meta.url));

/** Starts the detached clean-up. The log keeps only the last run's output. */
function spawnClean(args, logPath) {
  mkdirSync(dirname(logPath), { recursive: true });
  const log = openSync(logPath, 'w');
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log] });
  child.unref();
  closeSync(log);
}

const stampAgeMs = (stampPath, nowMs) => {
  try {
    return nowMs - statSync(stampPath).mtimeMs;
  } catch (error) {
    if (error.code === 'ENOENT') return Infinity;
    throw error;
  }
};

/**
 * @param {object | null} input the SessionStart hook JSON (session_id, source, agent_id)
 * @param {{ stampPath: string, logPath: string, tool: string, nowMs: number, start?: (args: string[], logPath: string) => void }} deps
 * @returns {'started' | 'not-due' | 'skipped'}
 */
export function startIfDue(input, { stampPath, logPath, tool, nowMs, start = spawnClean }) {
  if (input === null || typeof input !== 'object' || input.agent_id || input.source !== 'startup') return 'skipped';
  if (stampAgeMs(stampPath, nowMs) < MIN_INTERVAL_MS) return 'not-due';
  mkdirSync(dirname(stampPath), { recursive: true });
  writeFileSync(stampPath, new Date(nowMs).toISOString());
  const session = SESSION_ID.test(String(input.session_id ?? '')) ? ['--session', input.session_id] : [];
  start([tool, '--apply', ...session], logPath);
  return 'started';
}

async function main() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) return;
    chunks.push(chunk);
  }
  const claudeDir = join(homedir(), '.claude');
  startIfDue(JSON.parse(Buffer.concat(chunks).toString('utf8')), {
    stampPath: join(claudeDir, 'state', 'disk-clean.stamp'), logPath: join(claudeDir, 'logs', 'disk-clean.log'), tool: process.env.DISK_CLEAN_TOOL ?? TOOL, nowMs: Date.now(),
  });
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(`disk-clean-start: ${error.message}`);
  }
  process.exitCode = 0;
}
