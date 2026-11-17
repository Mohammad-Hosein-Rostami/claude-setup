// Hand-over from the Bash guard's dialog to the PermissionRequest hook, so one command never gets two dialogs.
// Exports: answeredCommandsDir(env), rememberAnswered(call, env, now), takeAnswered(call, env, now) -> boolean, where call is
// {session, agentId, cwd, command} from the hook input.
// Why: a guard "allow" (click or timeout) prints no decision, and Claude Code may then show its own permission prompt for the same
// command. The owner already answered that command, so permission-timed-allow.mjs allows it without a second dialog when the guard
// recorded the answer moments before.
// Store: ~/.claude/state/guard-answered/<session>.json (HOME from env), {"answers": {"<sha256 of agent, cwd and command>": <ms>}}, kept
// by lib/session-store.mjs (a per-user 0700 folder, 0600 files, links, FIFOs and other owners refused, a lock while reading and writing).
// Invariants: only digests are stored, never command text; a record matches only the same session, agent, directory and exact
// command; it is taken at most once and only within ANSWER_TTL_MS (10 s) of the guard's answer (the prompt follows the guard at once);
// a record dated in the future, a bad session id, an unusable store or a used record that cannot be removed mean "not answered";
// nothing throws.
// Limit: this narrows forgery and replay but cannot stop it: the model's Bash runs as the same user and can write this file within the
// window (the PermissionRequest input has no tool_use_id to bind to). A forged record skips one dialog for one exact command.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { withSessionLock } from './session-lock.mjs';
import { isSessionId, readSessionFile, writeSessionFile } from './session-store.mjs';

const ANSWER_TTL_MS = 10 * 1000; // the prompt comes right after the guard's answer; an older record belongs to an earlier call
const MAX_STORE_BYTES = 64 * 1024; // a few hundred live answers at most; a bigger file was not written here

/**
 * @param {Record<string, string | undefined>} env process environment (HOME or USERPROFILE)
 * @returns {string} the directory holding one file per session
 */
export const answeredCommandsDir = (env = process.env) => join(env.HOME || env.USERPROFILE || homedir(), '.claude', 'state', 'guard-answered');

/** @returns {string} the record key: sha256 of the agent, the directory and the exact command (the session is the file) */
const digestOf = ({ agentId, cwd, command }) => createHash('sha256').update(JSON.stringify([String(agentId ?? ''), String(cwd ?? ''), command])).digest('hex');

/** @returns {boolean} true when the call has a usable session id and command text */
const usable = (call) => isSessionId(call?.session) && typeof call.command === 'string';

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
 * Records that the owner allowed a command in the guard's dialog (Allow click or timeout). Never throws.
 * @param {{session?: string, agentId?: string, cwd?: string, command: string}} call the guarded call (the command is hashed, never written)
 * @param {Record<string, string | undefined>} env process environment (HOME)
 * @param {() => number} now clock in milliseconds
 * @returns {void}
 */
export function rememberAnswered(call, env = process.env, now = Date.now) {
  if (!usable(call)) return;
  const dir = answeredCommandsDir(env);
  withSessionLock(dir, call.session, () => {
    const answers = readFresh(dir, call.session, now());
    if (answers) writeSessionFile(dir, call.session, JSON.stringify({ answers: { ...answers, [digestOf(call)]: now() } }));
  });
}

/**
 * @param {{session?: string, agentId?: string, cwd?: string, command: string}} call the permission prompt's call
 * @param {Record<string, string | undefined>} env process environment (HOME)
 * @param {() => number} now clock in milliseconds
 * @returns {boolean} true when the guard recorded an answer for this session, agent, directory and command within ANSWER_TTL_MS and
 *   the record was removed (used once); false when the removal failed
 */
export function takeAnswered(call, env = process.env, now = Date.now) {
  if (!usable(call)) return false;
  const dir = answeredCommandsDir(env);
  const taken = withSessionLock(dir, call.session, () => {
    const answers = readFresh(dir, call.session, now());
    const digest = digestOf(call);
    if (!answers || !(digest in answers)) return false;
    const { [digest]: _used, ...rest } = answers;
    return writeSessionFile(dir, call.session, JSON.stringify({ answers: rest })); // not removed: not taken, so it is never taken twice
  });
  return taken === true;
}
