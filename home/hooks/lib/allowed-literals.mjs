// Per-session memory of literal secrets the owner already allowed. Exports: isRemembered(session, values, env) -> boolean,
// remember(session, values, env) -> void, allowedLiteralsDir(env) -> string.
// Why: the guard asks (dialog) about a literal secret in a command; the same value typed again in the same session (a Figma
// file key, a test password) must not re-open the dialog every time. Store: ~/.claude/state/guard-allowed/<session>.json
// (HOME from env, like guard-log), {"digests": [sha256 hex, ...]}, kept by lib/session-store.mjs: directory 0700, file 0600, and a link,
// FIFO, folder or another owner's file where the store should be makes it unusable (nothing remembered, nothing written or pruned).
// Invariants: only sha256 digests are stored, never a raw value; a session id that is not [A-Za-z0-9_-]{1,100} has no store (always ask,
// no file is made); nothing throws (any I/O error means "not remembered" / "not stored"); files untouched for 7 days are pruned on write.
// A value shorter than MIN_VALUE_LENGTH is never stored, and a command holding one is never remembered (too easy to collide with).
// Not a defence against a hostile model: Bash can write this file (the guard protects against mistakes, not malice).
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isSessionId, readSessionFile, writeSessionFile } from './session-store.mjs';

export const MIN_VALUE_LENGTH = 8;
const MAX_STORE_BYTES = 1024 * 1024; // about 15,000 digests, far more than one session allows; a bigger file was not written here

/**
 * @param {Record<string, string | undefined>} env process environment (HOME or USERPROFILE)
 * @returns {string} the directory holding one file per session (HOME or USERPROFILE from env, else the OS home)
 */
export const allowedLiteralsDir = (env = process.env) => join(env.HOME || env.USERPROFILE || homedir(), '.claude', 'state', 'guard-allowed');

const tooShort = (value) => typeof value !== 'string' || value.length < MIN_VALUE_LENGTH;
const digestOf = (value) => createHash('sha256').update(value).digest('hex');

/** @returns {Set<string> | undefined} the stored digests (empty when there is no file yet or it is damaged); undefined when the store is unusable */
function readDigests(session, env) {
  const text = readSessionFile(allowedLiteralsDir(env), session, MAX_STORE_BYTES);
  if (text === undefined) return undefined;
  try {
    const { digests } = JSON.parse(text ?? '{}');
    return new Set(Array.isArray(digests) ? digests.filter((digest) => typeof digest === 'string') : []);
  } catch {
    return new Set(); // a damaged file: nothing is remembered, and the next write replaces it
  }
}

/**
 * @param {string | undefined} session the hook's session id
 * @param {string[]} values raw literal values found in the command (hashed here)
 * @param {Record<string, string | undefined>} env process environment (HOME)
 * @returns {boolean} true only when values is non-empty, none is shorter than MIN_VALUE_LENGTH and every digest is stored for this session
 */
export function isRemembered(session, values, env = process.env) {
  if (!isSessionId(session) || !Array.isArray(values) || values.length === 0 || values.some(tooShort)) return false;
  const stored = readDigests(session, env);
  return stored !== undefined && values.every((value) => stored.has(digestOf(value)));
}

/**
 * Stores the digests of values the owner allowed (values shorter than MIN_VALUE_LENGTH are skipped). Never throws.
 * @param {string | undefined} session the hook's session id
 * @param {string[]} values raw literal values (hashed here, never written)
 * @param {Record<string, string | undefined>} env process environment (HOME)
 * @returns {void}
 */
export function remember(session, values, env = process.env) {
  const kept = Array.isArray(values) ? values.filter((value) => !tooShort(value)) : [];
  if (!isSessionId(session) || kept.length === 0) return;
  const stored = readDigests(session, env);
  if (stored === undefined) return; // an unusable store is never written; the next identical command simply asks again
  const digests = [...new Set([...stored, ...kept.map(digestOf)])];
  writeSessionFile(allowedLiteralsDir(env), session, JSON.stringify({ digests }));
}
