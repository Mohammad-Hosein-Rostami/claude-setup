# home/tools/token-view/lib

The parts of the `token-view` tool, which shows where tokens and usage limits went. `../token-view.mjs` is the command and
`../README.md` has the options. Plain Node, no dependencies; no dollar figure is shown.

- `transcripts.mjs`: reads Claude Code transcripts into one record per agent run (the lead's session or one subagent file).
- `summary.mjs`: sums the runs into the view: use per role and lane, cache reads and writes, context fill, waste, and general-purpose spawns per day.
- `limits.mjs`: the usage limits against time per account, from the limit logs the status line writes.
- `print.mjs`: the text and JSON forms of the view and the limits (pure).
