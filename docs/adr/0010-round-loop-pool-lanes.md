# 0010: The round loop, with branches in reused pool folders

- Status: accepted. Date: 2026-11-25 (the owner's decision: option C, GitButler not used). Supersedes in part 0002 (tess's
  `landing:` verdict on dev's tip: tess now checks only on main, per feature).

## Context

The owner wants a new way of working: small pieces, rolling rounds, each piece landed at once, tess per feature on main, and
lex working only for the boss. The boss splits the work, starts dev and tess, lands and checks main; it plans and builds
nothing. Its only commands are three scripts:

```
node ~/.claude/tools/board/board.mjs tick --repo <abs main checkout> [--plan <abs pieces.json>]
node ~/.claude/tools/git-tidy/git-tidy.mjs lane claim --repo <abs> --branch lane/<id> --base <main sha>
node ~/.claude/tools/land/land.mjs lane/<id> --repo <abs main checkout>
```

The open question was where the parallel devs' branches live: in one shared folder (GitButler, or plain git), or each in its
own folder. In this repo the main checkout is live in every session (`home/` is symlinked into `~/.claude`), and tess needs a
copy of main that does not move under a running test.

## Drivers

1. Fast, small pieces: little setup per piece and a quick land.
2. One straight line on main, with the commit checks on every commit.
3. No mixing between 3 parallel headless devs: no prompts, no push, nothing lost.
4. Main stays safe while devs work, and tess gets a frozen copy of main.
5. Simple to build and to keep, on every machine the setup supports.

## Options

| Option | 1 Speed | 2 Line and checks | 3 No mixing | 4 Main safe | 5 Simple |
|---|---|---|---|---|---|
| A. GitButler (0.23.5): one folder, each dev runs `but commit <its paths> -b lane/<id>` | good: no folder | ok: hooks do not run in a linked worktree (#17363); the main checkout sits on `gitbutler/workspace`, so `git merge --ff-only` there is impossible | bad: every land needs `but pull`, which rebases every branch while other devs commit (#13028, open); a plain `but commit` takes other agents' changes | bad: the one folder holds all work in flight, and here it is the live `~/.claude` | bad: before 1.0, a macOS cask only; land, board, git-tidy and long-run would need a GitButler mode |
| B. Plain git, one folder: every dev commits straight onto main with `git commit -- <own paths>` | good: no land | ok: parallel commits fight over `index.lock` (20 of 20 parallel pairs had one fail in a local probe) | bad: one index; `git add` by one agent stages for all | bad: half-done work is on main and live at once | ok: nothing new, but a retry wrapper and a lock |
| C. Pool worktrees: each branch in a reused folder of the lane pool (`git-tidy lane claim`) | good: a folder is reused, and `node_modules` is kept when no lockfile changed | good: `land` is unchanged and the hooks run in linked worktrees | good: one folder and one index per dev; a piece builds alone, as it will be on main | good: main moves only by a fast-forward land | good: the pool exists (long-run uses it); two small changes |

## Decision

C, with the round loop:

1. lex writes the plan and `<plan>.pieces.json`: each piece's feature, files, `after:` and risk. No two pieces that can run at
   the same time share a file.
2. The boss runs `board tick` after every agent report and after every land. It is event-driven, never polled.
3. While fewer than 3 dev run, the boss claims a pool lane for each piece the tick marks `startable` and briefs dev with
   `worktree:` (the printed folder), `BASE:`, `BRANCH:`, `files:` and the acceptance lines. No agent makes or picks a folder.
4. When dev reports, the boss ticks and lands the piece, one at a time, then ticks again: that tick is the main check. A piece
   the tick marks `overlap` or `stray` lands after the other one, with `--test`.
5. tess is due when 3 features are landed and not yet checked, when the job's last piece has landed, or at once when a risky
   feature has landed; no new piece touches a risky feature's files until tess returns. The boss starts one tess per feature
   (at most 3) with `main: <sha>`, `worktree:`, `feature:`, `commits:` and `suite: yes` on exactly one of them. Each tess
   tests in its own snapshot lane, detached at that sha (`lane claim --snapshot --base <sha>`, released after it returns),
   never in the main folder, which keeps moving; it replies `main: ok` or `main: must-fix <n>`.
6. The boss re-checks a must-fix's repro on the newest main, then makes it a new piece at the head of the queue (`Fix:`); a
   follow-up goes into the final answer.

lex works only for the boss: every `needs: lex` goes to the boss, which decides. `land` keeps pool folders for reuse.

A loses on drivers 3 and 4: with disjoint files `but commit` itself is fine, but the rolling land needs a rebase of the whole
workspace while other devs commit, and no lock tells them to wait. B loses on 3 and 4: it is not branches at all.

## Consequences

- Good: no agent manages a folder; a reused folder skips the install; main moves only by `land`; a piece is built alone, as it
  will be on main.
- Bad: folders still exist, hidden in `<repo>/.claude/worktrees/lane-<n>` (git-ignored through `.git/info/exclude`). A risky
  piece is on main, and live in this repo, before any check: a must-fix there is undone with `git revert <sha>` as a new piece.
  tess finds bugs later than before, per feature instead of per branch.
- Assumption: folder setup is the cost the owner wants to remove; the pool removes it.
- Reversal signal: a GitButler release that closes #13028 and #17363, runs the hooks under `core.hooksPath`, and lets `but pull`
  fast-forward a local target (#14823). Then trial it in a scratch repo, never in this one. Leaving it is
  `but teardown --checkout-to main`.

## Sources

- GitButler releases 0.23.0, 0.23.3 and 0.23.5: https://github.com/gitbutlerapp/gitbutler/releases and the Homebrew cask
  https://formulae.brew.sh/api/cask/gitbutler.json (read 2026-11-25).
- GitButler issues https://github.com/gitbutlerapp/gitbutler/issues/13028, /17258, /17363 and /14823; PR /13850 (the Claude
  Code hooks removed).
- `home/tools/git-tidy/README.md` ("lane"), `home/tools/land/README.md`.
- Local probes with git 2.54.0 in a scratch repo: parallel commits in one folder, and `git check-ignore` for the pool folder.
