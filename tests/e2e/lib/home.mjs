// The child HOME of an e2e run: the setup under test, linked in, and copies of the owner's own settings. Exports: LINKED,
// GIT_IDENTITY, homePaths(root, realHome, realHomeMode), settingsCopy(text, realHome, home), claudeMdCopy(text, realSetup,
// setupFrom), buildHome(ops, {root, setupFrom, realHome}).
// Why: a run must use the agents, hooks, rules, skills and tools of the checkout under test (`--setup-from`) with the owner's
// real settings, while writing nothing into the real ~/.claude (its logs, state and session transcripts go to the temp HOME).
// `<root>/home/.claude/` holds links to `<setupFrom>/home/{agents,hooks,rules,skills,standards,tools,statusline.mjs}`, a copy of
// the real `settings.json` and `CLAUDE.md`, and fresh empty logs/, state/ and projects/. CLAUDE_CONFIG_DIR is never used (it
// changes the keychain service name, so the login would not be found).
// The settings copy (plan-change, named in the report): the hook and status line commands name the real `~/.claude/` by its
// absolute path, so they are moved to the temp HOME (else every hook would log into the real HOME); `env.CLAUDE_GUARD_ASK` is
// dropped, so a scenario has the switch only when it sets it (E5c runs "without the switch"); `autoContinueAtUsageLimit` is
// off, so a limit ends the run instead of waiting in it (the runner stops at a limit and never retries). Every billing variable
// of its `env` (BILLING_ENV: every ANTHROPIC_* name, so API keys, auth tokens, base URLs and model remaps; Bedrock, Vertex),
// any other `*_BASE_URL`, CLAUDE_CODE_USE_FOUNDRY and a login token, and the credential helpers (apiKeyHelper, awsAuthRefresh,
// awsCredentialExport) are dropped: Claude Code applies the settings env to the session after childEnv cleaned the process
// env, so a key kept there would bill the API (review round 4, R2). E4's one deliberate remap comes from its child env.
// CLAUDE_CODE_SUBAGENT_MODEL stays: it is the setup's own pin under test, not a remap of an alias.
// Invariants: the real files are only read; a missing one fails with a plain message naming it; every path written is under the
// run root (the ops check that).
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BILLING_ENV } from '../../../home/tools/account/lib/claude-child.mjs';

/** What the temp `~/.claude` links from the checkout under test (plan Lane C brief). */
export const LINKED = Object.freeze(['agents', 'hooks', 'rules', 'skills', 'standards', 'tools', 'statusline.mjs']);
/** A git identity for commits in the temp HOME (no real `~/.gitconfig` is read there). */
export const GIT_IDENTITY = Object.freeze({ name: 'cs-e2e', email: 'cs-e2e@example.invalid' });
const SWITCH = 'CLAUDE_GUARD_ASK';
/** Settings env names the copy drops besides BILLING_ENV: a base URL of any provider, Foundry, a login token. */
const DROPPED_ENV = /^(?:.*_BASE_URL|CLAUDE_CODE_USE_FOUNDRY|CLAUDE_CODE_OAUTH_TOKEN)$/;
/** Settings keys that hand Claude Code a credential (a key helper or a cloud login). */
export const CREDENTIAL_KEYS = Object.freeze(['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport']);

/**
 * @param {string} root the run root
 * @param {string} realHome the owner's HOME
 * @param {boolean} realHomeMode `--real-home`: the children use the real HOME (the owner's opt-in fallback)
 * @returns {{home: string, claudeDir: string, logsDir: string, stateDir: string, projectsDir: string,
 *   longRunState: string, tmp: string}}
 */
export function homePaths(root, realHome, realHomeMode = false) {
  const home = realHomeMode ? realHome : join(root, 'home');
  const claudeDir = join(home, '.claude');
  return {
    home, claudeDir, logsDir: join(claudeDir, 'logs'), stateDir: join(claudeDir, 'state'), projectsDir: join(claudeDir, 'projects'),
    longRunState: join(root, 'long-run-state'), tmp: join(root, 'tmp'),
  };
}

const inJson = (text) => JSON.stringify(text).slice(1, -1);

/**
 * @param {string} text the real settings.json
 * @param {string} realHome the owner's HOME
 * @param {string} home the temp HOME
 * @returns {string} the copy: real `~/.claude` paths moved to the temp one, the guard switch, every billing variable and every
 *   credential helper dropped, auto-continue off
 */
export function settingsCopy(text, realHome, home) {
  const moved = String(text).split(`${inJson(realHome)}/.claude/`).join(`${inJson(home)}/.claude/`)
    .split(`${inJson(realHome)}/.claude"`).join(`${inJson(home)}/.claude"`);
  const settings = JSON.parse(moved);
  if (settings.env && typeof settings.env === 'object') {
    for (const name of Object.keys(settings.env)) if (name === SWITCH || BILLING_ENV.test(name) || DROPPED_ENV.test(name)) delete settings.env[name];
  }
  for (const key of CREDENTIAL_KEYS) delete settings[key];
  settings.autoContinueAtUsageLimit = false;
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/**
 * @param {string} text the real CLAUDE.md (absolute `@` imports of the owner's checkout)
 * @param {string | null} realSetup the checkout the real ~/.claude links to
 * @param {string} setupFrom the checkout under test
 * @returns {string} the copy, whose shared rules (`@<checkout>/home/...`) come from the checkout under test
 */
export function claudeMdCopy(text, realSetup, setupFrom) {
  if (realSetup === null || realSetup === setupFrom) return String(text);
  return String(text).split(`@${realSetup}/home/`).join(`@${setupFrom}/home/`);
}

/** @returns {string | null} the checkout the real `~/.claude/agents` link points into, or null */
function realSetupOf(realHome) {
  try {
    return dirname(dirname(realpathSync(join(realHome, '.claude', 'agents'))));
  } catch {
    return null;
  }
}

/**
 * @param {ReturnType<import('./context.mjs').makeOps>} ops the run's file operations (recorded; skipped in a dry run)
 * @param {{root: string, setupFrom: string, realHome: string}} spec
 * @returns {ReturnType<typeof homePaths>}
 * @throws {Error} when the real settings.json or CLAUDE.md, or a linked part of the checkout, is missing
 */
export function buildHome(ops, { root, setupFrom, realHome }) {
  const paths = homePaths(root, realHome);
  for (const dir of [paths.claudeDir, paths.logsDir, paths.stateDir, paths.projectsDir, paths.longRunState, paths.tmp]) ops.mkdir(dir);
  for (const name of LINKED) ops.symlink(join(setupFrom, 'home', name), join(paths.claudeDir, name), { mustExist: true });
  const realSettings = join(realHome, '.claude', 'settings.json');
  const realClaudeMd = join(realHome, '.claude', 'CLAUDE.md');
  ops.copy(realSettings, join(paths.claudeDir, 'settings.json'), {
    transform: (text) => settingsCopy(text, realHome, paths.home),
    note: `real ~/.claude paths moved to the temp HOME, env.${SWITCH} and every billing variable and credential helper dropped, autoContinueAtUsageLimit off`,
    missing: `e2e: ${realSettings} is missing; run scripts/install.sh first (the run copies the owner's settings)`,
  });
  ops.copy(realClaudeMd, join(paths.claudeDir, 'CLAUDE.md'), {
    transform: (text) => claudeMdCopy(text, realSetupOf(realHome), setupFrom),
    note: 'shared rules imported from the checkout under test',
    missing: `e2e: ${realClaudeMd} is missing; run scripts/install.sh first (the run copies the owner's CLAUDE.md)`,
  });
  ops.write(join(paths.home, '.gitconfig'),
    `[user]\n\tname = ${GIT_IDENTITY.name}\n\temail = ${GIT_IDENTITY.email}\n[init]\n\tdefaultBranch = main\n`);
  return paths;
}
