// Purpose: run the one command of a land-lane step: git or a sibling tool, as a subprocess with no shell, a timeout and a clean git environment.
// Exports: git, tool, firstLine, parseJson, TOOLS_DIR.
// Invariants: every argument is an argv entry (never joined into a shell line). A command that cannot start or times out has `status` null and
//   `ok` false, so a caller never reads a missing exit code as success (P3). GIT_* variables of the caller are dropped (a hook's GIT_DIR must not
//   point a child at another repository); everything else, HOME and the session id included, is passed on so the tools see the caller's session.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GIT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 64 << 20;

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));

function run(command, args, { cwd, timeoutMs, stdio }) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, env: cleanEnv(), shell: false, stdio });
  const status = result.error === undefined ? result.status : null;
  const stderr = result.error === undefined ? (result.stderr ?? '') : `${result.error.message}\n${result.stderr ?? ''}`;
  return { ok: status === 0, status, out: (result.stdout ?? '').trim(), err: stderr.trim() };
}

/** Runs `git <args>` in `cwd`; `{ ok, status, out, err }` with status null when git could not run. */
export const git = (cwd, args, timeoutMs = GIT_TIMEOUT_MS) => run('git', args, { cwd, timeoutMs, stdio: 'pipe' });

/**
 * Runs `node <tools folder>/<name>/<script> <args>`.
 * @param {string} name the tool's folder, e.g. `git-tidy`
 * @param {string} script the file in it, e.g. `git-tidy.mjs`
 * @param {string[]} args its arguments
 * @param {{ cwd?: string, timeoutMs: number, stdio?: any }} options `stdio` defaults to pipe (an array may send output to a log file)
 */
export const tool = (name, script, args, { cwd, timeoutMs, stdio = 'pipe' }) => run(process.execPath, [join(TOOLS_DIR, name, script), ...args], { cwd, timeoutMs, stdio });

/** The object in `text` (a tool's `--json` output), or null when it is not JSON or not an object. */
export function parseJson(text) {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/** The first non-empty line of a result's output (stdout, else stderr), for a one-line reason. */
export const firstLine = (result) => (result.out || result.err).split('\n').find((line) => line.trim() !== '') ?? `exit ${result.status}`;
