// Per-session memory of literal secrets the owner already allowed. Exports: isRemembered(session, values, env) -> boolean,
// remember(session, values, env) -> void, allowedLiteralsDir(env) -> string.
// Why: the guard asks (dialog) about a literal secret in a command; the same value typed again in the same session (a Figma
// file key, a test password) must not re-open the dialog every time. Store: ~/.claude/state/guard-allowed/<session>.json
// (HOME from env, like guard-log), {"digests": [sha256 hex, ...]}; directory 0700, file 0600. Invariants: only sha256 digests
// are stored, never a raw value; a session id that is not [A-Za-z0-9_-]{1,100} has no store (always ask, no file is made);
// nothing throws (any I/O error means "not remembered" / "not stored"); files untouched for 7 days are pruned on write.
// A value shorter than MIN_VALUE_LENGTH is never stored, and a command holding one is never remembered (too easy to collide with).
// Not a defence against a hostile model: Bash can write this file (the guard protects against mistakes, not malice).
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
export const MIN_VALUE_LENGTH = 8;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * @param {Record<string, string | undefined>} env process environment (HOME or USERPROFILE)
 * @returns {string} the directory holding one file per session (HOME or USERPROFILE from env, else the OS home)
 */
export const allowedLiteralsDir = (env = process.env) => join(env.HOME || env.USERPROFILE || homedir(), '.claude', 'state', 'guard-allowed');

const tooShort = (value) => typeof value !== 'string' || value.length < MIN_VALUE_LENGTH;
const digestOf = (value) => createHash('sha256').update(value).digest('hex');
const storePath = (session, env) => (typeof session === 'string' && SESSION_ID.test(session) ? join(allowedLiteralsDir(env), `${session}.json`) : undefined);

/** @returns {Set<string>} the stored digests; empty when the file is missing or unreadable */
function readDigests(path) {
  try {
    const { digests } = JSON.parse(readFileSync(path, 'utf8'));
    return new Set(Array.isArray(digests) ? digests.filter((digest) => typeof digest === 'string') : []);
  } catch {
    return new Set(); // no file, or a damaged one: nothing is remembered
  }
}

/**
 * Removes session files older than 7 days; best effort, each entry on its own.
 * @param {string} dir the guard-allowed directory
 * @param {number} now current time in milliseconds
 * @returns {void}
 */
function pruneOld(dir, now) {
  for (const name of readdirSync(dir)) {
    try {
      const path = join(dir, name);
      if (now - statSync(path).mtimeMs > MAX_AGE_MS) unlinkSync(path);
    } catch {
      // one entry that vanished or cannot be removed must not stop the others
    }
  }
}

/**
 * @param {string | undefined} session the hook's session id
 * @param {string[]} values raw literal values found in the command (hashed here)
 * @param {Record<string, string | undefined>} env process environment (HOME)
 * @returns {boolean} true only when values is non-empty, none is shorter than MIN_VALUE_LENGTH and every digest is stored for this session
 */
export function isRemembered(session, values, env = process.env) {
  const path = storePath(session, env);
  if (path === undefined || !Array.isArray(values) || values.length === 0 || values.some(tooShort)) return false;
  const stored = readDigests(path);
  return values.every((value) => stored.has(digestOf(value)));
}

/**
 * Stores the digests of values the owner allowed (values shorter than MIN_VALUE_LENGTH are skipped). Never throws.
 * @param {string | undefined} session the hook's session id
 * @param {string[]} values raw literal values (hashed here, never written)
 * @param {Record<string, string | undefined>} env process environment (HOME)
 * @returns {void}
 */
export function remember(session, values, env = process.env) {
  const path = storePath(session, env);
  const kept = Array.isArray(values) ? values.filter((value) => !tooShort(value)) : [];
  if (path === undefined || kept.length === 0) return;
  try {
    const dir = allowedLiteralsDir(env);
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    chmodSync(dir, DIR_MODE);
    try {
      pruneOld(dir, Date.now());
    } catch {
      // pruning is housekeeping: it must not stop the write
    }
    const digests = [...new Set([...readDigests(path), ...kept.map(digestOf)])];
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ digests }), { mode: FILE_MODE });
    chmodSync(temp, FILE_MODE);
    renameSync(temp, path);
  } catch {
    // not stored: the next identical command simply asks again
  }
}
