// Shared wording for guard reasons: a destructive rule's reason starts with DESTRUCTIVE_PREFIX so its dialog stands out, a literal secret's
// reason comes from secretReason, and a reason only the backstop parser found ends with BACKSTOP_MARK.
// Exports: DESTRUCTIVE_PREFIX, destructive(what) -> reason, MAX_COMMAND_CHARS, BACKSTOP_MARK, secretReason(kind), isSecretOnlyReason(reason),
// secretKindOf(reason) -> kind | undefined.
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
const ONE_SECRET_REASON = new RegExp(`^${SECRET_REASON}$`);

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
 * @param {string} reason ONE ask reason (not a joined list)
 * @returns {string | undefined} the secret kind when it is a literal-secret reason (marked or not), else undefined
 */
export const secretKindOf = (reason) => ONE_SECRET_REASON.exec(reason)?.[1];
