# watch

Follows Claude Code sessions from another session and prints one line per event that needs a human. Built for the Monitor
tool (each stdout line is one notification). Node 22, no dependencies, no bash, jq, tail or stat: runs on Windows, macOS and Linux.
Replaces the loose `live-watch.sh` + `watch.sh` + `agent-watch.sh` scripts.

Run: `node ~/.claude/tools/watch/watch.mjs <session-id | transcript.jsonl>... [--stall-min 20] [--log <dir>] [--guard-log <path>] [--once]`

| Part | What it does |
| ---- | ------------ |
| `<session-id>` | Resolved to `~/.claude/projects/*/<id>.jsonl`; an unknown id exits 2 and the error names it. A path (separator or `.jsonl`) is used as given. Subagent transcripts are read from `<dir>/<id>/subagents/**.jsonl`. |
| `--stall-min N` | Minutes without a write to the main transcript or any subagent transcript before `STALL` (default 20). |
| `--log <dir>` | Also appends the full verbose stream to `<dir>/<label>.events.log` (see below). |
| `--guard-log <path>` | Guard log to read (default `~/.claude/logs/guard.jsonl`). |
| `--once` | Processes what is in the files now, from the start, and exits 0 (no stall or session-end checks). |

Follow mode starts at the current end of each file, polls every 1.5 s, keeps a partial last line until its newline arrives,
re-reads a file that shrinks and picks up a file that appears later. `--` ends the flags; an unknown flag exits 2.

## Output (stdout, `<label>: ` first, label = first 8 characters of the session id)

| Line | Meaning |
| ---- | ------- |
| `OWNER <first 200 chars>` | A real owner prompt (not meta, sidechain, compaction summary, task or cross-session notification). |
| `<ts> COMPACT <trigger> <pre>-><post>` | A compaction. |
| `<ts> ERR ...`, `... PROMPT Stop hook feedback...` | A tool error, API error, rate or usage limit (the alert words of the old `watch.sh`), and Stop hook feedback. |
| `MODEL MISMATCH type=.. asked=.. ran=..` | A subagent ran on another model than asked, or on Fable or Opus with none asked. Covers the old `agent-watch.sh` alert. |
| `GUARD <outcome> <hook>: <reason> \| <command>` | Guard outcome `deny`, `timeout`, `no-gui` or `dialog-failed` for a watched session only. Secret-ask timeouts are skipped (a secret-ask deny is shown). The command is masked with the guard's `maskSecrets` and cut to 60 characters. |
| `STALL no transcript or subagent writes for N min` / `RESUMED writing again` | Once per stall, then when writing starts again. |
| `SESSION_END pid=N` | The process registered for the session in `~/.claude/sessions/<pid>.json` is gone. Not reported when no registry file names the session. |

`--log` adds every other event in the `live-watch.sh` format: `TOOL`, `AGENT`, `WORKFLOW`, `SKILL`, `USAGE`, `INPUT_MODE` (only
changes), plus `AGENT_RAN type= asked= depth= ran=` per subagent (the old `agents.log`) and `STALL`/`RESUMED`/`SESSION_END`.

## Layout

`watch.mjs` wires arguments, files and stdout. `lib/`: `args` (CLI validation), `resolve` (id to path, session pid),
`classify` (transcript line to verbose event), `actions` (which events are alerts), `guard` (guard-log filter), `stall`
(detector, clock injected), `tail` (follow a file), `subagents` (model check, newest write), `watcher` (one session, guard follower).
Tests: `tests/watch*.test.mjs`.
