// Hand-over from the Bash guard's dialog to the PermissionRequest hook, so one command never gets two dialogs.
// Exports: answeredCommandsDir(env), rememberAnswered(session, command, env, now), takeAnswered(session, command, env, now) -> boolean.
// Why: a guard "allow" (click or timeout) prints no decision, and Claude Code may then show its own permission prompt for the same
// command (a "Dangerous rm operation not ruled out" check in bypassPermissions mode). The owner already answered that command, so
// permission-timed-allow.mjs allows it without a second dialog when the guard recorded the answer moments before.
// Store: ~/.claude/state/guard-answered/<session>.json (HOME from env), {"answers": {"<sha256 of the command>": <ms timestamp>}}, kept by
// lib/session-store.mjs (0700 folder, 0600 file, no links, a lock while reading and writing).
// Invariants: only digests are stored, never command text; an answer is taken at most once and only within ANSWER_TTL_MS of the guard's
// answer (the prompt follows the guard at once); a bad session id or an unusable store means "not answered"; nothing throws.
// Not a defence against a hostile model: Bash can write this file (the guard protects against mistakes, not malice).
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isSessionId, readSessionFile, withSessionLock, writeSessionFile } from './session-store.mjs';

const ANSWER_TTL_MS = 60 * 1000; // the prompt comes right after the guard; an older answer belongs to an earlier call
const MAX_STORE_BYTES = 64 * 1024; // a few hundred live answers at most; a bigger file was not written here

/**
 * @param {Record<string, string | undefined>} env process environment (HOME or USERPROFILE)
 * @returns {string} the directory holding one file per session
 */
export const answeredCommandsDir = (env = process.env) => join(env.HOME || env.USERPROFILE || homedir(), '.claude', 'state', 'guard-answered');

const digestOf = (command) => createHash('sha256').update(command).digest('hex');

/** @returns {Record<string, number> | undefined} the fresh answers (stale ones dropped); undefined when the store is unusable */
function readFresh(dir, session, nowMs) {
  const text = readSessionFile(dir, session, MAX_STORE_BYTES);
  if (text === undefined) return undefined;
  let answers = {};
  try {
    answers = JSON.parse(text ?? '{}').answers ?? {};
  } catch {
    answers = {}; // a damaged file: nothing is answered, and the write below replaces it
  }
  const fresh = Object.entries(answers).filter(([, at]) => typeof at === 'number' && nowMs - at >= 0 && nowMs - at <= ANSWER_TTL_MS);
  return Object.fromEntries(fresh);
}

/**
 * Records that the owner allowed `command` in the guard's dialog (Allow click or timeout). Never throws.
 * @param {string | undefined} session the hook's session id
 * @param {string} command the raw command text (hashed here, never written)
 * @param {Record<string, string | undefined>} env process environment (HOME)
 * @param {() => number} now clock in milliseconds
 * @returns {void}
 */
export function rememberAnswered(session, command, env = process.env, now = Date.now) {
  if (!isSessionId(session) || typeof command !== 'string') return;
  const dir = answeredCommandsDir(env);
  withSessionLock(dir, session, () => {
    const answers = readFresh(dir, session, now());
    if (answers) writeSessionFile(dir, session, JSON.stringify({ answers: { ...answers, [digestOf(command)]: now() } }));
  });
}

/**
 * @param {string | undefined} session the hook's session id
 * @param {string} command the raw command text of the permission prompt
 * @param {Record<string, string | undefined>} env process environment (HOME)
 * @param {() => number} now clock in milliseconds
 * @returns {boolean} true when the guard recorded an answer for this command within ANSWER_TTL_MS; the record is removed (used once)
 */
export function takeAnswered(session, command, env = process.env, now = Date.now) {
  if (!isSessionId(session) || typeof command !== 'string') return false;
  const dir = answeredCommandsDir(env);
  const taken = withSessionLock(dir, session, () => {
    const answers = readFresh(dir, session, now());
    const digest = digestOf(command);
    if (!answers || !(digest in answers)) return false;
    const { [digest]: _used, ...rest } = answers;
    writeSessionFile(dir, session, JSON.stringify({ answers: rest }));
    return true;
  });
  return taken === true;
}
