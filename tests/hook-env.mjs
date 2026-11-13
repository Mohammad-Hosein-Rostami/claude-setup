// Shared environment for tests that spawn a guard hook. Exports: hookEnv(extra), tempLogPath().
// A real timed dialog would block a test for minutes and pop up on the owner's screen, so every spawned hook gets an ssh
// marker (no GUI: the hook falls back to the native "ask") and a private decision log instead of ~/.claude/logs/guard.jsonl.
// Tests that want the dialog path put a fake dialog tool on PATH and use dialogEnv() from timed-ask.test.mjs instead.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** @returns {string} a fresh decision-log path in a new temp directory */
export const tempLogPath = () => join(mkdtempSync(join(tmpdir(), 'guard-log-')), 'guard.jsonl');

/**
 * @param {Record<string, string>} extra variables added on top (they win)
 * @returns {Record<string, string | undefined>} process env with no GUI and a private decision log
 */
export function hookEnv(extra = {}) {
  return { ...process.env, SSH_CONNECTION: 'test', CLAUDE_GUARD_LOG: tempLogPath(), ...extra };
}
