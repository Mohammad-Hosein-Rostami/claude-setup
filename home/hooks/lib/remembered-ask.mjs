// The Bash guard's answer to an ask: a one-time bounce for a command the agent can rewrite (lib/bounce-once.mjs), else the timed dialog,
// whose allow or timeout is remembered for Claude Code's own permission prompt. Exports: askOrBounce(ask, call, env), logSecretKind(kind, call, env).
// Advice (the ask's `advice`, quality rules) never changes a safety decision: the reason the dialog, the CLI's ask, the log and a bounce's
// deny text show only names its classes (withAdvice, lib/bounce-once.mjs).
// An allow or timeout is handed to permission-timed-allow.mjs (lib/answered-commands.mjs, keyed on session, agent, directory and
// command, 10 s), so Claude Code's own permission prompt for the same command right after it opens no second dialog.
// Literal secrets (owner G1, 2026-11-23): a secret value typed into a command never asks and is never bounced; logSecretKind writes the
// one guard.jsonl line that names its kind (never the value, never the command text). gitleaks still checks what is committed.
// Invariants: never an allow for an ask (a bounce is a deny, and its identical retry takes the dialog); nothing is remembered on deny,
// no-gui, dialog-failed or bounce.
import { rememberAnswered } from './answered-commands.mjs';
import { bounceOnce, withAdvice } from './bounce-once.mjs';
import { logDecision } from './guard-log.mjs';
import { askOwner } from './timed-ask.mjs';

export const SECRET_OUTCOME = 'secret'; // the log outcome of a secret's kind line (a note, not an ask: nobody is asked)

/**
 * The hook stdout for an ask: a command the agent can rewrite is bounced the first time (lib/bounce-once.mjs), and the rest (the
 * identical retry included) get the timed dialog.
 * @param {{reason: string, reasons?: string[], advice?: string[], errorClass?: string}} ask the ask from decideSafely
 * @param {{command: string, cwd: string, input: {session_id?: string, agent_id?: string}}} call the Bash call being guarded
 * @param {Record<string, string | undefined>} env process environment (HOME, dialog, log)
 * @returns {string} hook stdout ('' for allow; a deny line for a bounce or a Deny click)
 */
export function askOrBounce(ask, { command, cwd, input }, env = process.env) {
  // after a rules error the log gets the error class and no command text (the dialog still shows it)
  const reason = ask.errorClass ? `${ask.reason}: ${ask.errorClass}` : withAdvice(ask.reason, ask.advice);
  const bounced = bounceOnce(ask, { command, cwd, input }, env); // never throws; undefined means "ask as usual"
  if (bounced) return bounced; // only a deny line ends here: empty hook output would be an allow
  const onAnswer = (answer) => {
    if (answer.decision === 'allow') rememberAnswered({ session: input.session_id, agentId: input.agent_id, cwd, command }, env);
  };
  return askOwner({ hook: 'pre-bash-guard', tool: 'Bash', reason, command, cwd, sessionId: input.session_id, agentId: input.agent_id, omitCommandFromLog: ask.errorClass !== undefined, onAnswer }, env);
}

/**
 * Notes a literal secret found in a command (owner G1): one log line with the kind as its reason and no command text.
 * @param {string} kind what lib/secrets.mjs findLiteralSecret found ("a GitHub token", ...)
 * @param {{cwd: string, input: {session_id?: string}}} call the Bash call being guarded
 * @param {Record<string, string | undefined>} env process environment (CLAUDE_GUARD_LOG)
 * @returns {void}
 */
export function logSecretKind(kind, { cwd, input }, env = process.env) {
  logDecision({ hook: 'pre-bash-guard', tool: 'Bash', decision: 'allow', outcome: SECRET_OUTCOME, class: 'secret', reason: kind, command: '', cwd, session: input.session_id }, env);
}
