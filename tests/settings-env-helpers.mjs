// Shared setup for the tests of the no-Fable gate reading the settings files' `env` (home/hooks/agent-model-guard.mjs with
// lib/settings-env.mjs): a private home with the shipped agent files, a project folder, settings files written into them, a linked git
// worktree, and one Agent call through the spawned hook. It never imports lib/settings-env.mjs, so a test file built on it runs on
// sources that lack that lib too. Exports: the names and values below, guardSetup, userFile, sharedFile, localFile, writeSettings,
// linkedWorktree, runHook, devCall, helperCall, denyReason, assertRuns.
// Invariant: every folder is a fresh temp folder; the runner's own model, force, config and project variables never reach the hook.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { devNull } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentHomeEnv } from './agent-home-helpers.mjs';
import { cleanEnv } from './clean-env.mjs';
import { hookEnv } from './hook-env.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const GUARD = fileURLToPath(new URL('../home/hooks/agent-model-guard.mjs', import.meta.url));
const HOOK_TIMEOUT_MS = 5000; // settings/base.json gives the hook 5 s
// The documented names (lib/settings-env.mjs header), written out so a renamed file fails here.
const CONFIG_FOLDER = '.claude';
const SETTINGS_FILE = 'settings.json';
const LOCAL_SETTINGS_FILE = 'settings.local.json';
export const FORCE = 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE';
export const SUBAGENT_MODEL = 'CLAUDE_CODE_SUBAGENT_MODEL';
export const ALIAS_TARGET_VARS = ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_MODEL'];
export const OPUS_VAR = ALIAS_TARGET_VARS[0];
export const FABLE_ID = 'claude-fable-1';
export const NON_FABLE_ID = 'claude-opus-5-5';
export const SHIPPED_SUBAGENT_MODEL = 'claude-sonnet-5-5'; // settings/base.json's CLAUDE_CODE_SUBAGENT_MODEL
export const FABLE_RULE = 'Not started: Fable is never used for an agent (the owner chooses it by hand only)';
export const FORCED_NOTE = `${FORCE} is on`;
export const FIX_THE_FILE = 'fix the file, then launch again';
const CLEARED_VARS = [FORCE, ...ALIAS_TARGET_VARS, 'CLAUDE_PROJECT_DIR', 'CLAUDE_CONFIG_DIR']; // the runner's own never leak in
let counter = 0;

/**
 * A private home with the shipped agent files (CLAUDE_CONFIG_DIR is its `.claude`, so the user settings file is there too) and an
 * empty project folder that is CLAUDE_PROJECT_DIR and the call's cwd. `vars` sets or (undefined) removes hook env variables last.
 * @returns {{home: string, project: string, env: Record<string, string | undefined>}}
 */
export function guardSetup(vars = {}) {
  const home = makeTempDir('settings-env-home-');
  const project = makeTempDir('settings-env-proj-');
  const env = hookEnv({ HOME: home, USERPROFILE: home });
  for (const name of CLEARED_VARS) delete env[name];
  Object.assign(env, agentHomeEnv(home), { CLAUDE_PROJECT_DIR: project });
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return { home, project, env };
}

/** @returns {string} the user settings file of a setup */
export const userFile = (setup) => join(setup.env.CLAUDE_CONFIG_DIR, SETTINGS_FILE);
/** @returns {string} the shared project settings file of a folder */
export const sharedFile = (folder) => join(folder, CONFIG_FOLDER, SETTINGS_FILE);
/** @returns {string} the local project settings file of a folder */
export const localFile = (folder) => join(folder, CONFIG_FOLDER, LOCAL_SETTINGS_FILE);

/** Writes `content` to `file` (an object as JSON, a string as it is), making its folder. */
export function writeSettings(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
}

/**
 * A git repository with one commit and a linked worktree of it, made by git itself (no user or system git config is read).
 * @returns {{main: string, worktree: string}} the main checkout and the linked worktree
 */
export function linkedWorktree() {
  const root = makeTempDir('settings-env-git-');
  const main = join(root, 'main');
  const worktree = join(root, 'linked');
  const env = cleanEnv({ HOME: root, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' });
  const git = (args, cwd) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, env, stdio: 'pipe' });
  mkdirSync(main);
  git(['init', '-q'], main);
  git(['commit', '-q', '--allow-empty', '-m', 'start'], main);
  git(['worktree', 'add', '-q', '-b', 'linked', worktree], main);
  return { main, worktree };
}

/**
 * Runs one hook call (a fresh session each time, so no cap or deny-once record carries over); null when the hook printed nothing.
 * @param {{project: string, env: object}} setup from guardSetup
 * @param {object} toolInput the call's tool_input
 * @param {object} extra hook input fields over the defaults (cwd: the project; tool_name: Agent); an undefined value drops the field
 */
export function runHook(setup, toolInput, extra = {}) {
  const input = { hook_event_name: 'PreToolUse', session_id: `settings-env-${process.pid}-${counter++}`, cwd: setup.project, tool_name: 'Agent', tool_input: toolInput, ...extra };
  const run = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(input), encoding: 'utf8', env: setup.env, cwd: setup.home, timeout: HOOK_TIMEOUT_MS });
  assert.equal(run.error, undefined, 'the hook finished within its timeout');
  assert.equal(run.status, 0, run.stderr);
  return run.stdout === '' ? null : JSON.parse(run.stdout).hookSpecificOutput;
}

// isolation "worktree" keeps the writer isolation gate out of these tests; dev comes from the boss (no agent_id)
export const devCall = (extra = {}) => ({ subagent_type: 'dev', description: 'job', prompt: 'build it', isolation: 'worktree', ...extra });
// a general-purpose call from inside a dev (agent-call-origin.mjs FROM_AGENT): the type the routing adds `sonnet` to
export const helperCall = { subagent_type: 'general-purpose', description: 'look', prompt: 'find x' };

/** Asserts a no-Fable deny and returns its reason. */
export function denyReason(out, label = '') {
  assert.equal(out?.permissionDecision, 'deny', `${label}: ${JSON.stringify(out)}`);
  assert.ok(out.permissionDecisionReason.startsWith(FABLE_RULE), `${label}: ${out.permissionDecisionReason}`);
  return out.permissionDecisionReason;
}

/** Asserts the call was not denied. */
export function assertRuns(out, label = '') {
  assert.notEqual(out?.permissionDecision, 'deny', `${label}: ${JSON.stringify(out)}`);
}
