// Purpose: lock a lane worktree right after Bash made it (spec-p3 `r9-wt-lock`), so prune and the in-work check never remove a live lane;
//   `git-tidy land` unlocks the landed lane's own worktree before it removes it. Agent worktrees are left to Claude Code's own lock.
// Exports: lockNewLaneWorktrees(top, input) -> string[] (the paths locked), WORKTREE_ADD.
// Which worktrees: after a `git worktree add` in the command, every linked, unlocked worktree of `top` whose branch is not an agent's
//   (`worktree-agent-*`, `worktree-wf_*`) and whose folder was made in the last FRESH_MS. Reason: `<branch> <session id>`.
// Invariants: never throws (a failing git call locks nothing); git runs hardened with a timeout per call; the reason holds only plain
//   characters (no newline rides into git's lock file).
import { statSync } from 'node:fs';
import { runGit } from '../../tools/git-tidy/lib/git.mjs';
import { isAgentBranch } from '../../tools/git-tidy/lib/copies.mjs';

export const WORKTREE_ADD = /\bgit\b[^|;&\n]*\bworktree\s+add\b/;
const FRESH_MS = 10 * 60 * 1000; // a folder made by this command is seconds old; ten minutes covers a slow checkout
const GIT_TIMEOUT_MS = 1500;
const MAX_LOCKS = 5;
const HARDENED = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'safe.bareRepository=explicit'];
const HEADS = 'refs/heads/';

/** The linked, unlocked worktrees of `top` as `{ path, branch }`, or [] when git fails. */
function unlockedLinked(top) {
  try {
    const listed = runGit(top, [...HARDENED, 'worktree', 'list', '--porcelain', '-z'], undefined, { timeoutMs: GIT_TIMEOUT_MS });
    if (listed.status !== 0) return [];
    const trees = [];
    for (const field of listed.stdout.split('\0')) {
      if (field.startsWith('worktree ')) trees.push({ path: field.slice('worktree '.length), branch: null, locked: false });
      else if (field.startsWith(`branch ${HEADS}`) && trees.length) trees.at(-1).branch = field.slice(`branch ${HEADS}`.length);
      else if ((field === 'locked' || field.startsWith('locked ')) && trees.length) trees.at(-1).locked = true;
    }
    return trees.slice(1).filter((tree) => !tree.locked && tree.branch !== null);
  } catch {
    return [];
  }
}

/** Locks the lane worktrees a `git worktree add` just made (see the header); returns the paths it locked. */
export function lockNewLaneWorktrees(top, input, nowMs = Date.now()) {
  if (!WORKTREE_ADD.test(String(input?.tool_input?.command ?? ''))) return [];
  const session = String(input?.session_id ?? '').replace(/[^\w-]/g, '').slice(0, 64);
  const locked = [];
  for (const tree of unlockedLinked(top).filter((entry) => !isAgentBranch(entry.branch)).slice(0, MAX_LOCKS)) {
    try {
      if (nowMs - statSync(tree.path).birthtimeMs > FRESH_MS) continue;
      const reason = `${tree.branch.replace(/[^\w./-]/g, '_')} ${session}`.trim();
      const done = runGit(top, [...HARDENED, 'worktree', 'lock', '--reason', reason, '--', tree.path], undefined, { timeoutMs: GIT_TIMEOUT_MS });
      if (done.status === 0) locked.push(tree.path);
    } catch {
      // a folder that cannot be read or locked stays unlocked: prune still keeps it while it is dirty or unmerged
    }
  }
  return locked;
}
