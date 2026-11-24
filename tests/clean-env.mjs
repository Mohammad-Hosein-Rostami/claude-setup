// The one environment every spawned hook, tool or script gets in a test. Exports: OUR_SWITCH, QUIET_TOOLS, QUIET_TOOLS_LOG_ENV,
// quietToolsDir(), cleanEnv(extra).
// Why: a test run from a Claude Code session inherits the owner's switches (CLAUDE_GUARD_ASK=allow, CLAUDE_GUARD_TRIM,
// CLAUDE_POST_EDIT_TRUST_FORMAT, CLAUDE_PERMISSION_TIMEOUT_S, ...) and the session's own markers (CLAUDE_CODE_SESSION_ID,
// CLAUDECODE, ...); a child that reads them answers differently there than in a plain terminal (allow where a test expects ask).
// A test that needs one passes it in `extra`. tests/hook-env.mjs builds hookEnv on it; tests/pin-home.mjs drops the same names from
// the test process itself, for modules a test imports.
// Quiet tools: a long-run driver or CLI that a test runs as a child shows a real desktop note (long-run lib/notify.mjs spawns
// osascript / notify-send / powershell.exe, and the product has no off-switch), and a dialog tool would show a real dialog. On
// POSIX this module puts inert stand-ins of those tools first on process.env.PATH when it loads, so every PATH a test builds from
// process.env.PATH (and cleanEnv's) finds them before the real ones, after a test's own fakes (e.g. tests/fake-dialog-tool.mjs).
// Invariants: process.env changes only in PATH, once, at load; `extra` wins over everything; the quiet-tools folder is this
// user's own (owner-only, no symlink) or this module throws.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { TEST_TEMP_PREFIX, testTempRoot } from './temp-dir-helpers.mjs';

/** A name the setup or Claude Code reads as a switch or a session marker: every `CLAUDE_*` and `CLAUDECODE`. */
export const OUR_SWITCH = /^CLAUDE(?:_|CODE$)/;

/**
 * Each tool and its exit code. osascript and PowerShell exit 0 with no output: a note counts as shown, a dialog reads as
 * "unavailable" (lib/timed-ask.mjs parseDialogResult), so the hook falls back to the native ask. zenity reads its exit code
 * (0 allow, 1 deny, 5 timeout), so it exits 2, which is "unavailable" too.
 */
export const QUIET_TOOLS = { osascript: 0, 'notify-send': 0, powershell: 0, 'powershell.exe': 0, zenity: 2 };
/** When set (a test's own file), each quiet tool appends `<tool> <args>` there, so a test can see it was reached. */
export const QUIET_TOOLS_LOG_ENV = 'CS_TEST_QUIET_TOOLS_LOG';
const OWNER_ONLY = 0o700;
const RUNNABLE = 0o755;
const WRITABLE_BY_OTHERS = 0o022;

const quietTool = (code) => `#!/bin/sh
# Inert stand-in from tests/clean-env.mjs: a test must never show a real desktop note or dialog.
if [ -n "$${QUIET_TOOLS_LOG_ENV}" ]; then printf '%s\\n' "$(basename "$0") $*" >> "$${QUIET_TOOLS_LOG_ENV}"; fi
exit ${code}
`;

/**
 * The quiet tools' folder, made or refreshed. It is one folder per user that is never removed: a detached long-run driver can
 * notify after its test process ended (it writes `done` before its note), and a removed folder would let it reach the real tool.
 * @returns {string | null} the folder, or null on Windows (a script cannot stand in for powershell.exe there)
 */
export function quietToolsDir() {
  if (process.platform === 'win32') return null;
  const dir = join(testTempRoot(), `${TEST_TEMP_PREFIX}quiet-tools-${process.getuid()}`);
  mkdirSync(dir, { recursive: true, mode: OWNER_ONLY });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & WRITABLE_BY_OTHERS) !== 0) {
    throw new Error(`clean-env: ${dir} is not this user's own folder; remove it and rerun`);
  }
  for (const [name, code] of Object.entries(QUIET_TOOLS)) {
    const file = join(dir, name);
    const body = quietTool(code);
    if (existsSync(file) && readFileSync(file, 'utf8') === body) continue;
    const temp = `${file}.${process.pid}.tmp`; // a rename is atomic, so a parallel test file never runs a half-written tool
    writeFileSync(temp, body);
    chmodSync(temp, RUNNABLE);
    renameSync(temp, file);
  }
  return dir;
}

const QUIET_DIR = quietToolsDir();
if (QUIET_DIR !== null && !(process.env.PATH ?? '').split(delimiter).includes(QUIET_DIR)) {
  process.env.PATH = [QUIET_DIR, process.env.PATH].filter(Boolean).join(delimiter);
}

/**
 * @param {Record<string, string | undefined>} extra variables added on top (they win, `CLAUDE_*` and PATH too)
 * @returns {Record<string, string | undefined>} a copy of process.env without OUR_SWITCH names, then `extra`
 */
export function cleanEnv(extra = {}) {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !OUR_SWITCH.test(name))), ...extra };
}
