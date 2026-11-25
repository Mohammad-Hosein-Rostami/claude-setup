// The environment of every child the e2e harness starts (`claude`, git, land, suite, long-run). Exports: REMOVED_ENV, LOGIN_ENV,
// SCENARIO_MAY_SET, BG_WAIT_CEILING_MS, useLogin(token), childEnv({home, tmp, path, quietLog, longRunState, extra}).
// Why: a child must run on the logged-in subscription, never on an API key (an `ANTHROPIC_API_KEY` in the env is
// always used and billed as API, plan section 5), and never with a switch of the session that started the runner (cleanEnv drops
// every CLAUDE_* and CLAUDECODE). A scenario adds only what it tests.
// The login: under the temp HOME a child finds no stored login (the owner's one live E0 run: "Not logged in" in every call), so
// the subscription token of the terminal the runner was started in (`claude-as <account>` sets CLAUDE_CODE_OAUTH_TOKEN) is passed
// on, by that one name: from the runner's own env, else the token the runner read once from the claude-account store
// (stored-login.mjs, handed over by useLogin); never set by a scenario, never in argv or a file, never printed (redact.mjs masks
// its value).
// Invariants: every billing variable is removed after the scenario's own names are added, except one alias-target variable a
// scenario may set on purpose; a scenario can never set an API key, an auth token or a base URL (throws);
// the GUI markers (SSH_*, CI, NODE_TEST_CONTEXT) are removed (plan section 6: never CI=1); CLAUDE_CONFIG_DIR is never set (it changes the keychain service name).
import { BILLING_ENV } from '../../../home/tools/account/lib/claude-child.mjs';
import { cleanEnv, QUIET_TOOLS_LOG_ENV } from '../../clean-env.mjs';
import { registerSecret } from './redact.mjs';

/** Removed from every child: the names the plan lists, then every name BILLING_ENV matches (all ANTHROPIC_*, Bedrock, Vertex). */
export const REMOVED_ENV = Object.freeze(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL']);
const ALIAS_TARGET = /^ANTHROPIC_DEFAULT_(?:(?:OPUS|SONNET|HAIKU)_)?MODEL$/; // every ANTHROPIC_DEFAULT_*_MODEL: removed unless set below
const NO_GUI_MARKERS = ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'CI', 'NODE_TEST_CONTEXT'];
/** The only billing-shaped names a scenario may add: one alias target. */
export const SCENARIO_MAY_SET = ALIAS_TARGET;
/** Background subagents of a `-p` run are waited for this long (plan U3; E0d proves the name and the effect). */
export const BG_WAIT_CEILING_MS = 2 * 60 * 60 * 1000;
const BG_WAIT_ENV = 'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS';
const CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';
/** The subscription login token a child gets from the runner's env (the one CLAUDE_* name passed on). */
export const LOGIN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';

let storedLogin = null;

/**
 * The login token every later child gets (the runner's stored-login read); its value is masked by the redactor from now on.
 * @param {string | null} token null: only the runner's own env, as before
 */
export function useLogin(token) {
  storedLogin = typeof token === 'string' && token !== '' ? token : null;
  registerSecret(storedLogin);
}

/**
 * @param {{home: string, tmp: string, path: string, quietLog: string, longRunState: string, extra?: Record<string, string>}} spec
 *   the child's HOME and TMPDIR, its PATH (shims first), the quiet tools' log, long-run's state folder, the scenario's own names
 * @returns {Record<string, string>} the environment, with LOGIN_ENV from the runner's env, else the useLogin token, when one is set
 * @throws {Error} when `extra` names a billing variable other than an alias target, CLAUDE_CONFIG_DIR or LOGIN_ENV
 */
export function childEnv({ home, tmp, path, quietLog, longRunState, extra = {} }) {
  for (const name of Object.keys(extra)) {
    if ((BILLING_ENV.test(name) && !SCENARIO_MAY_SET.test(name)) || name === CONFIG_DIR_ENV || name === LOGIN_ENV) {
      throw new Error(`e2e: a scenario may not set ${name} (subscription only; the keychain login must stay in use)`);
    }
  }
  const env = cleanEnv({
    HOME: home, USERPROFILE: home, TMPDIR: tmp, PATH: path, [QUIET_TOOLS_LOG_ENV]: quietLog,
    LONG_RUN_STATE_DIR: longRunState, [BG_WAIT_ENV]: String(BG_WAIT_CEILING_MS),
  });
  for (const name of Object.keys(env)) {
    if (REMOVED_ENV.includes(name) || BILLING_ENV.test(name) || NO_GUI_MARKERS.includes(name)) delete env[name];
  }
  delete env[CONFIG_DIR_ENV];
  const token = process.env[LOGIN_ENV] || storedLogin;
  const login = token ? { [LOGIN_ENV]: token } : {};
  return Object.fromEntries(Object.entries({ ...env, ...extra, ...login }).filter(([, value]) => value !== undefined));
}
