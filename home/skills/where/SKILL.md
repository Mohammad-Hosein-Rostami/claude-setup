---
name: where
description: "Show where this session's work stands: the job against its estimate, the road's steps with their clocks, every agent with its progress, what waits on you, git per worktree, the limits per account and the cost figure. Works with mods off."
disable-model-invocation: true
allowed-tools: Bash(node ~/.claude/tools/board/board.mjs where*)
---

Run `node ~/.claude/tools/board/board.mjs where --columns 120` with the Bash tool (it reads the session from
`CLAUDE_CODE_SESSION_ID` and the project from `CLAUDE_PROJECT_DIR`; add `--session <id>` when that variable is not set)
and print its output as-is inside a code block, with no other text: it is the tree the progress pane would draw, already
fitted to 120 columns: the status line's road, counts, agent and git rows with nothing folded. If the command fails, print its error line and nothing else.

The tree reads only files the status line and the board refresh write (the estimate cache, the board file, the asking
marker, the limits files and the session's last-seen file); it never runs git. The cost line is the
API-price equivalent since the last `/clear`, not what the subscription costs; model weekly limits are only in Claude
Code's own limit message.
