# home/tools/watch/lib

The parts of the `watch` tool, which follows a running Claude Code session and prints the events worth waking up for.
`../watch.mjs` is the command; `../README.md` has the options. Plain Node, no dependencies, and no use of `tail` or
shell tools, so it runs on Windows, macOS and Linux. Input and output are passed in, so tests use temp files and a fake clock.

- `args.mjs`: reads the command line (`UsageError`, the usage text).
- `resolve.mjs`: finds the transcript, session id and process to watch from what you typed.
- `tail.mjs`: follows one file as it grows, like `tail -F`.
- `classify.mjs`: turns one transcript line into events.
- `actions.mjs`: keeps only the events that need attention.
- `events.mjs`: the event classes and the names `--exit-on-event` accepts.
- `wake.mjs`: decides which line wakes the caller (`--skip`, retries, `--delay-sec`).
- `subagents.mjs`: watches the subagent transcripts of a session (model check, newest write, whether one stopped unfinished).
- `guard.mjs`: picks the lines of the guard log (`~/.claude/logs/guard.jsonl`) to report.
- `stall.mjs`: reports "nothing written for N minutes" once (a stall, or idle when the turn had finished), then "resumed".
- `watcher.mjs`: puts it together for one session and for the guard log.
- `mask.mjs`: hides secret-shaped text before anything is printed or logged.
- `errors.mjs`: prints the watcher's own errors instead of dying silently.

## Test

From the repo root:

    node --test tests/watch*.test.mjs

## Watch out for

- Always print through `mask.mjs`.
- A stall is reported once, not on every poll.
- A quiet session that finished its turn is IDLE, not a stall; only an end the transcript clearly shows counts (see `classify.mjs`).
