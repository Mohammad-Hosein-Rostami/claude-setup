// Bounce once: an ask the agent can remove by rewriting its command is denied the first time, with the rewrite instruction, instead of a
// timed dialog that nobody may be there to answer (it goes ahead after 30-180 s). The identical command sent again (same text, same cwd,
// same session) takes the normal ask path, so the owner still decides whenever the agent really needs that exact command.
// Exports: bounceText(reasons) -> deny text | undefined, bounceOnce(ask, call, env) -> hook stdout | undefined, bouncedDir(env),
// MAX_BOUNCED, RETRY_LINE.
// Bounce classes, and only these: the command word is a variable or substitution; a variable holding several words run as the command; a
// risky word inside shell expansion (plain and DESTRUCTIVE); a literal secret. Every other ask (push, publish, rm outside the project,
// prod writes, stdin shells, credentials, guard errors, "too long") is untouched. A command with a bounce reason AND another reason is
// bounced too: the rewritten command still meets the other ask, and the retry's ask shows every reason, the bounce class included.
// Store: ~/.claude/state/guard-bounced/<session>.json, next to guard-allowed (lib/allowed-literals.mjs) with the same session id rule and
// modes (folder 0700, file 0600): {"digests": [oldest, ..., newest]}, each the sha256 of [cwd, command] as JSON, so no command text and no
// secret is stored. At most MAX_BOUNCED digests (the oldest is dropped); files untouched for 7 days are pruned on write. The match is
// exact: one changed character (a trailing blank) makes a new command, which is judged fresh.
// Invariants: never an allow; a bounce only once its digest is stored, so the retry can ask; anything uncertain (no or odd session id,
// unreadable, corrupt or oversized store, failed write, an exception) returns undefined, which is today's ask. Two hooks writing at the
// same moment cannot corrupt or lose the file (temp file + rename), but one may drop the other's new digest: that command is then
// bounced once more, never allowed. Subagents share their session's id, so they share its store.
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logDecision } from './guard-log.mjs';
import { RISKY_REASON } from './raw-risk.mjs';
import { SPLIT_VARIABLE_REASON, VARIABLE_COMMAND_REASON } from './shell-hazards.mjs';
import { decisionOutput } from './timed-ask.mjs';
import { BACKSTOP_MARK, DESTRUCTIVE_PREFIX, secretKindOf } from './verdict.mjs';

export const MAX_BOUNCED = 200;
const MAX_STORE_BYTES = 64 * 1024; // MAX_BOUNCED digests take about 14 KB; a bigger file was not written here, so it is not trusted
const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const HEADER = 'Not run: the guard bounced this command once so you can rewrite it (the owner was not asked).';
export const RETRY_LINE = 'If this exact command is what you need, send it again unchanged and the owner will be asked.';
const REWRITE_COMMAND_WORD = 'The command word is a variable or substitution, so the guard cannot see what runs: write the command word out.';
const REWRITE_SPLIT_VARIABLE = 'A variable holding several words is run as the command: write the command out.';
const REWRITE_RISKY = 'A risky command (rm -r/-f, git push, publish, a gh change, a disk tool or a production host) is in the same call as '
  + '`$(...)`, a backtick, a heredoc, eval or an inline script: run the rm / push in its own call, without `$(...)` or a heredoc.';
const rewriteSecret = (kind) => `The command contains a literal password/token (${kind}): pass it through an environment variable or a file the tool reads.`;

/** @returns {string | undefined} the rewrite instruction for ONE ask reason, or undefined when its class is not bounced */
function rewriteFor(reason) {
  const plain = reason.endsWith(BACKSTOP_MARK) ? reason.slice(0, -BACKSTOP_MARK.length) : reason;
  if (plain === VARIABLE_COMMAND_REASON) return REWRITE_COMMAND_WORD;
  if (plain === SPLIT_VARIABLE_REASON) return REWRITE_SPLIT_VARIABLE;
  if (plain === RISKY_REASON || plain === `${DESTRUCTIVE_PREFIX}${RISKY_REASON}`) return REWRITE_RISKY;
  const kind = secretKindOf(plain);
  return kind === undefined ? undefined : rewriteSecret(kind);
}

/**
 * The deny text the agent reads: what to rewrite, one line per bounce class, and how to reach the owner instead.
 * @param {string[]} reasons the ask's reasons one by one (decide's `reasons`)
 * @returns {string | undefined} the text, or undefined when no reason is in a bounce class
 */
export function bounceText(reasons) {
  const rewrites = [...new Set(reasons.map(rewriteFor).filter((line) => line !== undefined))];
  return rewrites.length === 0 ? undefined : [HEADER, ...rewrites.map((line) => `- ${line}`), RETRY_LINE].join('\n');
}

/**
 * @param {Record<string, string | undefined>} env process environment (HOME or USERPROFILE)
 * @returns {string} the folder holding one store file per session
 */
export const bouncedDir = (env = process.env) => join(env.HOME || env.USERPROFILE || homedir(), '.claude', 'state', 'guard-bounced');

const digestOf = (cwd, command) => createHash('sha256').update(JSON.stringify([cwd, command])).digest('hex');

/** @returns {string[] | undefined} the stored digests, oldest first ([] before the first bounce); undefined when the file cannot be trusted */
function readBounced(path) {
  let text;
  try {
    if (statSync(path).size > MAX_STORE_BYTES) return undefined;
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return error.code === 'ENOENT' ? [] : undefined;
  }
  try {
    const { digests } = JSON.parse(text);
    return Array.isArray(digests) ? digests.filter((digest) => DIGEST.test(digest)) : undefined;
  } catch {
    return undefined; // damaged: left as it is, and this session asks as before
  }
}

/** Removes session files older than 7 days; best effort, each entry on its own. */
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

/** Writes the digests through a temp file and a rename, so no reader ever sees half a file. Throws when the write fails. */
function writeBounced(path, digests, env) {
  const dir = bouncedDir(env);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  chmodSync(dir, DIR_MODE);
  try {
    pruneOld(dir, Date.now());
  } catch {
    // pruning is housekeeping: it must not stop the write
  }
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ digests }), { mode: FILE_MODE });
  chmodSync(temp, FILE_MODE);
  renameSync(temp, path);
}

/** @returns {boolean} true only when this session never bounced this digest before AND it is now stored */
function storeFirstBounce(session, digest, env) {
  if (typeof session !== 'string' || !SESSION_ID.test(session)) return false;
  const path = join(bouncedDir(env), `${session}.json`);
  const stored = readBounced(path);
  if (stored === undefined || stored.includes(digest)) return false;
  try {
    writeBounced(path, [...stored, digest].slice(-MAX_BOUNCED), env);
    return true;
  } catch {
    return false; // not stored: a bounce now could repeat on every retry, so this call asks as before
  }
}

/**
 * The hook stdout for a bounce, or undefined when this ask takes the normal path (dialog or the CLI's ask).
 * @param {{reason: string, reasons?: string[], errorClass?: string}} ask the ask from decideSafely
 * @param {{command: string, cwd: string, input: {session_id?: unknown}}} call the Bash call being guarded
 * @param {Record<string, string | undefined>} env process environment (HOME, CLAUDE_GUARD_LOG)
 * @returns {string | undefined} a PreToolUse deny JSON line on the first send; undefined for a retry, any other ask, or any failure
 */
export function bounceOnce(ask, { command, cwd, input }, env = process.env) {
  try {
    const text = Array.isArray(ask.reasons) ? bounceText(ask.reasons) : undefined; // a "guard error" ask has no reasons
    if (text === undefined || !storeFirstBounce(input.session_id, digestOf(cwd, command), env)) return undefined;
    logDecision({ hook: 'pre-bash-guard', tool: 'Bash', decision: 'deny', outcome: 'bounce', reason: ask.reason, command, cwd, session: input.session_id }, env);
    return decisionOutput({ decision: 'deny', reason: text });
  } catch {
    return undefined; // a failure in this step falls back to today's ask, never to an allow
  }
}
