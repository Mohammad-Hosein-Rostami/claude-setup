// The login checks of a live run. Exports: LOGIN_LINE, PREFLIGHT_ARGS, PREFLIGHT_TIMEOUT_MS, loginPreflight({cwd, env, timeoutMs}),
// loginRefusal(session).
// Why: the owner's first live E0 run was not logged in, and every one of its claude calls failed one by one. Now the runner asks
// `claude auth status --json` (no model call) with a child's env and the temp HOME before any scenario, and stops with one
// plain line when it is not logged in; and a claude run whose error result is a login refusal stops the whole run (no more
// scenarios, no `--resume` rounds), because every later call would be refused the same way.
// Limit (named in the report): `auth status` reads the login without asking the server, so it says logged in for any token
// that is set; a refused token is caught by loginRefusal on the first real call.
// Invariants: argv only, no shell; the output is redacted (runQuick) before it is read; nothing here prints a token.
import { callErrorClass } from '../../../home/tools/account/lib/claude-call.mjs';
import { runQuick } from './spawn.mjs';

/** The one line a run prints when the preflight finds no login. */
export const LOGIN_LINE = 'not logged in: start a terminal with `claude-as <account>` (a Claude session cannot hand a token on) and rerun';
/** `claude auth status` in its JSON form: `{"loggedIn": true, ...}`. */
export const PREFLIGHT_ARGS = Object.freeze(['auth', 'status', '--json']);
export const PREFLIGHT_TIMEOUT_MS = 30_000;
const DETAIL_CHARS = 200;

/** @returns {object | null} the first JSON object in the output: the whole text, else one line of it */
function statusOf(stdout) {
  const tries = [stdout, ...stdout.split('\n')].map((text) => text.trim()).filter((text) => text.startsWith('{'));
  for (const text of tries) {
    try {
      const value = JSON.parse(text);
      if (value !== null && typeof value === 'object') return value;
    } catch { /* not this part: try the next */ }
  }
  return null;
}

/**
 * @param {{cwd: string, env: object, timeoutMs?: number}} spec where it runs and the child env (childEnv, the temp HOME)
 * @returns {{loggedIn: boolean, detail: string}} loggedIn only when the JSON says `"loggedIn": true`
 */
export function loginPreflight({ cwd, env, timeoutMs = PREFLIGHT_TIMEOUT_MS }) {
  const out = runQuick('claude', [...PREFLIGHT_ARGS], { cwd, env, timeoutMs, input: '' });
  const status = statusOf(out.stdout);
  const detail = status ? `loggedIn ${JSON.stringify(status.loggedIn ?? null)}` : `exit ${out.code ?? 'none'}, no JSON: ${`${out.stdout} ${out.stderr}`.trim().slice(0, DETAIL_CHARS)}`;
  return { loggedIn: status?.loggedIn === true, detail };
}

/**
 * @param {{result: object | null, stderrTail?: string}} session one claude run (claude-run.mjs)
 * @returns {string | null} the refusal text when the run ended without a good result for a login reason, else null
 */
export function loginRefusal(session) {
  const { result } = session;
  if (result !== null && result !== undefined && result.is_error !== true) return null;
  const text = [result?.result, session.stderrTail].filter(Boolean).map(String).join(' ').trim();
  return callErrorClass(text) === 'auth' ? text.slice(0, DETAIL_CHARS) : null;
}
