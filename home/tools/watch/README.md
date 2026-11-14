# watch

Follows Claude Code sessions from another session and prints one line per event that needs a human. Built for the Monitor
tool (each stdout line is one notification). Node 22, no dependencies, no bash, jq, tail or stat: runs on Windows, macOS and Linux.
Replaces the loose `live-watch.sh` + `watch.sh` + `agent-watch.sh` scripts.

Run: `node ~/.claude/tools/watch/watch.mjs <session-id | transcript.jsonl>... [--stall-min 20] [--log <dir>] [--guard-log <path>] [--once] [--exit-on-event [classes]]`

| Part | What it does |
| ---- | ------------ |
| `<session-id>` | Resolved to `~/.claude/projects/*/<id>.jsonl`; an unknown id exits 2 and the error names it. A path (separator or `.jsonl`) is used as given. Subagent transcripts are read from `<dir>/<id>/subagents/**.jsonl`. |
| `--stall-min N` | Minutes without a write to the main transcript or any subagent transcript before `STALL` (default 20). |
| `--log <dir>` | Also appends the full verbose stream to `<dir>/<label>.events.log` (see below). |
| `--guard-log <path>` | Guard log to read (default `~/.claude/logs/guard.jsonl`). |
| `--exit-on-event [classes]` | Prints only the first event of a listed class and exits (0; 1 for `watch-error`), so a quiet hour prints nothing. Classes, comma-separated, written right after the flag (put the session id before the flag): `owner`, `error`, `limit` (a limit window starting or ending), `api-error`, `guard`, `stall`, `watch-error`; default all of these. `compact` is opt-in. An unknown class exits 2. With `--once` it reads what is there now and stops at the first listed event (nothing printed when there is none). `SESSION_END`, `RESUMED`, Stop hook feedback and `MODEL MISMATCH` never wake it. |
| `--once` | Processes what is in the files now, from the start, and exits 0 (no stall or session-end checks). |

Follow mode starts at the current end of each file, polls every 1.5 s, keeps a partial last line until its newline arrives,
re-reads a file that shrinks and picks up a file that appears later. `--` ends the flags; an unknown flag exits 2.

## Output (stdout, `<label>: ` first, label = first 8 characters of the session id)

| Line | Meaning |
| ---- | ------- |
| `OWNER <first 200 chars>` | A real owner prompt (not meta, sidechain, compaction summary, task or cross-session notification). A prompt whose content is an array (text plus images) counts: its text parts are joined and `[+N images]` is appended; an array with a `tool_result` part is not a prompt. Counting these is a deliberate improvement over the old bash filter, which ignored array content. An owner prompt that quotes "ERROR" is still an `OWNER` line; a meta, sidechain or compaction-summary entry is never an alert (only the harness's `Stop hook feedback` is). |
| `<ts> COMPACT <trigger> <pre>-><post>` | A compaction. |
| `<ts> API_ERROR <class>` | An entry the API failed with (`isApiErrorMessage`). The error class only (`server_error`, `overloaded_error`, ...), never the message; an odd class prints `unknown`. A retry that works seconds later is still one event. |
| `<ts> LIMIT rate_limit` / `<ts> LIMIT_RESET resumed after N min` | A usage or rate limit stopped the session (a `rate_limit` error entry), and the first normal assistant reply after it. Owner prompts and other API errors inside the window do not end it. |
| `<ts> ERR ...`, `... PROMPT Stop hook feedback...` | A tool error, API error, rate or usage limit (the alert words of the old `watch.sh`), and Stop hook feedback. |
| `MODEL MISMATCH type=.. asked=.. ran=..` | A subagent ran on another model than asked, or on Fable or Opus with none asked. Covers the old `agent-watch.sh` alert. |
| `GUARD <outcome> <hook>: <reason> \| <command>` | Guard outcome `deny`, `timeout`, `no-gui` or `dialog-failed` for a watched session only. Secret-ask timeouts are skipped (a secret-ask deny is shown). The command is masked with the guard's `maskSecrets` and cut to 60 characters. |
| `STALL no transcript or subagent writes for N min` / `RESUMED writing again` | Once per stall, then when writing starts again. |
| `WATCH_ERROR <label> <reason>` | The watcher's own problem: a line or poll that threw (same reason at most once a minute), `cannot read <file> (<code>)` (once per failure; `--once` then exits 1; a vanished file counts), or `WATCH_ERROR - fatal: ...` before a non-zero exit. The watch keeps going after anything but a fatal error. |
| `WATCH_NOTE <label> ...` | A session id found in several project folders: the most recently written transcript is watched and the note names the folders. |
| `SESSION_END pid=N` | The process registered for the session in `~/.claude/sessions/<pid>.json` is gone. Not reported when no registry file names the session. |

Everything printed or logged is masked first (`lib/mask.mjs`: the guard's `maskSecrets`, plus token shapes, key=value secrets, long hex and base64-like runs; over-masking is accepted).
A gap of more than 2 minutes between two polls (laptop sleep) restarts the stall timer instead of reporting a stall. A transcript replaced by another file
(new inode or birth time, even a larger one) is re-read from its start. Subagent files are listed each poll but only stat-ed when new or recently changed
(dormant ones every 20th poll) and read only until their model is decided; the decision is cached.

`--log` adds every other event in the `live-watch.sh` format: `TOOL`, `AGENT`, `WORKFLOW`, `SKILL`, `USAGE`, `INPUT_MODE` (only
changes), plus `AGENT_RAN type= asked= depth= ran=` per subagent (the old `agents.log`) and `STALL`/`RESUMED`/`SESSION_END`.

## Wake the lead only for real events (`--exit-on-event`)

Monitor turns every stdout line into a lead turn, and a Monitor ends after at most 30 minutes (the lead re-arms it). A background
Bash command has no such cap and costs nothing while it prints nothing, so for "tell me when something needs me" run:

    node ~/.claude/tools/watch/watch.mjs <session-id> --exit-on-event

as a background Bash command (`run_in_background`). The harness re-invokes the lead when it exits: stdout is the one event line,
exit 0 is an event, exit 1 is the watcher's own problem (`WATCH_ERROR`), exit 2 is a usage error. Run it again to keep watching.
Monitor is still right when every line matters as it arrives (a live feed with `--log`, several sessions at once with all their lines).

Self-watch: an unattended run that dies on a connection error or a limit window writes nothing more, so nobody notices. Start, at the
beginning of the run, a background `watch.mjs <this session's own id> --exit-on-event api-error,stall,limit`. When the transcript
shows an API error, a limit, or no writes for `--stall-min` minutes, the command exits and its exit re-invokes the session.
Use a `--stall-min` longer than your longest quiet tool call. Guard `bounce` outcomes are not events.

## Layout

`watch.mjs` wires arguments, files and stdout. `lib/`: `args` (CLI validation), `resolve` (id to path, session pid),
`classify` (transcript line to verbose event), `actions` (which events are alerts), `events` (the `--exit-on-event` class names), `mask`, `errors` (WATCH_ERROR reporter), `guard` (guard-log filter), `stall`
(detector, clock injected), `tail` (follow a file), `subagents` (model check, newest write), `watcher` (one session, guard follower).
Tests: `tests/watch*.test.mjs`.
