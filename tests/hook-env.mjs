// Shared environment for tests that spawn a guard hook. Exports: cleanEnv(extra) (from clean-env.mjs), hookEnv(extra), tempLogPath().
// A real timed dialog would block a test for minutes and pop up on the owner's screen, so every spawned hook gets an ssh
// marker (no GUI: the hook falls back to the native "ask") and a private decision log and a pinned HOME instead of ~/.claude/logs/guard.jsonl.
// Tests that want the dialog path put a fake dialog tool on PATH and use dialogEnv() from timed-ask.test.mjs instead.
import { join } from 'node:path';
import { cleanEnv } from './clean-env.mjs';
import { PINNED_HOME } from './pin-home.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

export { cleanEnv };

/** @returns {string} a fresh decision-log path in a new temp directory */
export const tempLogPath = () => join(makeTempDir('guard-log-'), 'guard.jsonl');

/**
 * @param {Record<string, string>} extra variables added on top (they win)
 * @returns {Record<string, string | undefined>} cleanEnv (none of the session's CLAUDE_* switches) with no GUI and a private decision log
 */
export function hookEnv(extra = {}) {
  return cleanEnv({ HOME: PINNED_HOME, USERPROFILE: PINNED_HOME, SSH_CONNECTION: 'test', CLAUDE_GUARD_LOG: tempLogPath(), ...extra });
}
