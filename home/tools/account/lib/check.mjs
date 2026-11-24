// Purpose: say whether a token still works: one tiny Haiku call on that token.
// Exports: checkToken, CHECK_VALID, CHECK_REVOKED.
// Invariants: the call goes through `callHaiku` of claude-call.mjs, so it has the fixed flags (`--model
// haiku`, never `--bare`, hooks off, no session kept) and writes its usage row with the account name; one call, no second
// attempt and never another account; `claude auth status` is not used: it answers "logged in" for any token without
// asking the server (probe ACC-3). The result is a class, never the reply text.
import { callHaiku } from './claude-call.mjs';

export const CHECK_VALID = 'valid';
export const CHECK_REVOKED = 'revoked';
const CHECK_LABEL = 'account-check';
// "Revoked" is a reply that holds "revoked" or "401" (certainty/root-causes.md:14-17; a made-up token gives
// "401 OAuth access token is invalid", probe ACC-9a).
const REVOKED_REPLY = /revoked|\b401\b/i;
const FAILURE_CLASSES = [[/usage limit|rate limit|\b429\b/i, 'limit'], [/not on PATH/, 'no-claude'], [/timed out/, 'timeout']];

/**
 * @param {string | null} name the account name for the usage row (null for a token that is not stored).
 * @param {string} token the token to try.
 * @param {{env?: object, call?: Function}} options `call` replaces `callHaiku` (tests).
 * @returns {Promise<string>} `valid`, `revoked`, or `check failed: <class>` (limit, no-claude, timeout, other).
 */
export async function checkToken(name, token, { env = process.env, call = callHaiku } = {}) {
  try {
    await call({ system: 'Reply with the single word ok.', prompt: 'ok', label: CHECK_LABEL, env, account: { name, token } });
    return CHECK_VALID;
  } catch (error) {
    if (REVOKED_REPLY.test(error.message)) return CHECK_REVOKED;
    const failure = FAILURE_CLASSES.find(([pattern]) => pattern.test(error.message));
    return `check failed: ${failure ? failure[1] : 'other'}`;
  }
}
