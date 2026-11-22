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
- `repos.mjs`: finds the repositories the session's work is in, for the git rows.
- `trusted-repos.mjs`: the repositories the board may run git in (the session folder's and the setup's own).
- `git-state.mjs`: per worktree branch, ahead/behind the base, changed files, last commit age and the agents working there.
- `repo-stats.mjs`: the base branch's tip commit and the commits landed on it today.
- `job-facts.mjs`: the session's road (id, goal, current step, lanes landed) and the trend of the job's finish clock.
- `read-part.mjs`: a bounded read of a plain file (never a link or a folder, never more than a set number of bytes).
- `cache-file.mjs`: the refresher's own cache files per session (transcript cursors, git cache, agent run times).
- `hue-store.mjs`: keeps the colour of each work item between renders so it never changes while the item is live.

Drawing (used by the status line and `/where`):
- `cells.mjs`: the cells every row is drawn with: glyphs, colour, bars, durations, clocks, fitting parts to a width.
- `identity.mjs`: gives every work item one hue and one marker shape, so an agent row and its branch row read as one item.
- `layout.mjs`: packs the board into the rows the terminal has room for and folds agent rows by urgency.
- `render.mjs`: the status line rows, in order, for the width and height of the terminal.
- `work-row.mjs`: the job row: the session's job against its estimate and step.
- `agent-rows.mjs`: one row per agent (bar, confidence, time left, doing now) and the folded forms used when rows run out.
- `git-rows.mjs`: the git rows: branch, ahead/behind, changed files, last commit age and the agents there.
- `stat-rows.mjs`: the stat rows: the road's current step and the finish clock's trend.
- `tree.mjs`: the full tree `/where` prints, with every item unclipped, what waits on the owner and the limits per account.
