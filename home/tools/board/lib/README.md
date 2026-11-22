# home/tools/board/lib

The parts of the `board` tool: the progress board the status line, `/where` and the pane draw. `../board.mjs` is the command and
`../README.md` has the options. A detached refresh (`refresh.mjs`) collects the facts and writes the board file; the status line only
reads it, so a slow git or transcript scan never delays a render. Plain Node, no dependencies; input and the clock are passed in.

Collecting (run only by the detached refresh):
- `refresh.mjs`: writes the board file of a session, one refresh at a time, at most every live or idle interval.
- `agents.mjs`: lists the subagents of a session, each with its type, task, folder, progress and what it does now.
- `agent-transcript.mjs`: reads one subagent transcript incrementally from a stored byte offset (calls, steps, last call, ended or not).
- `progress.mjs`: how far a running subagent is, from its transcript evidence and the run times of finished agents of its type.
- `pools.mjs`: the run times of finished subagents per agent type on this machine, rebuilt at most every few minutes.
- `repos.mjs`: finds the repositories the session's work is in, for the git rows: the session folder's, then those of the folders
  the session used (edits, launch worktrees, cwds), newest use first.
- `trusted-repos.mjs`: places a folder in its repository by the file system alone and lists the worktrees the repository records.
- `git-state.mjs`: per worktree branch, ahead/behind the base, staged, changed, new and conflicted files, an operation in progress,
  last commit age; the stash count; and the active branches (at most 4 per repository).
- `check-state.mjs`: a repository's last done-check verdict, from the tail of the done-check ledger.
- `repo-stats.mjs`: the base branch's tip commit and the commits landed on it today.
- `job-facts.mjs`: the session's road (id, goal, current step, lanes landed) and the trend of the job's finish clock.
- `read-part.mjs`: a bounded read of a plain file (never a link, a folder or a FIFO, never more than a set number of bytes), also for a repository's own files.
- `cache-file.mjs`: the refresher's own cache files per session (transcript cursors, git cache, agent run times).

Drawing: the status line is 2 rows when calm and at most 4 when busy (alert, job, one agents summary, git and session); every
per-agent and per-worktree detail is in `/where`, which is plain text (no colour codes). Colour marks a state only, never an
agent or a branch.
- `cells.mjs`: the cells every row is drawn with: glyphs, state colours, bars, durations, clocks, fitting parts to a width.
- `render.mjs`: the status line rows, in order: alert, job, agents summary, git and session.
- `work-row.mjs`: the job row: live work only (the live road's current step, else the started rows).
- `layout.mjs`: the row budget, the status line's one agents summary row, and for `/where` the counts row and every agent row.
- `agent-rows.mjs`: one row per agent for `/where` (bar, confidence, time left, doing now, where it works).
- `git-rows.mjs`: the status line's one git summary, and for `/where` one row per worktree (branch, ahead/behind, changed files,
  last commit age, the agents there).
- `stat-rows.mjs`: the road part of the job row, and for `/where` the road row and the finish clock's trend.
- `tree.mjs`: the plain-text tree `/where` prints, with every item unclipped, what waits on the owner and the limits per account.
