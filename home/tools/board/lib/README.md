# home/tools/board/lib

The parts of the `board` tool, the engine behind the status line. `../board.mjs` is the command and `../README.md` has the rows
and rules. A detached refresh (`refresh.mjs`) collects the facts and writes the board file; the status line only reads it, so a
slow git or transcript scan never delays a render. Plain Node, no dependencies; input and the clock are passed in.

Collecting (run only by the detached refresh):
- `refresh.mjs`: writes the board file of a session, one refresh at a time, at most every live or idle interval.
- `agents.mjs`: lists the subagents of a session, each with its type, task, folder and what it does now.
- `agent-transcript.mjs`: reads one subagent transcript incrementally from a stored byte offset (calls, last call, ended or not).
- `repos.mjs`: finds the repositories the session's work is in, for the git rows: the session folder's, then those of the folders
  the session used (edits, launch worktrees, cwds), newest use first.
- `trusted-repos.mjs`: places a folder in its repository by the file system alone and lists the worktrees the repository records.
- `git-state.mjs`: per worktree branch, ahead/behind the base, staged, changed, new and conflicted files, an operation in progress,
  last commit age; the stash count; and the active branches (at most 4 per repository).
- `git-call.mjs`: one git call with the board's fixed flags, clean environment, time limit and per-refresh budget; a failed call
  says why (timed out, exit code), so its facts show `unknown`.
- `repo-stats.mjs`: the base branch's tip commit and the commits landed on it today.
- `read-part.mjs`: a bounded read of a plain file (never a link, a folder or a FIFO, never more than a set number of bytes), also for a repository's own files.
- `cache-file.mjs`: the refresher's own cache files per session (transcript cursors, git cache).

The boss's sync (`tick`, run by hand after every agent report and every land):
- `tick.mjs`: the `tick` command's facts: main's state and the side findings to tidy, the pool's folders, the lanes in flight,
  overlaps and strays among their files, the plan's queue and features due for tess.
- `tick-lines.mjs`: the tick's plain lines from those facts, ending with the suggested next step.
- `tick-features.mjs`: the plan's side of the tick: waiting pieces, each feature's lands, which features tess has checked (a mark
  covers the lands its sha holds), whether a round is due, and the features and `commits <feature>:` lines.
- `tick-plan.mjs`: reads and checks the plan's pieces.json, and reads and writes the job's tess marks (one writer at a time, by a
  lock file).

Drawing: the status line is 2 rows when calm and at most 4 when busy (agents summary, git, lanes and session). Colour
marks a state only, never an agent or a branch.
- `cells.mjs`: the cells every row is drawn with: glyphs, state colours, durations, clocks, row labels, fitting parts to a width.
- `local-clock.mjs`: the local wall clock of an instant (the reset clocks on the session row).
- `render.mjs`: the status line rows, in order: agents summary, git, lanes and session.
- `layout.mjs`: the row budget and the status line's one agents summary row.
- `git-rows.mjs`: the status line's git rows (the session's repository and its lanes, else one row per used repository).
