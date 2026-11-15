# watch

Follows Claude Code sessions from another session and prints one line per event that needs a human. Built for the Monitor
tool (each stdout line is one notification). Node 22, no dependencies, no bash, jq, tail or stat: runs on Windows, macOS and Linux.
Replaces the loose `live-watch.sh` + `watch.sh` + `agent-watch.sh` scripts.

Run: `node ~/.claude/tools/watch/watch.mjs <session-id | transcript.jsonl>... [--stall-min 20] [--log <dir>] [--guard-log <path>] [--once] [--exit-on-event [classes]] [--delay-sec N] [--skip N]`

| Part | What it does |
| ---- | ------------ |
| `<session-id>` | Resolved to `~/.claude/projects/*/<id>.jsonl`; an unknown id exits 2 and the error names it. A path (separator or `.jsonl`) is used as given. Subagent transcripts are read from `<dir>/<id>/subagents/**.jsonl`. |
| `--stall-min N` | Minutes without a write to the main transcript or any subagent transcript before `STALL` (default 20). |
| `--log <dir>` | Also appends the full verbose stream to `<dir>/<label>.events.log` (see below). |
| `--guard-log <path>` | Guard log to read (default `~/.claude/logs/guard.jsonl`). |
| `--exit-on-event [classes]` | Prints only the first event of a listed class and exits (0; 1 for `watch-error`), so a quiet hour prints nothing. Classes, comma-separated, written right after the flag (put the session id before the flag). Default: `owner`, `error`, `limit`, `api-error`, `guard`, `stall`, `watch-error`, `session-end`. Opt-in: `compact`, `stop-hook`, `model-mismatch`, `limit-reset`, `idle`. `idle` wakes when the quiet transcript is a session that finished its turn and waits for its owner (see the `IDLE` line below); without it such a session never wakes you. An unknown class exits 2 and the message lists the valid names. `limit` is a LIMIT line only; the end of a limit window is `limit-reset`. `RESUMED` is not a class: it only follows a `STALL` or an `IDLE`, and those already woke you. `error` wakes only for a tool result marked as an error that holds the alert words, never for an agent description, a prompt or a successful tool result. With `--once` it reads what is there now and stops at the first listed event (nothing printed when there is none). A `WATCH_NOTE` goes to stderr in this mode, so stdout is the one event line. |
| `--delay-sec N` | With `--exit-on-event`: an `api-error` or `stall` is held for N seconds (default 0) and dropped when the watched session writes a reply of its own meanwhile (it recovered); watching goes on. Other classes wake at once. Ignored with `--once`. |
| `--skip N` | With `--exit-on-event`: ignore the first N wake events (default 0). Events are counted as they arrive; the same class again within 60 s is a retry of the same failure, not a new event. |
| `--once` | Processes what is in the files now, from the start, and exits 0 (no stall or session-end checks). |

Follow mode starts at the current end of each file, polls every 1.5 s, keeps a partial last line until its newline arrives,
re-reads a file that shrinks and picks up a file that appears later. `--` ends the flags; an unknown flag exits 2.

## Output (stdout, `<label>: ` first, label = first 8 characters of the session id)

| Line | Meaning |
| ---- | ------- |
| `OWNER <first 200 chars>` | A real owner prompt (not meta, sidechain, compaction summary, task or cross-session notification). A prompt whose content is an array (text plus images) counts: its text parts are joined and `[+N images]` is appended; an array with a `tool_result` part is not a prompt. Counting these is a deliberate improvement over the old bash filter, which ignored array content. An owner prompt that quotes "ERROR" is still an `OWNER` line; a meta, sidechain or compaction-summary entry is never an alert (only the harness's `Stop hook feedback` is). |
| `<ts> COMPACT <trigger> <pre>-><post>` | A compaction. |
| `<ts> API_ERROR <class>` | An entry the API failed with (`isApiErrorMessage`). The error class only (`server_error`, `overloaded_error`, ...), never the message; an odd class prints `unknown`. A retry that works seconds later is still one event. |
| `<ts> LIMIT rate_limit` / `<ts> LIMIT_RESET resumed after N min` | A usage or rate limit stopped the session (a `rate_limit` error entry), and the first normal assistant reply after it. Owner prompts and other API errors inside the window do not end it. A watcher started inside an open window (the last 4 MB of the transcript are read at start, silently) still reports the reset. Entries of a subagent's own turns (`isSidechain`) are neither. |
| `<ts> ERR ...`, `... PROMPT Stop hook feedback...` | A tool error, API error, rate or usage limit (the alert words of the old `watch.sh`), and Stop hook feedback. |
| `MODEL MISMATCH type=.. asked=.. ran=..` | A subagent ran on another model than asked, or on Fable or Opus with none asked. Covers the old `agent-watch.sh` alert. |
| `GUARD <outcome> <hook>: <reason> \| <command>` | Guard outcome `deny`, `timeout`, `no-gui` or `dialog-failed` for a watched session only. Secret-ask timeouts are skipped (a secret-ask deny is shown). The command is masked with the guard's `maskSecrets` and cut to 60 characters. |
| `STALL no transcript or subagent writes for N min` / `RESUMED writing again` | Once per stall, then when writing starts again. A stall means work was in flight and went quiet. |
| `IDLE turn ended N min ago, waiting for the owner` | The same silence, but the newest entry of the main transcript shows a finished turn (a `turn_duration` entry, or an assistant message ending in `end_turn` or `stop_sequence`), no subagent transcript was written more than 5 s after it, no subagent written in the stall limit before it ended unfinished (its last line is not an assistant `end_turn` or `stop_sequence`; older ones are ignored), and a live process is registered for the session (watched by transcript path, or not in `~/.claude/sessions`, it is always a `STALL`). Once per idle period; `RESUMED` follows when writing starts again. Any other ending (a tool call or result, a prompt, `max_tokens`, `pause_turn`, `refusal`, an API error entry, an unknown reason) stays a `STALL`, and after `SESSION_END` a silent session is always a `STALL`. A meta entry that carries an origin (a peer message, an auto-continuation) after the turn end counts as the session running again; a transcript that is truncated or replaced forgets the old turn end. A slash command that Claude Code answered itself (its `<local-command-stdout>` or `-stderr` entry follows the `<command-name>` entry directly) does not end the IDLE, and the minutes count from the original turn end; a `<command-name>` entry with no such output after it stays a `STALL`. A watch started on an already idle transcript decides at its first poll (it reads the last 4 MB). `idle` is opt-in for `--exit-on-event`; in follow mode the line prints like any other. |
| `WATCH_ERROR <label> <reason>` | The watcher's own problem: a line or poll that threw (same reason at most once a minute), `cannot read <file> (<code>)` (once per failure; `--once` then exits 1; a vanished file counts), or `WATCH_ERROR - fatal: ...` before a non-zero exit. The watch keeps going after anything but a fatal error. |
| `WATCH_NOTE <label> ...` | A session id found in several project folders: the most recently written transcript is watched and the note names the folders. |
| `SESSION_END pid=N` | No process registered for the session in `~/.claude/sessions/<pid>.json` is alive any more (a resumed session registers a new pid, so one live process is enough). Not reported when no registry file names the session. It wakes in exit mode (`session-end`), within a poll. |

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

It does not leave you waiting silently: a session whose process died wakes with `SESSION_END`, a transcript that stops growing wakes
with `STALL` after `--stall-min` minutes (also after a session end when `session-end` is not in the class list, and when the
transcript never appears; a session that merely finished its turn is `IDLE` and wakes only with `idle` in the list), and a failing step of a poll is reported instead of switching the stall check off. Use a `--stall-min`
longer than your longest quiet tool call. Events written before the watcher starts never wake it; events written between one
watcher exiting and the next one starting are not seen (re-arm first thing after a wake).

Limit window: a `limit` wake means the session stopped until the window resets. Restart with
`--exit-on-event limit-reset,owner,api-error,stall,session-end`: `limit-reset` alone stays through the LIMIT line and wakes when the
session replies again, also when the watcher starts inside the open window.

Self-watch: an unattended run that dies on a connection error or a limit window writes nothing more, so nobody notices. Arm two
background commands together at the start of the run, on the session's OWN id:

    watch.mjs <own id> --exit-on-event api-error,stall,limit --delay-sec 90
    watch.mjs <own id> --exit-on-event api-error,stall --delay-sec 90 --skip 1

The first wakes the lead when the session fails; `--delay-sec 90` lets a blip that recovers by itself pass without a lead turn. The
woken turn can hit the same outage before it re-arms anything, and then nothing watches; the second command ignores that first
failure and wakes the lead again on the next one. On a wake the lead first re-arms whichever command exited (starting both fresh is
also fine), then deals with the event. Does the lead's own activity after a wake count as "the session recovered"? Only replies
written after the event being held count, and the backup never holds the failure it skips, so the work of the woken lead cannot
cancel the backup's wait or make it miss the second failure; a reply after the second failure means the session is running again
and the event is dropped. A second failure within 60 s of the first counts as the same event (retries), so keep `--delay-sec` above that.
`--stall-min` must be longer than your longest quiet tool call, or every long wait wakes the lead.

What a woken line shows: the API, limit and reset lines carry the error class and a time only; `owner`, `guard` and `error` lines
carry what the owner typed (200 characters), the guard's masked command (60) or the tool error text (160), all masked.

## Layout

`watch.mjs` wires arguments, files and stdout. `lib/`: `args` (CLI validation), `resolve` (id to path, session pid),
`classify` (transcript line to verbose event), `actions` (which events are alerts), `events` (the event classes and the `--exit-on-event` names), `wake` (which line wakes: skip, retry, delay), `mask`, `errors` (WATCH_ERROR reporter), `guard` (guard-log filter), `stall`
(detector, clock injected), `tail` (follow a file), `subagents` (model check, newest write), `watcher` (one session, guard follower).
Tests: `tests/watch*.test.mjs`.
