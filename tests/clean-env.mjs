// The one environment every spawned hook, tool or script gets in a test. Exports: OUR_SWITCH, QUIET_TOOLS, QUIET_TOOLS_LOG_ENV,
// quietToolsDir(), cleanEnv(extra).
// Why: a test run from a Claude Code session inherits the owner's switches (CLAUDE_POST_EDIT_TRUST_FORMAT, ...) and the
// session's own markers (CLAUDE_CODE_SESSION_ID, CLAUDECODE, ...); a child that reads them answers differently there than in a
// plain terminal.
// A test that needs one passes it in `extra`. cleanEnv adds one switch back after the strip: CLAUDE_LONG_RUN_DESKTOP_NOTES=off,
// so a long-run child shows no desktop note on any platform (Windows has no stand-in for powershell.exe). tests/hook-env.mjs
// builds hookEnv on it; tests/pin-home.mjs drops the same names from the test process itself, for modules a test imports.
// Quiet tools: a long-run child run without the switch above (a test that removes it on purpose) would show a real desktop note
// (osascript / notify-send / powershell.exe). On POSIX this module puts inert stand-ins of those tools first on process.env.PATH
// when it loads, so every PATH a test builds from process.env.PATH (and cleanEnv's) finds them before the real ones, after a
// test's own fakes.
// Invariants: process.env changes only in PATH, once, at load; `extra` wins over everything; the quiet-tools folder is this
// user's own (owner-only, no symlink) or this module throws.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { DESKTOP_NOTES_SWITCH } from '../home/tools/long-run/lib/notify.mjs';
import { TEST_TEMP_PREFIX, testTempRoot } from './temp-dir-helpers.mjs';

/** A name the setup or Claude Code reads as a switch or a session marker: every `CLAUDE_*` and `CLAUDECODE`. */
export const OUR_SWITCH = /^CLAUDE(?:_|CODE$)/;

/**
 * Each tool and its exit code. osascript, notify-send and PowerShell exit 0 with no output: a note counts as shown. zenity exits 2
 * (an error), so a caller that reads its exit code as an answer takes it as "unavailable".
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
 * The quiet tools' folder, made or refreshed. It is one fixed folder per user that no test removes: parallel test files share it,
 * and a detached child can still run a tool after its test process ended, so removing it at exit could let one reach the real
 * tool. It holds a few small scripts, so it is safe to leave: each load sets its time to now, so disk-clean's test-temp rule
 * (cs-test-* idle 1 day) removes it only after a day with no test run, never during one.
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
  const now = new Date();
  utimesSync(dir, now, now);
  return dir;
}

const QUIET_DIR = quietToolsDir();
if (QUIET_DIR !== null && !(process.env.PATH ?? '').split(delimiter).includes(QUIET_DIR)) {
  process.env.PATH = [QUIET_DIR, process.env.PATH].filter(Boolean).join(delimiter);
}

/**
 * @param {Record<string, string | undefined>} extra variables added on top (they win, `CLAUDE_*` and PATH too)
 * @returns {Record<string, string | undefined>} a copy of process.env without OUR_SWITCH names, then desktop notes off, then `extra`
 *   (pass `{ [DESKTOP_NOTES_SWITCH]: undefined }` to let a long-run child notify again)
 */
export function cleanEnv(extra = {}) {
  const withoutSwitches = Object.fromEntries(Object.entries(process.env).filter(([name]) => !OUR_SWITCH.test(name)));
  return { ...withoutSwitches, [DESKTOP_NOTES_SWITCH]: 'off', ...extra };
}
