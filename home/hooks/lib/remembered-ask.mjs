// The guard's ask for a literal secret, with the per-session memory of values the owner already allowed.
// Exports: secretReason(kind), isSecretOnlyReason(reason), neutralise(command, values), askUnlessRemembered(ask, call).
// Why: the same allowed value (a file key, a test password) must not re-open the dialog every time (lib/allowed-literals.mjs holds the
// digests). Skipping the dialog is only safe when NOTHING else about the command needs an answer, so it takes all of: the ask is
// secret-only, every value is long enough and remembered, and the command still passes the full rules once each remembered value
// is replaced by an environment reference (that re-check also runs the fail-to-ask backstop, which a secret reason switches off, and
// still sees a secret the value extraction missed: nested, partial or re-quoted text). Anything uncertain shows the dialog.
// Invariants: never remembers on deny, no-gui or dialog-failed; no raw value is logged or stored.
import { isRemembered, remember } from './allowed-literals.mjs';
import { logDecision } from './guard-log.mjs';
import { literalSecretValues } from './secrets.mjs';
import { askOwner } from './timed-ask.mjs';

export const REMEMBERED_ENV_REF = '$GUARD_REMEMBERED';
const SECRET_REASON_PREFIX = 'the command contains a literal password/token (';
const SECRET_REASON_SUFFIX = '); prefer an env var or a file the tool reads';
const BACKSTOP_MARK = ' (matched in raw text)';
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SECRET_REASON = `${escapeRegExp(SECRET_REASON_PREFIX)}[^)]*${escapeRegExp(SECRET_REASON_SUFFIX)}(?:${escapeRegExp(BACKSTOP_MARK)})?`;
const SECRET_ONLY_REASONS = new RegExp(`^${SECRET_REASON}(?:; ${SECRET_REASON})*$`);

/**
 * @param {string} kind what findLiteralSecret found ("an Anthropic API key", ...)
 * @returns {string} the ask reason for a literal secret; it never repeats the secret
 */
export const secretReason = (kind) => `${SECRET_REASON_PREFIX}${kind}${SECRET_REASON_SUFFIX}`;

/**
 * @param {string} reason an ask reason; decide joins several with "; "
 * @returns {boolean} true when every reason is a literal-secret reason (with or without the "(matched in raw text)" mark)
 */
export const isSecretOnlyReason = (reason) => SECRET_ONLY_REASONS.test(reason);

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
 * "remembered") when the command is also clean with those values neutralised; otherwise the timed dialog runs, and an allow or
 * timeout on a secret-only ask is remembered.
 * @param {{reason: string, errorClass?: string}} ask the ask from decideSafely
 * @param {{command: string, cwd: string, input: {session_id?: string, agent_id?: string}, recheck: (text: string) => {allow?: boolean}}} call
 *   the Bash call being guarded; recheck runs the same rules (same context, prod hosts included) on other text
 * @param {Record<string, string | undefined>} env process environment (HOME, dialog, log)
 * @returns {string} hook stdout ('' for allow)
 */
export function askUnlessRemembered(ask, { command, cwd, input, recheck }, env = process.env) {
  // after a rules error the log gets the error class and no command text (the dialog still shows it)
  const reason = ask.errorClass ? `${ask.reason}: ${ask.errorClass}` : ask.reason;
  const values = !ask.errorClass && isSecretOnlyReason(ask.reason) ? literalSecretValues(command) : [];
  if (isRemembered(input.session_id, values, env) && recheck(neutralise(command, values)).allow === true) {
    logDecision({ hook: 'pre-bash-guard', tool: 'Bash', decision: 'allow', outcome: 'remembered', reason, command, cwd, session: input.session_id }, env);
    return '';
  }
  const onAnswer = (answer) => answer.decision === 'allow' && remember(input.session_id, values, env);
  return askOwner({ hook: 'pre-bash-guard', tool: 'Bash', reason, command, cwd, sessionId: input.session_id, agentId: input.agent_id, omitCommandFromLog: ask.errorClass !== undefined, onAnswer }, env);
}
