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
- `repo-stats.mjs`: the base branch's tip commit and the commits landed on it today.
- `read-part.mjs`: a bounded read of a plain file (never a link, a folder or a FIFO, never more than a set number of bytes), also for a repository's own files.
- `cache-file.mjs`: the refresher's own cache files per session (transcript cursors, git cache).

Drawing: the status line is 2 rows when calm and at most 5 when busy (alert, agents summary, git, lanes and session). Colour
marks a state only, never an agent or a branch.
- `cells.mjs`: the cells every row is drawn with: glyphs, state colours, durations, clocks, row labels, fitting parts to a width.
- `local-clock.mjs`: the local wall clock of an instant (the reset clocks on the session row).
- `render.mjs`: the status line rows, in order: alert, agents summary, git, lanes and session.
- `layout.mjs`: the row budget and the status line's one agents summary row.
- `git-rows.mjs`: the status line's git rows (the session's repository and its lanes, else one row per used repository).
