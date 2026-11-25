// Starts the disk clean-up in the background at most once every 24 hours, without delaying the session start.
// SessionStart(startup): starts `disk-clean --apply --all-lines` in the background at most once every 24 hours, so old scratchpads, test leftovers
// and hook counters never pile up. --all-lines: the log is the one place that keeps every NOT removed and SKIPPED line of the run. The stamp file `~/.claude/state/disk-clean.stamp` records the last start (its mtime).
// Exports: startIfDue(input, deps) -> 'started' | 'not-due' | 'skipped'; openLogFile, cleanEnv (tests).
// Invariants: never waits for the clean-up (detached child, stdio to a log file, unref); never fails the session start (an error goes to stderr,
//   the exit code stays 0; input that is not JSON, or over 1 MiB, is skipped with no line at all); skips subagents and any source other than startup. Two sessions that start together run one clean-up: the check
//   and the stamp write happen while holding a lock file made with O_EXCL (lib/lock-file.mjs: a lock older than a minute is a crashed hook's
//   and is replaced by one breaker only). An empty or relative HOME skips the run.
//   The stamp is written to a new file and renamed over the old one, the lock and the log are opened with O_NOFOLLOW and O_NONBLOCK, and
//   a stamp or log that is a symlink, a FIFO or any other non-plain file is never read through, written to or waited on.
//   The child gets a minimal environment (no tokens or other secrets). CLAUDE_CONFIG_DIR is part of it: a hook started in a session of another
//   config dir then tells the clean-up so, and the clean-up skips the rules that read ~/.claude (it would see none of that session's files). Test hooks: DISK_CLEAN_TOOL replaces the tool path, HOME the state and log folders.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { releaseLock, takeLock } from '../tools/disk-free/lib/lock-file.mjs';
import { escaped } from './lib/shown-name.mjs';

const MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 60 * 1000; // the check and the stamp write take microseconds; a lock this old was left by a crashed hook
const MAX_INPUT_BYTES = 1 << 20;
const SESSION_ID = /^[\w-]{1,128}$/;
const TOOL = fileURLToPath(new URL('../tools/disk-free/disk-clean.mjs', import.meta.url));
// What the clean-up needs to find the folders it works in, and to know that this session keeps its transcripts and registry in another config
// dir (CLAUDE_CONFIG_DIR); anything else (tokens, API keys, secrets) stays behind.
const CHILD_ENV_NAMES = ['HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'LANG', 'DISK_FREE_CLAUDE_TMP', 'CLAUDE_CONFIG_DIR'];
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0; // not defined on Windows
const NO_BLOCK = constants.O_NONBLOCK ?? 0;
const PRIVATE_FILE = 0o600;

/** @returns {Record<string, string>} the environment variables the clean-up child gets */
export const cleanEnv = (env) => Object.fromEntries(CHILD_ENV_NAMES.filter((name) => env[name] !== undefined).map((name) => [name, env[name]]));

/** Opens the log for writing (cut to empty) without following a symlink or waiting on a FIFO; null when it is not a plain file of ours. */
export function openLogFile(logPath) {
  mkdirSync(dirname(logPath), { recursive: true });
  let fd;
  try {
    fd = openSync(logPath, constants.O_WRONLY | constants.O_CREAT | NO_FOLLOW | NO_BLOCK, PRIVATE_FILE);
  } catch (error) {
    if (['ELOOP', 'ENXIO', 'EACCES', 'EISDIR'].includes(error.code)) return null; // a symlink, a FIFO nobody reads, not ours
    throw error;
  }
  const info = fstatSync(fd);
  if (!info.isFile() || (process.getuid !== undefined && info.uid !== process.getuid())) {
    closeSync(fd);
    return null;
  }
  ftruncateSync(fd, 0);
  return fd;
}

/** Starts the detached clean-up. The log keeps only the last run's output. */
function spawnClean(args, logPath) {
  const log = openLogFile(logPath);
  const child = spawn(process.execPath, args, { detached: true, windowsHide: true, env: cleanEnv(process.env), stdio: ['ignore', log ?? 'ignore', log ?? 'ignore'] });
  child.unref();
  if (log !== null) closeSync(log);
}

/** Age of the stamp; Infinity when there is none or it is not a plain file (such a stamp is replaced, never read through). */
const stampAgeMs = (stampPath, nowMs) => {
  try {
    const info = lstatSync(stampPath);
    return info.isFile() ? nowMs - info.mtimeMs : Infinity;
  } catch (error) {
    if (error.code === 'ENOENT') return Infinity;
    throw error;
  }
};

/** Writes the stamp to a new file and renames it over the old one: atomic, and a link or FIFO at the stamp path is replaced, not followed. */
function writeStamp(stampPath, nowMs) {
  const temp = `${stampPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, PRIVATE_FILE);
  try {
    writeSync(fd, new Date(nowMs).toISOString());
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, stampPath);
  } catch (error) {
    unlinkSync(temp);
    throw error;
  }
}

/** True when this call won the right to start the clean-up and has written the stamp. */
function claimStamp(stampPath, nowMs) {
  mkdirSync(dirname(stampPath), { recursive: true });
  const lockPath = `${stampPath}.lock`;
  if (!takeLock(lockPath, nowMs, LOCK_STALE_MS)) return false;
  try {
    if (stampAgeMs(stampPath, nowMs) < MIN_INTERVAL_MS) return false;
    writeStamp(stampPath, nowMs);
    return true;
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * @param {object | null} input the SessionStart hook JSON (session_id, source, agent_id)
 * @param {{ stampPath: string, logPath: string, tool: string, nowMs: number, start?: (args: string[], logPath: string) => void }} deps
 * @returns {'started' | 'not-due' | 'skipped'}
 */
export function startIfDue(input, { stampPath, logPath, tool, nowMs, start = spawnClean }) {
  if (input === null || typeof input !== 'object' || input.agent_id || input.source !== 'startup') return 'skipped';
  if (stampAgeMs(stampPath, nowMs) < MIN_INTERVAL_MS || !claimStamp(stampPath, nowMs)) return 'not-due';
  const session = SESSION_ID.test(String(input.session_id ?? '')) ? ['--session', input.session_id] : [];
  start([tool, '--apply', '--all-lines', ...session], logPath);
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
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return; // not hook JSON: no session start to act on, and nothing to say
  }
  const home = homedir();
  if (!isAbsolute(home)) throw new Error(`skipped: the home folder ${JSON.stringify(home)} is not an absolute path`); // an empty HOME would put the state folder in the working directory
  const claudeDir = join(home, '.claude');
  startIfDue(input, {
    stampPath: join(claudeDir, 'state', 'disk-clean.stamp'), logPath: join(claudeDir, 'logs', 'disk-clean.log'), tool: process.env.DISK_CLEAN_TOOL ?? TOOL, nowMs: Date.now(),
  });
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(`disk-clean-start: ${escaped(String(error.message))}`);
  }
  process.exitCode = 0;
}
