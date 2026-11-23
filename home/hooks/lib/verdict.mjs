// Shared wording for guard reasons: a destructive rule's reason starts with DESTRUCTIVE_PREFIX so its dialog stands out, and a reason only
// the backstop parser found ends with BACKSTOP_MARK. secretReason and isSecretOnlyReason keep the wording of the literal-secret ask that
// owner decision R22-G1 retired (no guard rule gives it now; only tests read it, so both can go together in one cleanup).
// Exports: DESTRUCTIVE_PREFIX, destructive(what) -> reason, MAX_COMMAND_CHARS, BACKSTOP_MARK, secretReason(kind), isSecretOnlyReason(reason),
// shown(target) -> a path as a reason repeats it (moved here from lib/rm-paths.mjs, which re-exports it).
import { QUOTED_MARK } from './shell-words.mjs';

export const DESTRUCTIVE_PREFIX = 'DESTRUCTIVE: ';
export const destructive = (what) => `${DESTRUCTIVE_PREFIX}${what}`;
/** A command longer than this skips the fine-grained parsing and asks ("command too long to check"). */
export const MAX_COMMAND_CHARS = 32 * 1024;
export const BACKSTOP_MARK = ' (matched in raw text)';

const SECRET_REASON_PREFIX = 'the command contains a literal password/token (';
const SECRET_REASON_SUFFIX = '); prefer an env var or a file the tool reads';
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SECRET_REASON = `${escapeRegExp(SECRET_REASON_PREFIX)}([^)]*)${escapeRegExp(SECRET_REASON_SUFFIX)}(?:${escapeRegExp(BACKSTOP_MARK)})?`;
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

const MAX_SHOWN_TARGET_CHARS = 120; // how much of a target a reason repeats: the reason goes into the dialog and back to the model
const LINE_BREAKS = /[\r\n]+/g;
const LINE_BREAK_MARK = '⏎'; // a raw line break in a target would split the reason in the CLI prompt and in the text the model reads

/**
 * A target as a reason shows it: without the quote mark, line breaks made visible, and only its start when it is long (the agent wrote
 * it; it is not ours to repeat in full).
 * @param {string} target the path as written
 * @returns {string} the text a reason may hold
 */
export function shown(target) {
  const text = target.replace(QUOTED_MARK, '').replace(LINE_BREAKS, LINE_BREAK_MARK);
  return text.length > MAX_SHOWN_TARGET_CHARS ? `${text.slice(0, MAX_SHOWN_TARGET_CHARS)}… (${text.length} characters)` : text;
}
