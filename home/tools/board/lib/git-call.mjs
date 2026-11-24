// One git call of the board's refresh: fixed safety flags, a clean environment, a time limit per call and one git budget per
// refresh; a call that gives no output says why (timed out, exit code), so the facts it was for show `unknown`, never null (P3).
// Exports: gitIn(common, args) -> { text, why }; gitBudgetSpent(startMs); GIT_SAFETY; BUDGET_USED.
// Used by git-state.mjs and repo-stats.mjs (and GIT_SAFETY by disk-free's clean-scan.mjs, through git-state.mjs).
// Invariants: never throws; never inherits a GIT_* variable; GIT_COMMON_DIR is always the verified shared git folder.
import { execFileSync } from 'node:child_process';
import { devNull } from 'node:os';

const GIT_TIMEOUT_MS = 250;
const GIT_BUDGET_MS = 250;
/** Why facts are missing when the refresh's git budget ran out before their call. */
export const BUDGET_USED = `git budget of ${GIT_BUDGET_MS} ms for this refresh used up`;
/**
 * Before every git call, on the command line so it beats the repository's own config: no fsmonitor hook, no hook from the
 * repository's hooks path, no signature program, no repository found by discovery inside a folder unless named (review SEC-7).
 */
export const GIT_SAFETY = ['-c', 'core.fsmonitor=false', '-c', 'safe.bareRepository=explicit', '-c', `core.hooksPath=${devNull}`,
  '-c', 'log.showSignature=false'];

/** @returns {boolean} whether more than GIT_BUDGET_MS passed since `startMs` (the refresh's git start): asked before every git call */
export const gitBudgetSpent = (startMs) => Date.now() - startMs > GIT_BUDGET_MS;

/** The environment of a board git call: no inherited GIT_* variable (GIT_DIR, GIT_INDEX_FILE, ...), the verified shared folder pinned. */
function gitEnv(common) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  // git reads `commondir` of the git folder it is given and would take config, objects and attributes from wherever that file
  // points; GIT_COMMON_DIR overrides it with the folder trusted-repos.mjs verified (review N-11). No lazy fetch, no optional lock.
  return { ...env, GIT_COMMON_DIR: common, GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' };
}

/** Why a git call gave no output, in words the board file keeps (an unknown fact always says why: principle P3). */
function failureOf(error) {
  if (error?.code === 'ETIMEDOUT') return `timed out after ${GIT_TIMEOUT_MS} ms`;
  if (Number.isInteger(error?.status)) return `failed with exit ${error.status}`;
  return `could not run (${error?.code ?? error?.message ?? 'no error code'})`;
}

/**
 * One git call of the board with fixed flags, on the repository whose shared git folder is `common`.
 * @param {string} common the verified shared git folder (trusted-repos.mjs)
 * @param {string[]} args the arguments after GIT_SAFETY (always with an explicit `--git-dir=`)
 * @returns {{ text: string | null, why: string | null }} stdout and null; or null and why git gave none (timeout, exit code)
 */
export function gitIn(common, args) {
  try {
    const text = execFileSync('git', [...GIT_SAFETY, ...args], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env: gitEnv(common) });
    return { text, why: null };
  } catch (error) {
    return { text: null, why: failureOf(error) };
  }
}
