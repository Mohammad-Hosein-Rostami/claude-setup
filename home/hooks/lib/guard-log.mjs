// Decision log for the guard hooks. Exports: GUARD_LOG_FILE, GUARD_LOG_MAX_BYTES, GUARD_ROTATE_LOCK_FILE, guardLogPath(env), rotatedLogPath(path),
// logDecision(record, env).
// One JSON line per guarded decision (every ask and its outcome allow / deny / timeout / no-gui / dialog-failed; guard-error when the Bash guard itself failed and fell back to the ask), appended to
// ~/.claude/logs/guard.jsonl (override: CLAUDE_GUARD_LOG) so a monitor can report them. Fields: ts, hook, tool, decision,
// outcome, reason, command, cwd, session (a bounce line also has `class`; a secret line, outcome "secret", has the kind as reason and no command). Invariants: command and reason are masked with maskSecrets and the command is cut
// to 200 characters, so the log never holds a secret; on every write the directory is made 0700 and the file 0600 (also when they
// already existed with looser modes), except a shared directory (/, $HOME, the temp dir) or one the user does not own, which is left
// alone; best effort, a write failure never affects the hook. The file is opened without following a link and without blocking, and only
// a regular file is written (lib/plain-file.mjs): a link, FIFO or device planted at the log path is never followed, written or waited on.
// Rotation: once the log reaches GUARD_LOG_MAX_BYTES it becomes guard.1.jsonl (replacing the one before: one old file is kept) and a new empty
// guard.jsonl takes its place in one rename, so the path never goes missing. It runs under withSessionLock (lib/session-lock.mjs) in the log's
// folder, and the size is checked again under the lock, so two writers that both see a full log rotate it once. Lost-line case: a writer
// that opened the old file before the swap appends to it, which is then guard.1.jsonl; one that opens it between the link and the
// last rename finds two names on one file and writes nothing (lib/plain-file.mjs refuses a hard-linked file). Old-reader case: a
// reader that follows guard.jsonl (`tail -F`) sees a new file and reads it from its start; the lines written after its last read and before the swap are in guard.1.jsonl.
// Crash case: the two temp names (`guard.1.jsonl.part`, `guard.jsonl.new`) a rotation killed half-way leaves are removed by the next one,
// and a log left full is rotated by the next write.
import { chmodSync, linkSync, lstatSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { appendPlainFile } from './plain-file.mjs';
import { maskSecrets } from './secrets.mjs';
import { withSessionLock } from './session-lock.mjs';

export const GUARD_LOG_FILE = join(homedir(), '.claude', 'logs', 'guard.jsonl');
export const GUARD_LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB (final-round plan G2); the log held 612 KB on 2026-11-22
export const GUARD_ROTATE_LOCK_FILE = '.guard.rotate-lock'; // in the log's folder; guard-state-write.mjs asks before a command writes it
const ROTATE_LOCK = { name: 'guard', file: GUARD_ROTATE_LOCK_FILE };
const LOG_EXTENSION = '.jsonl';
const PART_SUFFIX = '.part';
const NEW_SUFFIX = '.new';
const MAX_LOGGED_CHARS = 200;
const MAX_MASKED_INPUT = 2048; // only this much of a (possibly huge) command is masked: a bound on the regex work
const LOG_DIR_MODE = 0o700; // the log holds commands: only the owner reads it
const LOG_FILE_MODE = 0o600;

/** True for a directory that is only ours by choice of the log path: it holds other things, so its mode is not ours to change. */
function isSharedDir(dir) {
  const path = resolve(dir);
  return [parse(path).root, resolve(homedir()), resolve(tmpdir())].includes(path) || statSync(path).uid !== process.getuid?.();
}

/** @returns {string} where decisions are logged: CLAUDE_GUARD_LOG or ~/.claude/logs/guard.jsonl */
export const guardLogPath = (env = process.env) => env.CLAUDE_GUARD_LOG || GUARD_LOG_FILE;

const safe = (text) => maskSecrets(String(text ?? '').slice(0, MAX_MASKED_INPUT)).slice(0, MAX_LOGGED_CHARS);

/**
 * Where the log moves when it is full.
 * @param {string} path the log
 * @returns {string} guard.jsonl -> guard.1.jsonl; a name without `.jsonl` gets `.1` added
 */
export const rotatedLogPath = (path) => (path.endsWith(LOG_EXTENSION) ? `${path.slice(0, -LOG_EXTENSION.length)}.1${LOG_EXTENSION}` : `${path}.1`);

/** True when the path is a regular file (never a link) of at least GUARD_LOG_MAX_BYTES. */
function isFull(path) {
  const info = lstatSync(path);
  return info.isFile() && info.size >= GUARD_LOG_MAX_BYTES;
}

/** Under the rotation lock: the full log becomes the rotated file and an empty log replaces it, each in one rename (see the header). */
function rotate(path) {
  if (!isFull(path)) return; // another writer rotated it while this one waited for the lock
  const rotated = rotatedLogPath(path);
  const [part, fresh] = [`${rotated}${PART_SUFFIX}`, `${path}${NEW_SUFFIX}`];
  for (const leftover of [part, fresh]) rmSync(leftover, { force: true }); // a killed rotation's: the lock says none runs now
  linkSync(path, part);
  renameSync(part, rotated);
  rmSync(part, { force: true }); // still there only when it already was the rotated file (rename of one file onto itself does nothing)
  writeFileSync(fresh, '', { flag: 'wx', mode: LOG_FILE_MODE }); // wx: O_EXCL, a link planted at the name is never followed
  renameSync(fresh, path);
}

/** Rotates the log when it is full; a log in a folder that is not ours, a busy lock or a failure leaves it as it is (best effort). */
function rotateIfFull(path) {
  if (isFull(path)) withSessionLock(dirname(path), ROTATE_LOCK.name, () => rotate(path), { lockFile: ROTATE_LOCK.file });
}

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
    appendPlainFile(path, `${JSON.stringify(line)}\n`, { mode: LOG_FILE_MODE });
    if (!isSharedDir(dirname(path))) chmodSync(dirname(path), LOG_DIR_MODE);
    rotateIfFull(path);
  } catch {
    // logging is best effort: a failure here must never change a decision
  }
}
