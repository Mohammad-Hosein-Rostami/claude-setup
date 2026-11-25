// The environment of every child the e2e harness starts (`claude`, git, land, suite, long-run). Exports: REMOVED_ENV,
// SCENARIO_MAY_SET, BG_WAIT_CEILING_MS, childEnv({home, tmp, path, quietLog, longRunState, extra}).
// Why: a child must run on the logged-in subscription (keychain), never on an API key (an `ANTHROPIC_API_KEY` in the env is
// always used and billed as API, plan section 5), and never with a switch of the session that started the runner (cleanEnv drops
// every CLAUDE_* and CLAUDECODE). A scenario adds only what it tests (E5's CLAUDE_GUARD_ASK=allow, E4's model remap).
// Invariants: every billing variable is removed after the scenario's own names are added, except one alias-target variable a
// scenario sets on purpose (E4's second session); a scenario can never set an API key, an auth token or a base URL (throws);
// the GUI markers that make the guard skip its dialog (SSH_*, CI, NODE_TEST_CONTEXT) are removed, so the scripted dialog is
// reached (plan section 6: never CI=1); CLAUDE_CONFIG_DIR is never set (it changes the keychain service name).
import { BILLING_ENV } from '../../../home/tools/account/lib/claude-child.mjs';
import { cleanEnv, QUIET_TOOLS_LOG_ENV } from '../../clean-env.mjs';

/** Removed from every child: the names the plan lists, then every name BILLING_ENV matches (all ANTHROPIC_*, Bedrock, Vertex). */
export const REMOVED_ENV = Object.freeze(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL']);
const ALIAS_TARGET = /^ANTHROPIC_DEFAULT_(?:(?:OPUS|SONNET|HAIKU)_)?MODEL$/; // every ANTHROPIC_DEFAULT_*_MODEL: removed unless set below
const NO_GUI_MARKERS = ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'CI', 'NODE_TEST_CONTEXT'];
/** The only billing-shaped names a scenario may add: one alias target, to prove the guard denies the remap (E4). */
export const SCENARIO_MAY_SET = ALIAS_TARGET;
/** Background subagents of a `-p` run are waited for this long (plan U3; E0d proves the name and the effect). */
export const BG_WAIT_CEILING_MS = 2 * 60 * 60 * 1000;
const BG_WAIT_ENV = 'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS';
const CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

/**
 * @param {{home: string, tmp: string, path: string, quietLog: string, longRunState: string, extra?: Record<string, string>}} spec
 *   the child's HOME and TMPDIR, its PATH (shims first), the quiet tools' log, long-run's state folder, the scenario's own names
 * @returns {Record<string, string>} the environment
 * @throws {Error} when `extra` names a billing variable other than an alias target, or CLAUDE_CONFIG_DIR
 */
export function childEnv({ home, tmp, path, quietLog, longRunState, extra = {} }) {
  for (const name of Object.keys(extra)) {
    if ((BILLING_ENV.test(name) && !SCENARIO_MAY_SET.test(name)) || name === CONFIG_DIR_ENV) {
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
  return Object.fromEntries(Object.entries({ ...env, ...extra }).filter(([, value]) => value !== undefined));
}
