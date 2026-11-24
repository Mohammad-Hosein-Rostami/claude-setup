// Helpers for the outward-deploy tests (plans M2 and M2b): an isolated hook environment, a fake dialog tool first on PATH, the record
// of running main agents written by hand under a temp HOME, and the guard and Artifact hooks run as processes.
// Why its own env: the hooks read CLAUDE_GUARD_ASK, CLAUDE_* of the session, SSH_* and CI, so a spread of the test's own environment
// would let the session that runs the tests change their answers. Only the OS names below are copied; everything else is set here.
// Exports: PROJECT, SESSION, MAX_AGENT, REAL_TIMEOUT, isolatedEnv, fakeDialog, shownText, writeRecord, pendingMax, runningMax, stoppedMax,
// runGuard, runArtifact, hookAnswer. No test opens a real dialog: every hook process gets a fake on PATH, or no GUI.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dialogExecutable } from '../home/hooks/lib/timed-ask.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { warmExec } from './warm-exec.mjs';

const GUARD = fileURLToPath(new URL('../home/hooks/pre-bash-guard.mjs', import.meta.url));
const ARTIFACT = fileURLToPath(new URL('../home/hooks/artifact-ask.mjs', import.meta.url));
export const PROJECT = resolve('/work/proj');
export const SESSION = 'session-12345678';
export const MAX_AGENT = 'agentmax0001';
// A real (short) timeout for hook processes: 1 s timeout, the fake dialog answers "timeout" after 1.2 s (as in timed-ask.test.mjs).
export const REAL_TIMEOUT = { CLAUDE_ASK_TIMEOUT_S: '1', FAKE_DIALOG_DELAY_MS: '1200' };
const OS_NAMES = ['PATH', 'SystemRoot', 'PATHEXT', 'ComSpec', 'windir']; // what a child process needs to start on each OS
const HOOK_TIMEOUT_MS = 30_000;

const FAKE_SCRIPT = `
const { writeFileSync } = require('node:fs');
const result = process.env.FAKE_DIALOG_RESULT;
writeFileSync(process.env.FAKE_DIALOG_OUT, JSON.stringify({ args: process.argv.slice(2), text: process.env.CLAUDE_ASK_DIALOG_TEXT }));
const out = {
  darwin: { allow: 'button returned:Allow, gave up:false', deny: 'button returned:Deny, gave up:false', timeout: 'button returned:, gave up:true' },
  win32: { allow: '6', deny: '7', timeout: '-1' },
  linux: { allow: '', deny: '', timeout: '' },
}[process.platform];
if (process.env.FAKE_DIALOG_DELAY_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_DIALOG_DELAY_MS));
if (result === 'kill') process.kill(process.pid, 'SIGKILL');
if (result === 'fail') { process.stderr.write('dialog tool exploded'); process.exit(3); }
process.stdout.write(out[result]);
process.exit(process.platform === 'linux' ? { allow: 0, deny: 1, timeout: 5 }[result] : 0);
`;

/**
 * An environment built from nothing: temp HOME, USERPROFILE and TMPDIR, a temp guard log, the OS names a child needs, then `extra`.
 * No CLAUDE_*, SSH_*, CI or NODE_TEST_CONTEXT unless `extra` sets them.
 * @param {Record<string, string>} extra more variables
 * @returns {Record<string, string>}
 */
export function isolatedEnv(extra = {}) {
  const home = makeTempDir('od-home-');
  const temp = makeTempDir('od-tmp-');
  const env = { HOME: home, USERPROFILE: home, TMPDIR: temp, TEMP: temp, TMP: temp, CLAUDE_GUARD_LOG: join(makeTempDir('od-log-'), 'guard.jsonl') };
  for (const name of OS_NAMES) if (process.env[name] !== undefined) env[name] = process.env[name];
  return { ...env, ...extra };
}

/**
 * A fake dialog tool first on PATH and the isolated env that makes the hooks use it.
 * @param {'allow' | 'deny' | 'timeout' | 'fail' | 'kill'} result what the fake dialog answers
 * @param {Record<string, string>} extra more variables
 * @returns {{env: Record<string, string>, opened: () => boolean, shown: () => {args: string[], text?: string}, log: () => object[]}}
 */
export function fakeDialog(result, extra = {}) {
  const dir = makeTempDir('od-dialog-');
  const script = join(dir, 'fake.cjs');
  writeFileSync(script, FAKE_SCRIPT);
  const bin = join(dir, dialogExecutable(process.platform) + (process.platform === 'win32' ? '.cmd' : ''));
  writeFileSync(bin, process.platform === 'win32' ? `@"${process.execPath}" "${script}" %*\r\n` : `#!/bin/sh\n[ -n "$FAKE_WARM" ] && exit 0\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(bin, 0o755);
  if (process.platform !== 'win32') warmExec(bin);
  const out = join(dir, 'asked.json');
  const env = isolatedEnv({ DISPLAY: ':0', FAKE_DIALOG_RESULT: result, FAKE_DIALOG_OUT: out, ...extra });
  env.PATH = `${dir}${delimiter}${process.env.PATH}`;
  const opened = () => {
    try {
      readFileSync(out);
      return true;
    } catch {
      return false;
    }
  };
  return {
    env,
    opened,
    shown: () => JSON.parse(readFileSync(out, 'utf8')),
    log: () => readFileSync(env.CLAUDE_GUARD_LOG, 'utf8').trim().split('\n').map((line) => JSON.parse(line)),
  };
}

/** The text the fake dialog was given (its arguments and the text variable), to look for the click-only line. */
export const shownText = (dialog) => {
  const { args, text } = dialog.shown();
  return [...args, text ?? ''].join('\n');
};

/** Writes `<HOME>/.claude/state/main-agents/<session>.json` as the cap's store does: a private folder and a private file. */
export function writeRecord(home, session, record) {
  const dir = join(home, '.claude', 'state', 'main-agents');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${session}.json`);
  writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
  return file;
}

/** A record with one max launched at `at` and not yet started (no agent id): it counts for PENDING_MS. */
export const pendingMax = (at) => ({ launches: [{ key: 'launch-max-1', type: 'max', at }], stopped: [] });
/** A record with one started max (its agent id is known) launched at `at`. */
export const runningMax = (at, type = 'max') => ({ launches: [{ key: 'launch-max-1', type, at, agent: MAX_AGENT }], stopped: [] });
/** The record after that max stopped: the store removes the launch and keeps the id (lib/main-agents-store.mjs). */
export const stoppedMax = () => ({ launches: [], stopped: [MAX_AGENT], stoppedTypes: { [MAX_AGENT]: 'max' } });

const runHook = (hook, input, env) => spawnSync(process.execPath, [hook], {
  input: JSON.stringify(input),
  encoding: 'utf8',
  env: { ...env, CLAUDE_PROJECT_DIR: PROJECT },
  timeout: HOOK_TIMEOUT_MS,
});

/**
 * Runs the Bash guard on one command.
 * @param {string} command the Bash command
 * @param {Record<string, string>} env the hook env (isolatedEnv or fakeDialog().env)
 * @param {{agent_type?: string, agent_id?: string, session_id?: string}} who the hook input's caller fields
 */
export const runGuard = (command, env, who = {}) => runHook(GUARD, { cwd: PROJECT, session_id: SESSION, tool_name: 'Bash', ...who, tool_input: { command } }, env);

/** Runs the Artifact hook on one tool input (a publish unless the input says otherwise). */
export const runArtifact = (toolInput, env, who = {}) => runHook(ARTIFACT, { cwd: PROJECT, session_id: SESSION, tool_name: 'Artifact', ...who, tool_input: toolInput }, env);

/**
 * The hook's answer: 'allow' for empty stdout, else the permissionDecision with its reason.
 * @returns {{decision: 'allow' | 'deny' | 'ask', reason: string}}
 */
export function hookAnswer(result) {
  if (result.status !== 0) throw new Error(`hook exited ${result.status}: ${result.stderr}`);
  if (result.stdout.trim() === '') return { decision: 'allow', reason: '' };
  const out = JSON.parse(result.stdout).hookSpecificOutput;
  return { decision: out.permissionDecision, reason: out.permissionDecisionReason };
}
