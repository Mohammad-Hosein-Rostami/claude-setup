# 0013: Land's detach of a pool folder runs under the pool lock

- Status: accepted. Date: 2026-11-26. Builds on 0010 (the lane pool and the round loop) and 0012 (who owns a pool folder's fill).

## Context

Tess round 1 (pool-1) found that land's detach of a landed pool folder ran outside the pool lock, on facts read earlier. A
`lane release` and a `lane claim` in between let:

- land detach and unlock a lane already handed out to another branch (R1);
- the boss's land remove that lane (R2);
- git-tidy land leave a pool folder unlocked on its branch after a failed switch (R3).

## Drivers

1. No lane state loses work.
2. No lane is handed out twice.
3. One rule for both lands (git-tidy's and the boss's).
4. Simple, readable code.

## Options

| Option | 1 No lost work | 2 No double hand-out | 3 One rule | 4 Simple |
|---|---|---|---|---|
| A. Detach under the lock; a folder not freed stays locked and land names `lane release` | good | good | good | good |
| B. Also remove, under the lock, a pool folder that could not be detached | ok: `worktree remove` deletes its ignored files | good | bad: git-tidy land keeps, the boss's land removes | bad: land's logic inside a git-tidy lock callback |
| C. Keep the order, re-check right before each act, no lock | bad: a window stays between check and act | bad | ok | ok |

## Decision

A. B deletes ignored files and may remove a folder a git process is working in; C keeps a window between check and act.

## Consequences

- Good: claim, release, reclaim and land's detach take turns on one lock, each reading its facts inside it. Land never unlocks or
  removes a pool folder.
- Bad: a failed detach (a held `index.lock`, a commit after the rebase) makes land exit 1 after the landing, and the folder needs
  a `lane release` or a land re-run.

## Reversal

Revisit B for that one cause if kept lanes pile up from a cause that `lane release` cannot clear.

## Sources

TESS-round1-pool.md (concurrency R1-R3, edge B p3e); the git 2.54 probes in plan-land-detach.md section 3.
