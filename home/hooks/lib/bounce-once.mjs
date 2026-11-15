// Bounce once: an ask the agent can remove by rewriting its command is denied the first time, with the rewrite instruction, instead of a
// timed dialog that nobody may be there to answer (it goes ahead after 30-180 s). The identical command sent again (same text, same cwd,
// same session) takes the normal ask path, so the owner still decides whenever the agent really needs that exact command.
// Exports: bounceText(reasons) -> deny text | undefined, bounceOnce(ask, call, env) -> hook stdout | undefined, bouncedDir(env),
// MAX_BOUNCED, RETRY_LINE, adviceOnce(advice, call, env) -> hook stdout, withAdvice(text, advice) -> text.
// Bounce classes (lib/reason-classes.mjs), and only these: the command word is a variable or substitution; a variable holding several
// words run as the command; a risky word inside shell expansion (plain and DESTRUCTIVE); a literal secret. An ask with none of them (push,
// publish, rm outside the project, prod writes, stdin shells, credentials, guard errors, "too long") is untouched. A command with a bounce
// reason AND other reasons is bounced too, and its deny text names those other reasons by class (fixed names, never command text): the
// rewritten command still asks the owner about them, and the identical retry's ask shows every reason. A literal secret's deny text ends
// with an instruction to tell the owner, in the final report, which kind of secret was typed: the transcript holds it now.
// Store: ~/.claude/state/guard-bounced/<session>.json through lib/session-store.mjs (lstat-checked: never through a link, never a FIFO;
// folder 0700, file 0600): {"digests": [oldest, ..., newest]}, each the sha256 of [cwd, command] as JSON, so no command text and no secret
// is stored. At most MAX_BOUNCED digests (the oldest is dropped). The match is exact: one changed character (a trailing blank) makes a new
// command, which is judged fresh.
// Log: one line with outcome "bounce" and the bounce classes in `class`; it holds no command or reason text.
// Invariants of bounceOnce: never an allow; a bounce only once its digest is stored, so the retry can ask; anything uncertain (no or odd session id, an
// unusable, corrupt or oversized store, a failed write, an exception) returns undefined, which is today's ask. Two hooks writing at the same
// moment cannot corrupt the file (temp file + rename), but one may drop the other's new digest: that command is then bounced once more,
// never allowed. Subagents share their session's id, so they share its store.
// Advice (adviceOnce): a quality rule (lib/reason-classes.mjs ADVICE_CLASSES), not a safety rule. decide() returns it apart from the reasons
// that ask, as `advice`, so it can never hide or replace one. A command whose only reasons are advice is denied once with the advice (log
// outcome "advice") and its identical retry runs without the owner (outcome "advice-retry"); same store, same match as a bounce. Next to a
// reason that asks or bounces, that path decides as before and the advice text is only appended to its message (withAdvice).
// Decision table: what the hook answers, by the kinds of reasons decide() found ("ask" = lib/remembered-ask.mjs: a secret the owner already
// allowed runs silently, else the timed dialog, or the CLI's ask without a GUI):
//   reasons found                    | first send                                  | identical retry (same text, cwd, session)
//   none                             | runs                                        | runs
//   advice only                      | deny: the advice (adviceOnce)               | runs, never the owner
//   ask, no bounce class (+ advice)  | ask (+ the advice text)                     | ask (+ the advice text)
//   bounce class (+ ask) (+ advice)  | deny: the rewrite (+ the advice text)       | ask (+ the advice text)
//   store unusable or any failure    | advice only: runs (a deny could repeat forever); every other row: ask
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logDecision } from './guard-log.mjs';
import { BOUNCE_CLASS, BOUNCE_CLASSES, reasonClass } from './reason-classes.mjs';
import { readSessionFile, writeSessionFile } from './session-store.mjs';
import { decisionOutput } from './timed-ask.mjs';
import { BACKSTOP_MARK, secretKindOf } from './verdict.mjs';

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
]);
const rewriteSecret = (kind) => `The command contains a literal password/token (${kind}): pass it through an environment variable or a file the tool reads.`;
const OTHER_RULE = 'another guard rule'; // a reason no class knows (tests keep every rule classed)
const stillAsks = (names) => `The rewritten command will still ask the owner for: ${names.join('; ')}.`;
const reportSecret = (kinds) => `In your final report, tell the owner that a secret was typed into a command (${kinds.join('; ')}; never its value): `
  + 'the transcript now holds it, so they may want to rotate it.';

const unique = (items) => [...new Set(items)];
const withoutMark = (reason) => (reason.endsWith(BACKSTOP_MARK) ? reason.slice(0, -BACKSTOP_MARK.length) : reason);

/** @returns {string | undefined} the rewrite instruction for ONE ask reason, or undefined when its class is not bounced */
function rewriteFor(reason) {
  const name = reasonClass(reason);
  return name === BOUNCE_CLASS.secret ? rewriteSecret(secretKindOf(withoutMark(reason))) : REWRITES.get(name);
}

/**
 * The deny text the agent reads: what to rewrite (one line per bounce class), the classes that will still ask after the rewrite, how to
 * reach the owner instead, and for a literal secret what to tell the owner.
 * @param {string[]} reasons the ask's reasons one by one (decide's `reasons`)
 * @returns {string | undefined} the text, or undefined when no reason is in a bounce class
 */
export function bounceText(reasons) {
  const rewrites = unique(reasons.map(rewriteFor).filter((line) => line !== undefined));
  if (rewrites.length === 0) return undefined;
  const others = unique(reasons.map((reason) => reasonClass(reason) ?? OTHER_RULE).filter((name) => !BOUNCE_CLASSES.includes(name)));
  const kinds = unique(reasons.map((reason) => secretKindOf(withoutMark(reason))).filter((kind) => kind !== undefined));
  return [
    HEADER,
    ...rewrites.map((line) => `- ${line}`),
    ...(others.length > 0 ? [stillAsks(others)] : []),
    RETRY_LINE,
    ...(kinds.length > 0 ? [reportSecret(kinds)] : []),
  ].join('\n');
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
 * Records one send of a command in this session's store.
 * @returns {'first' | 'retry' | undefined} 'first' when the digest was not stored before and now is; 'retry' when it was stored before;
 *   undefined when the store is unusable or damaged, or the write failed
 */
function recordSend(session, digest, env) {
  const stored = parseDigests(readSessionFile(bouncedDir(env), session, MAX_STORE_BYTES));
  if (stored === undefined) return undefined;
  if (stored.includes(digest)) return 'retry';
  return writeSessionFile(bouncedDir(env), session, JSON.stringify({ digests: [...stored, digest].slice(-MAX_BOUNCED) })) ? 'first' : undefined;
}

/**
 * @param {string} text the message of today's path (a deny text, or an ask reason)
 * @param {string[]} [advice] decide's `advice`
 * @returns {string} text with each advice text appended on its own line (unchanged without advice)
 */
export const withAdvice = (text, advice = []) => [text, ...advice].join('\n');

const ADVICE_HEADER = 'Not run: the guard sent this command back once with advice (the owner was not asked).';

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
    logDecision({ hook: 'pre-bash-guard', tool: 'Bash', decision: 'deny', outcome: 'bounce', class: bounced.join(', '), cwd, session: input.session_id }, env);
    return decisionOutput({ decision: 'deny', reason: withAdvice(text, ask.advice) });
  } catch {
    return undefined; // a failure in this step falls back to today's ask, never to an allow
  }
}

/**
 * The hook stdout for a command whose only reasons are advice (decide's `allow: true` with `advice`); see the decision table above.
 * @param {string[]} advice decide's `advice` (fixed texts, see lib/reason-classes.mjs)
 * @param {{command: string, cwd: string, input: {session_id?: unknown}}} call the Bash call being guarded
 * @param {Record<string, string | undefined>} env process environment (HOME, CLAUDE_GUARD_LOG)
 * @returns {string} a PreToolUse deny JSON line on the first send; '' (no decision: the command runs) on the identical retry, and when
 *   the store is unusable or anything fails, so a deny never repeats and the owner is never asked
 */
export function adviceOnce(advice, { command, cwd, input }, env = process.env) {
  try {
    const send = recordSend(input.session_id, digestOf(cwd, command), env);
    if (send === undefined) return '';
    const first = send === 'first';
    const classes = unique(advice.map(reasonClass)).join(', ');
    logDecision({ hook: 'pre-bash-guard', tool: 'Bash', decision: first ? 'deny' : 'allow', outcome: first ? 'advice' : 'advice-retry', class: classes, cwd, session: input.session_id }, env);
    return first ? decisionOutput({ decision: 'deny', reason: [ADVICE_HEADER, ...advice.map((line) => `- ${line}`)].join('\n') }) : '';
  } catch {
    return ''; // advice is never a reason to ask: a failure here lets the command run, as decide() allowed it
  }
}
