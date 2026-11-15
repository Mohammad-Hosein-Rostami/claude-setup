// The guard's answer to an ask: silent for a literal secret the owner already allowed, a one-time bounce for a command the agent can
// rewrite (lib/bounce-once.mjs), else the timed dialog. Exports: neutralise(command, values), askUnlessRemembered(ask, call).
// Why: the same allowed value (a file key, a test password) must not re-open the dialog every time (lib/allowed-literals.mjs holds the
// digests). Skipping the dialog is only safe when NOTHING else about the command needs an answer, so it takes all of: the ask is
// secret-only, every value is long enough and remembered, and the command still passes the full rules once each remembered value
// is replaced by an environment reference (that re-check also runs the fail-to-ask backstop, which a secret reason switches off, and
// still sees a secret the value extraction missed: nested, partial or re-quoted text). Anything uncertain shows the dialog.
// A remembered value is checked before the bounce, so an already allowed secret is never bounced.
// A secret-only dialog waits CLAUDE_ASK_SECRET_TIMEOUT_S (default 30 s, never more than CLAUDE_ASK_TIMEOUT_S) before going ahead as Allow.
// Advice (the ask's `advice`, quality rules) never changes a safety decision: "secret-only" is judged without it, and the reason the dialog,
// the CLI's ask, the log and a bounce's deny text show only names its classes (withAdvice, lib/bounce-once.mjs). When a remembered secret
// makes the command silent, its advice is still given once (adviceOnce), exactly as for a command with advice alone.
// An allow or timeout is also handed to permission-timed-allow.mjs (lib/answered-commands.mjs), so Claude Code's own permission prompt
// for the same command right after it opens no second dialog.
// Invariants: never remembers on deny, no-gui, dialog-failed or bounce; no raw value is logged or stored.
import { isRemembered, remember } from './allowed-literals.mjs';
import { rememberAnswered } from './answered-commands.mjs';
import { adviceOnce, bounceOnce, withAdvice } from './bounce-once.mjs';
import { logDecision } from './guard-log.mjs';
import { literalSecretValues } from './secrets.mjs';
import { ASK_TIMEOUT_ENV, askOwner, secretAskTimeoutSeconds } from './timed-ask.mjs';
import { isSecretOnlyReason } from './verdict.mjs';

export const REMEMBERED_ENV_REF = '$GUARD_REMEMBERED';

/**
 * @param {string} command raw command text
 * @param {string[]} values the remembered literal values found in it
 * @returns {string} the command with every occurrence of each value (longest first) replaced by an environment reference
 */
export function neutralise(command, values) {
  return [...values].sort((first, second) => second.length - first.length).reduce((text, value) => text.split(value).join(REMEMBERED_ENV_REF), command);
}

/**
 * The hook stdout for an ask. A secret-only ask whose values the owner already allowed in this session is silent (logged as
 * "remembered") when the command is also clean with those values neutralised, and then only its advice, if any, is given once; otherwise
 * a command the agent can rewrite is bounced the first time (lib/bounce-once.mjs), and the rest get the timed dialog, where an allow or
 * timeout on a secret-only ask is remembered.
 * @param {{reason: string, reasons?: string[], advice?: string[], errorClass?: string}} ask the ask from decideSafely
 * @param {{command: string, cwd: string, input: {session_id?: string, agent_id?: string}, recheck: (text: string) => {allow?: boolean}}} call
 *   the Bash call being guarded; recheck runs the same rules (same context, prod hosts included) on other text
 * @param {Record<string, string | undefined>} env process environment (HOME, dialog, log)
 * @returns {string} hook stdout ('' for allow; a deny line for a bounce, a Deny click, or advice given once)
 */
export function askUnlessRemembered(ask, { command, cwd, input, recheck }, env = process.env) {
  // after a rules error the log gets the error class and no command text (the dialog still shows it)
  const reason = ask.errorClass ? `${ask.reason}: ${ask.errorClass}` : withAdvice(ask.reason, ask.advice);
  const secretOnly = !ask.errorClass && isSecretOnlyReason(ask.reason);
  const values = secretOnly ? literalSecretValues(command) : [];
  if (isRemembered(input.session_id, values, env) && recheck(neutralise(command, values)).allow === true) {
    logDecision({ hook: 'pre-bash-guard', tool: 'Bash', decision: 'allow', outcome: 'remembered', reason, command, cwd, session: input.session_id }, env);
    return ask.advice ? adviceOnce(ask.advice, { command, cwd, input }, env) : ''; // the secret needs no answer; its advice still counts
  }
  const bounced = bounceOnce(ask, { command, cwd, input }, env); // never throws; undefined means "ask as usual"
  if (bounced) return bounced; // only a deny line ends here: empty hook output would be an allow
  const askEnv = secretOnly ? { ...env, [ASK_TIMEOUT_ENV]: String(secretAskTimeoutSeconds(env)) } : env; // a secret-only dialog waits less
  const onAnswer = (answer) => {
    if (answer.decision !== 'allow') return;
    remember(input.session_id, values, env);
    rememberAnswered(input.session_id, command, env); // Claude Code's own prompt for this command then opens no second dialog
  };
  return askOwner({ hook: 'pre-bash-guard', tool: 'Bash', reason, command, cwd, sessionId: input.session_id, agentId: input.agent_id, omitCommandFromLog: ask.errorClass !== undefined, onAnswer }, askEnv);
}
