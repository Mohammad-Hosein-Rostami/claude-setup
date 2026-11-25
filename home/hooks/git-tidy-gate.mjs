// SessionStart only (plan 2026-11-24: "git-tidy check at session start only"): names the lanes of the session's repo that are not
// yet landed (lib/tidy-gate-notes.mjs unlandedText), so a new or resumed session sees leftover work at once. It never blocks;
// `land` (home/tools/land) lands a lane.
// Exports: contextFor(input, env, deps) -> Promise<string> (the SessionStart additionalContext, '' for none).
//   deps (tests): runCheck(top, timeoutMs, env), checkTimeoutMs, now (ms, for the cache age).
//   Env: GIT_TIDY_GATE_CHECK_TIMEOUT_MS overrides CHECK_TIMEOUT_MS (a loaded machine, the test suite).
// Invariants:
// - The folder looked at is the session's own worktree (lib/gated-folder.mjs). The check runs as a child of
//   `git-tidy.mjs check --json` with core.fsmonitor and log.showSignature off and bare repositories off, and never in a repo where any
//   worktree's own config view names a filter (`git status` there would run it): there only a cached verdict is read.
// - State: ~/.claude/state/git-tidy-gate/<session>.json holds the check verdict per (repo, fingerprint). The fingerprint is a hash of
//   all refs and the worktree list, so a repo unchanged for under 10 minutes is a cache hit: two git calls and no child.
//   A miss runs the child with a CHECK_TIMEOUT_MS bound; on a timeout nothing is said and one detached refresh fills the cache.
// - Input that is not JSON says nothing (exit 0, empty stderr); any internal error is one stderr line and exit 0: a session is never trapped.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gatedFolder, gitOut, namesFilterProgram, worktreeOf } from './lib/gated-folder.mjs';
import { isSessionId } from './lib/session-store.mjs';
import { cachedVerdict, storeVerdict } from './lib/tidy-gate-store.mjs';
import { unlandedText } from './lib/tidy-gate-notes.mjs';
import { runCheckChild } from './lib/tidy-check-child.mjs';

const CHECK_TIMEOUT_MS = 4000; // a SessionStart hook must answer fast; a slower check is finished by the detached refresh
const REFRESH_TIMEOUT_MS = 60_000;
const EVENT = 'SessionStart';
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** A hash of every ref and the worktree list: equal while nothing a check looks at changed; null when git cannot be read. */
function fingerprintOf(top) {
  const refs = gitOut(top, ['for-each-ref', '--format=%(objectname) %(refname)']);
  const trees = gitOut(top, ['worktree', 'list', '--porcelain']);
  return refs === null || trees === null ? null : sha256(`${refs}\0${trees}`);
}

/** One detached run of this file that checks `top` without a time bound worth waiting for and stores the verdict. */
function startRefresh(top, session, env) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--refresh', top, session], { detached: true, stdio: 'ignore', env, windowsHide: true });
  child.on('error', (error) => process.stderr.write(`git-tidy-gate: cannot start the refresh: ${error.message}\n`));
  child.unref();
}

/** True when the config view of the worktree `top`, or of any worktree of its repository, defines a filter (each worktree has its own view). */
function anyWorktreeNamesFilter(top) {
  const listed = gitOut(top, ['worktree', 'list', '--porcelain']);
  if (listed === null) return true;
  const folders = listed.split('\n\n').filter((block) => !block.split('\n').includes('bare'))
    .map((block) => block.split('\n')[0].replace(/^worktree /, '')).filter((folder) => existsSync(folder));
  return [top, ...folders].some(namesFilterProgram);
}

const checkBudgetMs = (env, deps) => deps.checkTimeoutMs ?? (Number(env.GIT_TIDY_GATE_CHECK_TIMEOUT_MS) || CHECK_TIMEOUT_MS);

/** The check verdict of `top` for this repo state: from the cache, else from a child run bound by `timeoutMs`; null when there is none (error, timeout). */
function verdictFor(env, session, top, deps, timeoutMs) {
  const fingerprint = fingerprintOf(top);
  if (fingerprint === null) return null;
  const repoState = { top, fingerprint };
  const cached = cachedVerdict(env, session, repoState, deps.now ?? Date.now());
  if (cached !== undefined) return cached;
  if (anyWorktreeNamesFilter(top)) return null; // only the child's `git status` could run a filter, so a cache hit never needs this call
  const run = deps.runCheck ?? runCheckChild;
  const fresh = run(top, timeoutMs, env);
  if (fresh === 'timeout') {
    startRefresh(top, session, env);
    return null;
  }
  if (fresh === undefined) return null;
  storeVerdict(env, session, repoState, fresh);
  return fresh;
}

/**
 * The SessionStart additionalContext: the unlanded lanes of the session's repo, '' when there are none or the gate does not apply.
 * @param {object} input the hook JSON (session_id, cwd, agent_id?)
 * @param {Record<string, string | undefined>} [env] HOME (the state folder), CLAUDE_PROJECT_DIR and the environment the check child gets
 * @param {object} [deps] see the header
 * @returns {Promise<string>}
 */
export async function contextFor(input, env = process.env, deps = {}) {
  if (input === null || typeof input !== 'object' || !isSessionId(input.session_id)) return '';
  const folder = gatedFolder(input, env);
  const tree = folder === null ? null : worktreeOf(folder);
  if (tree === null) return '';
  return unlandedText(tree.top, verdictFor(env, input.session_id, tree.top, deps, checkBudgetMs(env, deps)));
}

/** The detached job: check `top` for as long as it takes and store the verdict for the next session start. */
function refresh(top, session, env) {
  const fingerprint = fingerprintOf(top);
  const verdict = fingerprint === null || !isSessionId(session) || anyWorktreeNamesFilter(top) ? undefined : runCheckChild(top, REFRESH_TIMEOUT_MS, env);
  if (verdict !== undefined && verdict !== 'timeout') storeVerdict(env, session, { top, fingerprint }, verdict);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  if (process.argv[2] === '--refresh') {
    refresh(process.argv[3], process.argv[4], process.env);
    return;
  }
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return; // not hook JSON: nothing to check, and nothing to say (a gate that is not a gate stays silent)
  }
  if (input?.hook_event_name !== EVENT) return;
  const context = await contextFor(input);
  // A top-level additionalContext is dropped (hooks docs, #96193): it goes inside hookSpecificOutput.
  if (context !== '') process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: EVENT, additionalContext: context } })}\n`);
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`git-tidy-gate: ${error.message}\n`); // never trap a session
  }
}
