// Bounce once: an ask the agent can remove by rewriting its command is denied the first time, with the rewrite instruction, instead of a
// timed dialog that nobody may be there to answer (it goes ahead after 2 min). The identical command sent again (same text, same cwd,
// same session) takes the normal ask path, so the owner still decides whenever the agent really needs that exact command.
// Exports: bounceText(reasons) -> deny text | undefined, bounceOnce(ask, call, env) -> hook stdout | undefined, bouncedDir(env),
// MAX_BOUNCED, RETRY_LINE, adviceOnce(advice, call, env) -> hook stdout (also used by agent-model-guard.mjs), withAdvice(text, advice) -> text.
// Bounce classes (lib/reason-classes.mjs), and only these: the command word is a variable or substitution; a variable holding several
// words run as the command; a risky word inside shell expansion (plain and DESTRUCTIVE); arithmetic on run-time text or a word filled in
// at run time (lib/runtime-values.mjs). An ask with none of them (push, publish, rm outside the project, prod writes, stdin shells,
// credentials, guard errors, "too long", the line's work budget) is untouched. A command with a bounce reason AND other reasons is bounced
// too, and its deny text names those other reasons by class (fixed names, never command text): the rewritten command still asks the owner
// about them, and the identical retry's ask shows every reason. A literal secret is no reason at all (owner G1, lib/remembered-ask.mjs).
// Store (adviceOnce callers may name their own folder instead): ~/.claude/state/guard-bounced/<session>.json through lib/session-store.mjs (lstat-checked: never through a link, never a FIFO;
// folder 0700, file 0600): {"digests": [oldest, ..., newest]}, each the sha256 of [cwd, command] as JSON, so no command text and no secret
// is stored. At most MAX_BOUNCED digests (the oldest is dropped). The match is exact: one changed character (a trailing blank) makes a new
// command, which is judged fresh.
// Log: one line with outcome "bounce", the bounce classes in `class`, and the reason and command as every ask row has them (lib/guard-log.mjs
// masks secrets with maskSecrets and cuts them; fixes spec X11).
// Invariants of bounceOnce: never an allow; a bounce only once its digest is stored, so the retry can ask; anything uncertain (no or odd session id, an
// unusable, corrupt or oversized store, a failed write, an exception) returns undefined, which is today's ask. Hooks recording at the same
// moment take turns (lib/session-lock.mjs withSessionLock), so none drops another's digest, and the file is never half-written (temp file
// + rename); a store still locked after the wait records nothing (today's ask). Subagents share their session's id, so they share its store.
// Advice (adviceOnce): a quality rule (lib/reason-classes.mjs ADVICE_CLASSES), not a safety rule. decide() returns it apart from the reasons
// that ask, as `advice`, so it can never hide or replace one. A command whose only reasons are advice is denied once with the advice (log
// outcome "advice") and its identical retry runs without the owner (outcome "advice-retry"); same store, same match as a bounce. Next to a
// reason that asks or bounces, that path decides as before and its message only names the advice classes ("also: merge commit",
// withAdvice): the advice text says its retry runs, which is false there. Every advice decision is logged like an ask (masked, cut command;
// the advice as the reason); an Agent call passes `logged` instead (no prompt text: fixed fields, and the digest). Advice that cannot be recorded (unusable store, no or odd session id, any failure) runs, logged
// "advice-unrecorded": a deny with no record would come back on every retry and stall the agent, and advice never asks the owner.
// Decision table: what the hook answers, by the kinds of reasons decide() found ("ask" = lib/remembered-ask.mjs: a secret the owner already
// allowed runs silently, its advice still given once as in the advice-only row; else the timed dialog, or the CLI's ask without a GUI):
//   reasons found                    | first send                                  | identical retry (same text, cwd, session)
//   none                             | runs                                        | runs
//   advice only                      | deny: the advice (adviceOnce)               | runs, never the owner
//   ask, no bounce class (+ advice)  | ask (+ the advice classes)                  | ask (+ the advice classes)
//   bounce class (+ ask) (+ advice)  | deny: the rewrite (+ the advice classes)    | ask (+ the advice classes)
//   store unusable or any failure    | advice only: runs, logged advice-unrecorded; every other row: ask
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logDecision } from './guard-log.mjs';
import { BOUNCE_CLASS, BOUNCE_CLASSES, reasonClass } from './reason-classes.mjs';
import { withSessionLock } from './session-lock.mjs';
import { readSessionFile, writeSessionFile } from './session-store.mjs';
import { decisionOutput } from './timed-ask.mjs';

export const MAX_BOUNCED = 200;
const MAX_STORE_BYTES = 64 * 1024; // MAX_BOUNCED digests take about 14 KB; a bigger file was not written here, so it is not trusted
const DIGEST = /^[0-9a-f]{64}$/;

const HEADER = 'Not run: the guard bounced this command once so you can rewrite it (the owner was not asked).';
export const RETRY_LINE = 'If this exact command is what you need, send it again unchanged and the owner will be asked.';
const REWRITES = new Map([
  [BOUNCE_CLASS.variableCommand, 'The command word is a variable or substitution, so the guard cannot see what runs: write the command word out.'],
  [BOUNCE_CLASS.splitVariable, 'A variable holding several words is run as the command: write the command out.'],
  [BOUNCE_CLASS.riskyWord, 'A risky command (rm -r/-f, git push, publish, a gh change, a disk tool or a production host) is in the same call as '
    + '`$(...)`, a backtick, a heredoc, eval or an inline script: run the rm / push in its own call, without `$(...)` or a heredoc.'],
  [BOUNCE_CLASS.tooComplex, 'A word or number is only known when the command runs (arithmetic on text read at run time, or a word from read, '
    + 'an array, "$@" or a loop over quoted or expanded words): write the words or numbers out (a `for` list of plain words is judged per value).'],
]);
const OTHER_RULE = 'another guard rule'; // a reason no class knows (tests keep every rule classed)
const stillAsks = (names) => `The rewritten command will still ask the owner for: ${names.join('; ')}.`;

const unique = (items) => [...new Set(items)];

/**
 * The deny text the agent reads: what to rewrite (one line per bounce class), the classes that will still ask after the rewrite, and how
 * to reach the owner instead.
 * @param {string[]} reasons the ask's reasons one by one (decide's `reasons`)
 * @returns {string | undefined} the text, or undefined when no reason is in a bounce class
 */
export function bounceText(reasons) {
  const rewrites = unique(reasons.map((reason) => REWRITES.get(reasonClass(reason))).filter((line) => line !== undefined));
  if (rewrites.length === 0) return undefined;
  const others = unique(reasons.map((reason) => reasonClass(reason) ?? OTHER_RULE).filter((name) => !BOUNCE_CLASSES.includes(name)));
  return [HEADER, ...rewrites.map((line) => `- ${line}`), ...(others.length > 0 ? [stillAsks(others)] : []), RETRY_LINE].join('\n');
}

/**
 * @param {Record<string, string | undefined>} env process environment (HOME or USERPROFILE)
 * @returns {string} the folder holding one store file per session
 */
export const bouncedDir = (env = process.env) => join(env.HOME || env.USERPROFILE || homedir(), '.claude', 'state', 'guard-bounced');

const digestOf = (cwd, command) => createHash('sha256').update(JSON.stringify([cwd, command])).digest('hex');

/** @returns {string[] | undefined} the stored digests, oldest first ([] before the first bounce); undefined for an unusable or damaged store */
function parseDigests(text) {
  if (text === null) return []; // no store file yet
  if (text === undefined) return undefined;
  try {
    const { digests } = JSON.parse(text);
    return Array.isArray(digests) ? digests.filter((digest) => DIGEST.test(digest)) : undefined;
  } catch {
    return undefined; // damaged: left as it is, and this session asks as before
  }
}

/**
 * Records one send of a command in this session's store, holding the store's lock from the read to the write.
 * @returns {'first' | 'retry' | undefined} 'first' when the digest was not stored before and now is; 'retry' when it was stored before;
 *   undefined when the store is unusable, damaged or still locked, or the write failed
 */
function recordSend(session, digest, env, dir = bouncedDir(env)) {
  return withSessionLock(dir, session, () => {
    const stored = parseDigests(readSessionFile(dir, session, MAX_STORE_BYTES));
    if (stored === undefined) return undefined;
    if (stored.includes(digest)) return 'retry';
    return writeSessionFile(dir, session, JSON.stringify({ digests: [...stored, digest].slice(-MAX_BOUNCED) })) ? 'first' : undefined;
  });
}

const ADVICE_NOTE = 'also: ';

/**
 * A safety verdict's message plus one line naming the advice classes ("also: merge commit"). Never the advice text itself: its "send the
 * same command again and it runs" is false for a command that asks or bounces, and would mislead the owner or the agent.
 * @param {string} text the message of today's path (a deny text, or an ask reason)
 * @param {string[]} [advice] decide's `advice`
 * @returns {string} text, plus that line when there is advice
 */
export function withAdvice(text, advice = []) {
  if (advice.length === 0) return text;
  return `${text}\n${ADVICE_NOTE}${unique(advice.map((line) => reasonClass(line) ?? OTHER_RULE)).join('; ')}`;
}

const ADVICE_HEADER = 'Not run: the guard sent this command back once with advice (the owner was not asked).';
const ADVICE_OUTCOMES = new Map([['first', 'advice'], ['retry', 'advice-retry']]); // recordSend's answer -> log outcome
const ADVICE_UNRECORDED = 'advice-unrecorded'; // the store could not record the send: the command runs

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
    if (text === undefined || recordSend(input.session_id, digestOf(cwd, command), env) !== 'first') return undefined;
    const bounced = unique(ask.reasons.map(reasonClass).filter((name) => BOUNCE_CLASSES.includes(name)));
    logDecision({ hook: 'pre-bash-guard', tool: 'Bash', decision: 'deny', outcome: 'bounce', class: bounced.join(', '), reason: ask.reason, command, cwd, session: input.session_id }, env);
    return decisionOutput({ decision: 'deny', reason: withAdvice(text, ask.advice) });
  } catch {
    return undefined; // a failure in this step falls back to today's ask, never to an allow
  }
}

/**
 * The hook stdout for a command whose only reasons are advice (decide's `allow: true` with `advice`, or an ask lib/remembered-ask.mjs
 * found already answered); see the decision table above. Every call writes one log line: the masked command, the advice as the reason.
 * @param {string[]} advice decide's `advice` (fixed texts, see lib/reason-classes.mjs)
 * @param {{command: string, cwd: string, input: {session_id?: unknown}, hook?: string, tool?: string, logged?: object}} call the call
 *   being guarded; hook and tool name it in the log line (default pre-bash-guard and Bash; agent-model-guard.mjs passes its own for an
 *   Agent call). logged, when given, replaces the advice, command, cwd and session in the log line (the digest is added): agent-model-guard
 *   passes fixed fields, so no prompt text reaches the log. store, when given, is the folder of a store of the caller's own (default: the
 *   guard's bounce store): a hook that runs on the same Bash call as the guard (agent-budget) must not use the guard's, or its deny would
 *   mark the command as already bounced and the guard would ask instead of giving its rewrite advice
 * @param {Record<string, string | undefined>} env process environment (HOME, CLAUDE_GUARD_LOG)
 * @returns {string} a PreToolUse deny JSON line on the first send; '' (no decision: the command runs) on the identical retry, and when
 *   the send cannot be recorded (logged "advice-unrecorded"), so a deny never repeats and the owner is never asked
 */
export function adviceOnce(advice, { command, cwd, input, hook = 'pre-bash-guard', tool = 'Bash', logged, store }, env = process.env) {
  const details = (digest) => (logged === undefined
    ? { reason: advice.join('; '), command, cwd, session: input.session_id, class: unique(advice.map(reasonClass)).join(', ') }
    : { ...logged, digest });
  const log = (decision, outcome, digest) => logDecision({ hook, tool, decision, outcome, ...details(digest) }, env);
  try {
    const digest = digestOf(cwd, command);
    const send = recordSend(input.session_id, digest, env, store);
    log(send === 'first' ? 'deny' : 'allow', ADVICE_OUTCOMES.get(send) ?? ADVICE_UNRECORDED, digest);
    return send === 'first' ? decisionOutput({ decision: 'deny', reason: [ADVICE_HEADER, ...advice.map((line) => `- ${line}`)].join('\n') }) : '';
  } catch {
    log('allow', ADVICE_UNRECORDED); // logDecision never throws
    return ''; // advice is never a reason to ask: a failure here lets the command run, as decide() allowed it
  }
}
