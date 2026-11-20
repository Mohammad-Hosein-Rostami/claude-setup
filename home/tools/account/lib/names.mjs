// Purpose: the two patterns everything else rests on (an account name, a token), the error type of the account tool, and
// the reading of a pasted line.
// Exports: AccountError, NAME_PATTERN, TOKEN_PATTERN, PASTE_MAX_BYTES, assertName, assertToken,
// tokenFromPaste, looksLikeToken.
// Invariants: a name or a token that passes its pattern holds no space, quote, slash, dot or newline, so it can be put
// into the one-line command text of `security -i` and into a file name as it is; no message built here holds any part
// of a token or of the pasted text.

/** An error of the account tool; `kind` is one of name, token, unknown, usage, store, unsafe-file, registry, revoked, place. */
export class AccountError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'AccountError';
    this.kind = kind;
  }
}

/**
 * An account name: 1 to 32 characters of a-z, 0-9, _ and -, starting with a letter or a digit. So `-`, the value of
 * CLAUDE_ACCOUNT in a `claude-as --once` terminal, is never a name: no stored account is spent for it.
 */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const TOKEN_SHAPE = 'sk-ant-[A-Za-z0-9_-]{10,500}';
/** A token: the whole string, one line (the shape of home/hooks/lib/secrets.mjs, with a length cap). */
export const TOKEN_PATTERN = new RegExp(`^${TOKEN_SHAPE}$`);
const TOKEN_ANYWHERE = /sk-ant-[A-Za-z0-9_-]{10,}/;
// The line the owner is used to pasting: `export CLAUDE_CODE_OAUTH_TOKEN="..."`, with or without export and quotes.
const PASTED_LINE = new RegExp(`^[ \\t]*(?:(?:export[ \\t]+)?CLAUDE_CODE_OAUTH_TOKEN=)?(["']?)(${TOKEN_SHAPE})\\1[ \\t]*;?[ \\t]*\\r?\\n?$`);
/** Most bytes of a pasted line that are read (a token is about 110 characters). */
export const PASTE_MAX_BYTES = 4096;

/**
 * @param {string} name what the caller was given as an account name.
 * @returns {string} the same name.
 * @throws {AccountError} kind `name` when it does not match NAME_PATTERN (checked before any store call).
 */
export function assertName(name) {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new AccountError('name', 'an account name is 1 to 32 characters of a-z, 0-9, _ and -, starting with a letter or a digit');
  }
  return name;
}

/**
 * @param {string} token what is about to be stored or was read from a store.
 * @returns {string} the same token.
 * @throws {AccountError} kind `token` when it is not one line of the token shape. The message never quotes it.
 */
export function assertToken(token) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw new AccountError('token', 'that is not a token: expected one line starting with sk-ant-');
  return token;
}

/**
 * Takes the token out of a pasted line: the bare token or the whole `export CLAUDE_CODE_OAUTH_TOKEN="..."` line.
 * @param {string} text the pasted text (one line).
 * @returns {string} the token.
 * @throws {AccountError} kind `token` for anything else (two lines, other text around it). The message never quotes it.
 */
export function tokenFromPaste(text) {
  const match = typeof text === 'string' && Buffer.byteLength(text) <= PASTE_MAX_BYTES ? PASTED_LINE.exec(text) : null;
  if (!match) throw new AccountError('token', 'that is not a token: paste the token itself or the whole export CLAUDE_CODE_OAUTH_TOKEN="..." line, one line');
  return match[2];
}

/** True when the text holds something shaped like a token (an argument that must never be one). */
export const looksLikeToken = (text) => TOKEN_ANYWHERE.test(text);
