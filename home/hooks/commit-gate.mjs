// Stop and SubagentStop: blocks a stop once when the session's or agent's folder is in a git worktree with uncommitted work, so a run
// never ends with edits left lying around (C16). Exports: decide(input, env) -> {block: false} | {block: true, reason}, dirtyCount(status).
// Invariants:
// - Blocks at most once per dirty state: the state is the worktree path plus the hash of `git status --porcelain=v1 -z`, kept in
//   ~/.claude/state/commit-gate/<session>.json (lib/session-store.mjs). The same state stopping again passes; any change to the
//   files is a new state. stop_hook_active true always passes. A state that cannot be stored is not blocked (no loop, ever).
// - Passes without a word: not a git worktree, a bare repo, a branch with no commit yet, a rebase/merge/cherry-pick/revert in
//   progress, and files git ignores (.gitignore, .git/info/exclude: STATUS.md and other work notes).
// - When the dirty worktree has the base branch (main, master, develop) checked out and other worktrees exist, the reason adds that
//   edits belong in a lane worktree, never in the base folder.
// - Any internal error is one stderr line and exit 0: a session is never trapped. Two or three git calls, well under 300 ms.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readSessionFile, withSessionLock, writeSessionFile } from './lib/session-store.mjs';

const BASE_BRANCHES = new Set(['main', 'master', 'develop']);
// files git keeps in the worktree's git folder while an operation waits for the user
const IN_PROGRESS_MARKERS = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];
const STATES_KEPT = 50; // dirty states remembered per session; older ones may block once more, which is harmless
const MAX_STORE_BYTES = 16 * 1024;
const REPOSITORY_VARIABLES = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'];
const RENAME_OR_COPY = /^[RC]|^.[RC]/; // in -z output such an entry is followed by its old path as one more field

const stateDir = (env) => join(env.HOME || env.USERPROFILE || homedir(), '.claude', 'state', 'commit-gate');

/** git in `cwd` without the variables that point at another repository and without taking optional locks; null when it fails. */
function gitOut(cwd, args) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const name of REPOSITORY_VARIABLES) delete env[name];
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  return result.status === 0 ? result.stdout : null;
}

/**
 * Number of changed paths in `git status --porcelain=v1 -z` output (a rename counts once; an untracked folder counts once).
 * @param {string} status the raw output
 * @returns {number}
 */
export function dirtyCount(status) {
  const fields = status.split('\0').filter((field) => field !== '');
  let count = 0;
  for (let i = 0; i < fields.length; i += 1) {
    count += 1;
    if (RENAME_OR_COPY.test(fields[i])) i += 1;
  }
  return count;
}

/** The worktree of `cwd`: {top, gitDir, branch}, or null outside a worktree or before the first commit. */
function worktreeOf(cwd) {
  const out = gitOut(cwd, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--abbrev-ref', 'HEAD']);
  if (out === null) return null;
  const [top, gitDir, branch] = out.trim().split('\n');
  return top && gitDir && branch ? { top, gitDir, branch } : null;
}

function hasLanes(top) {
  const list = gitOut(top, ['worktree', 'list', '--porcelain']);
  return list !== null && list.split('\n').filter((line) => line.startsWith('worktree ')).length > 1;
}

function reasonFor({ top, branch }, count) {
  const reason = `Uncommitted changes in ${top} (${count} files): commit them as small Conventional Commits `
    + '(`git commit -m ... -- <paths>`), or say in your reply why they must stay uncommitted.';
  if (!BASE_BRANCHES.has(branch) || !hasLanes(top)) return reason;
  return `${reason} This is the base folder (${branch}) and lane worktrees exist: edits belong in a lane worktree, never in the base folder.`;
}

/** Records `state` for the session; true only when it is newly stored (an unusable store or a known state gives false). */
function recordOnce(env, session, state) {
  const dir = stateDir(env);
  return withSessionLock(dir, session, () => {
    const text = readSessionFile(dir, session, MAX_STORE_BYTES);
    if (text === undefined) return false;
    let seen = [];
    try {
      seen = text === null ? [] : JSON.parse(text).states;
    } catch {
      seen = []; // a corrupt file only means this state may block once more
    }
    if (!Array.isArray(seen)) seen = [];
    if (seen.includes(state)) return false;
    return writeSessionFile(dir, session, JSON.stringify({ states: [...seen, state].slice(-STATES_KEPT) }));
  }) === true;
}

/**
 * The gate decision for one Stop or SubagentStop event.
 * @param {{cwd?: string, session_id?: string, stop_hook_active?: boolean}} input hook JSON
 * @param {Record<string, string | undefined>} [env] where HOME is (the state folder)
 * @returns {{block: false} | {block: true, reason: string}}
 */
export function decide(input, env = process.env) {
  if (input?.stop_hook_active === true || typeof input?.cwd !== 'string') return { block: false };
  const tree = worktreeOf(input.cwd);
  if (tree === null || IN_PROGRESS_MARKERS.some((marker) => existsSync(join(tree.gitDir, marker)))) return { block: false };
  const status = gitOut(tree.top, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  if (status === null || status === '') return { block: false };
  const state = createHash('sha256').update(`${tree.top}\0${status}`).digest('hex');
  if (!recordOnce(env, input.session_id, state)) return { block: false };
  return { block: true, reason: reasonFor(tree, dirtyCount(status)) };
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const result = decide(JSON.parse(await readStdin()));
  if (result.block) process.stdout.write(`${JSON.stringify({ decision: 'block', reason: result.reason })}\n`);
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`commit-gate: ${error.message}\n`); // never trap a session
  }
}
