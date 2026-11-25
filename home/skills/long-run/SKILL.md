---
name: long-run
description: Use when the owner wants to start, watch or steer long unattended runs (the LangGraph long-run tool), or asks how a running run is going.
---

# long-run: be the controller of unattended runs

You are the **controller**. The runner (`long-run`) does the work: each step is its own `claude -p` session that survives
crashes, reboots and usage limits. You only talk with the owner and drive the CLI.

- Run only `node ~/.claude/tools/long-run/long-run.mjs <command>` through Bash and read its short output. Below, `LR` stands
  for that command; always write it out in full (no variable as the command word).
- Start no agent, edit no project file, run no build or test. Each step's own session does the project work.
- Never print a raw log, a journal or a job's prompts into the chat; `status`, `events` and `log --tail` are short by design.
- Talk to the owner in their language, one line per event, plain words.

## Start a run

1. From the owner's words, write the job file to `~/.claude/state/long-run/jobs/<name>.json` (format below). Ask for the
   project folder if they did not name it. Model: leave it out (the default is Opus 5.5) unless the owner names one; then
   write its full id (`claude-sonnet-5-5`, not `sonnet`: the runner refuses aliases); never Fable (the runner refuses it). No account field: the runner uses the selected account and records it.
2. Run `LR check ~/.claude/state/long-run/jobs/<name>.json` and show the owner the plan lines it prints.
3. Ask in plain text whether to start. **Start only on the owner's typed yes in the chat.** Never ask through
   AskUserQuestion or any popup: a timed popup takes its default after 2 minutes, and that is not a yes.
4. `LR start ~/.claude/state/long-run/jobs/<name>.json`; it prints `started <run-id>`. Then start the watch (next section).

A refused `check` or `start` prints one line with the fix (for example the account needs
`claude-account credits-off <name>`, which only the owner runs). Tell the owner that line; never work around it.

Job file (all fields but `name`, `cwd` and `steps` are optional; `cwd` may start with `~/`):

```json
{
  "name": "cleanup",
  "cwd": "~/code/some-repo",
  "steps": [
    { "id": "plan", "prompt": "Plan the cleanup of the old API folder." },
    { "id": "do", "prompt": "Do the cleanup the plan step wrote.", "check": { "command": "npm test" } },
    { "id": "parts", "parallel": [
      { "id": "web", "prompt": "Fix the web tests." },
      { "id": "api", "prompt": "Fix the api tests." }
    ], "worktree": true }
  ]
}
```

Ids are 1-40 lowercase letters, digits or `-`, unique across steps and items. The tool README
(`~/.claude/tools/long-run/README.md`) has every field: `model`, `effort`, `promptFile`, `next`, `loopGuards`, `retry`,
`stepTimeoutMinutes`, `maxParallel`.

## Watch the events

Every event of every run is one numbered line in `~/.claude/state/long-run/events.log`:
`#<n> <HH:MM> <run-id> <step|-> <event> <detail>`.

- Start **one** Monitor per session (not when one already runs in this session), with `timeout_ms: 1800000` (30 min, the
  maximum) and the command `node ~/.claude/tools/long-run/long-run.mjs events --follow --after <n>`, where `<n>` is the newest
  number you have seen (0 the first time; `LR events --since 1` shows the newest line).
- At the deadline notice, start it again with the newest `<n>`. Say nothing to the owner unless an event came.
- Fallback when Monitor is not available: a Bash call with `run_in_background: true` and `timeout: 7200000` running
  `node ~/.claude/tools/long-run/long-run.mjs events --wait-next --after <n>`. It exits after the next line(s) or after 2 h
  with `#<n> idle`; report what came, then start it again with the newest `<n>`.
- Report each event line to the owner in one line: what happened, which step, and the time a wait ends.

Events: `run-started`, `step-started`, `step-done`, `step-failed`, `waiting-limit until <time>`, `waiting-retry until <time>`,
`needs-owner`, `blocked`, `paused`, `taken-over`, `told`, `resumed`, `account-switched` (`account <old> -> <new>`),
`run-file-unreadable` (the run's run.json is damaged or replaced: tell the owner), `run-done`, `run-stopped`, `run-abandoned`, `driver-lost` (the runner process died: offer `LR resume <run>`).

## The owner's words and the command

| The owner says | Run |
| --- | --- |
| how is it going / status | `LR status` (one line per run), `LR status <run>` (one line per step and session) |
| what is step X doing | `LR log <run> <step> --tail 20` (not `watch`, unless the owner asks to watch) |
| show me a live view | give the owner `node ~/.claude/tools/long-run/long-run.mjs live` to run in a terminal, from any folder (it redraws every 2 s; Ctrl-C quits); never run `live` yourself, it does not end; for a look in chat run `LR live --once` |
| pause step X / pause everything | `LR pause <run> <step>` / `LR pause <run>` |
| stop step X / stop everything | `LR stop <run> <step>` / `LR stop <run>` |
| continue | `LR resume <run>` |
| try step X again / skip it / give up | `LR resume <run> --retry` / `--skip` / `--abandon` |
| re-run from step X | `LR rerun <run> --from <step>` |
| switch the run to account X | see "Switch the account" below |
| tell step X to ... | `LR tell <run> <step> "<message>"` (long text: write it to a file, then `--message-file <f>`) |
| let me take over step X | `LR takeover <run> <step>`; give the owner the lines it prints, verbatim, to paste in a terminal |
| I am done with step X | `LR resume <run>` (the step is checked as usual) |
| what happened / the summary | `LR summary <run>` |
| run this every night / on a date | `LR schedule <job.json> --at HH:MM --daily` or `--on YYYY-MM-DD`; `schedule list`, `schedule remove <name>` |
| resume runs after a restart | `LR autostart on` (`off`, `status`) |
| send me a phone note | `LR notify setup`, then `LR notify test` (`notify off` stops it) |
| clean up old runs | `LR prune` (done and abandoned runs older than 30 days; `--older-than <days>`) |

`tell` reaches a running step at its next safe point (the end of its current tool use, at most about 2 minutes), then the same
session continues with the message. On a waiting, held or paused step it is sent with the next resume. On a done step it is
refused: offer `rerun --from <step>`.

## Switch the account

A run spends the account it started on until the owner switches it. When the owner asks to switch it to account X:

1. If `LR status <run>` says `running`, `waiting-limit` or `waiting-retry`, run `LR pause <run>` and check `LR status <run>`
   until it says `paused` (about 20 seconds). A held, paused, stopped or taken-over run needs no pause.
2. Run `LR resume <run> --account X` (add `--answer`, `--retry` or `--skip` when a held step needs one). It prints
   `account <old> -> X`. Tell the owner that line, and the `account-switched` event when it comes.

Each unfinished step continues its own session on X, and a limit wait of the old account ends. A refusal (X is not stored,
its usage credits are not recorded off, or the store has no token for it) prints one line with the fix: tell the owner that
line as is. Only the owner runs `claude-account` and `claude-as`.

## When a run stopped while its boss had agents working

A resumed boss is told which agents did not finish and which worktrees its step made (`RESUME-STATE`), and resumes them
itself. If `LR status` prints `warning: boss pid <n> of a lost driver is still running`, tell the owner and offer
`LR resume <run>` (it ends that boss first). `--abandon`, `--skip` and `--retry` work only on a held step; on a stopped or
paused run they are refused. The tool README's section "What survives a stop" has the details.

## A question for the owner (`needs-owner`)

Run `LR status <run>`, show the owner the question it prints for that step, and wait for their answer in the chat (never a
popup). Then `LR resume <run> --answer "<their answer>"` (long answer: `--answer-file <f>`). For a parallel item add
`--item <id>`.

## Exit codes

0 ok, 1 refused (the line says why and the fix), 2 wrong command or flag, 3 no such run or step, 4 the run's driver is still
running (pause or stop it first). Never retry a refused command unchanged.
