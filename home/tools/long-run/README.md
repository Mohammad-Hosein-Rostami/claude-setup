# long-run

Runs a job file of steps unattended, each as one `claude -p` boss session, and resumes it after a crash, reboot or usage limit.

Runs a long job of steps without anyone watching. Each step (or parallel item) is one `claude -p` main session, the **boss**,
which runs the usual team (lex, dev, tess) itself; a step never starts max. A small LangGraph.js graph with a SQLite checkpoint
per run sits around the bosses, so a crash, a reboot, a usage limit, a pause or a takeover continues the **same** session with
`--resume <session-id>`.

```
node ~/.claude/tools/long-run/long-run.mjs check job.json     # validate, print the plan, spend nothing
node ~/.claude/tools/long-run/long-run.mjs start job.json     # start; the driver runs detached
node ~/.claude/tools/long-run/long-run.mjs status             # one line per run
```

Install: `scripts/install.sh` (macOS, Linux) or `scripts/install.ps1` (Windows) runs `npm ci` here (the tool is in
`TOOLS_WITH_DEPS` of `scripts/install.mjs`). It stays on npm with `package-lock.json`: `npm ci` runs better-sqlite3's install
script (a prebuilt binary, no compiler), which pnpm would skip. The pinned versions are LangGraph.js 1.7.5 and
`@langchain/langgraph-checkpoint-sqlite` 1.1.1. After a Node upgrade that changes the native ABI the next install
reinstalls it (the install stamp holds the ABI); until then `check`, `start` and `check --deps` refuse with that fix, and
`long-run.mjs check --deps` tests that LangGraph and the SQLite module load on this Node.

## Commands

Exit codes: 0 ok, 1 refused or failed (the line says why and the fix), 2 usage, 3 no such run or step, 4 the run's driver is
running (pause or stop it first) or the folder is used by another live run.

| Command | What it does |
|---|---|
| `check <job.json>` | validate, resolve the account and the models, load the SQLite module; print the plan; no tokens |
| `check --deps` | only load LangGraph and the SQLite module (an in-memory database); prints `ok` or the fix |
| `start <job.json> [--foreground]` | check, freeze the job into the run folder, start the driver (`<run>/driver.log`); prints `started <run-id>` |
| `status [<run>] [--json]` | all runs, one line each; one run: a line per step and per running, paused or taken-over session |
| `watch <run> [<step>]` | follow the live log as readable lines; Ctrl-C ends only the watching |
| `live [--once] [--all]` | every run that is not done or abandoned (`--all`: those too), newest first: its state, account and steps, a limit or retry wait with its time, the short session id; redrawn every 2 s until Ctrl-C (which ends only the view); `--once` prints one frame |
| `log <run> [<step>] [--tail N] [--raw]` | the last N readable lines (default 20, 0 = all); `--raw` the stream lines |
| `pause` / `stop <run> [<step>]` | end a boss cleanly; pause keeps it ready, stop fails the step (routed by `next.failed` or held) |
| `takeover <run> <step>` | pause the step and print the lines that open its session in a terminal |
| `tell <run> <step> "<message>"` | a message for a running step, delivered at its next safe point (`--message-file <f>`; at most 8 KB each) |
| `resume <run> [--account <name>] [--answer <t> \| --answer-file <f>] [--item <id>] [--retry \| --skip \| --abandon] [--reload-job <f>] [--force] [--foreground]` | continue a held, paused, stopped, taken-over or stale run; `--account` moves it to another stored account |
| `resume --stale [--delay <s>]` | resume every run whose driver died (what autostart runs) |
| `rerun <run> --from <step> [--reload-job <f>]` | run again from an earlier step (fresh sessions; files are not rolled back) |
| `summary <run>` | print `summary.md` |
| `prune [--older-than <days>]` | remove the folders (checkpoints, logs, journals) of done and abandoned runs that ended at least that many days ago (default 30); a running, held, paused, stopped or stale run is never removed |
| `events [--run <id>] [--since <n>] [--follow] [--after <n>] [--wait-next [--max-wait <s>]]` | the numbered event lines |
| `notify setup [--server <url>] \| test \| off` | phone push through ntfy (desktop notes need no setup; `CLAUDE_LONG_RUN_DESKTOP_NOTES=off` in the environment turns them off, the phone push stays; the tests' `cleanEnv` sets it) |
| `autostart on \| off \| status` | resume stale runs after login (launchd agent / Task Scheduler) |
| `schedule <job.json> --at HH:MM [--daily \| --on YYYY-MM-DD]`, `schedule list`, `schedule remove <name>` | timed starts |

The account is the one selected when the run starts (`CLAUDE_ACCOUNT`, else the store's default), recorded in `run.json` and
kept until `long-run resume <run> --account <name>` switches it (the same check as a start, plus a token in the store; the
run must not be running). A run is refused unless usage credits are recorded off for it (`claude-account credits-off
<name>`, the owner's one-time step); the token is read from the account store inside the runner and goes into the child's
environment only. Fable is refused anywhere in a job; the default model is `claude-opus-5-5`.

## Job file

`examples/job.example.json` (its `promptFile`s are in `examples/prompts/`):

```json
{
  "name": "docs-cleanup",
  "model": "claude-opus-5-5",
  "effort": "high",
  "cwd": "~/code/some-repo",
  "loopGuards": { "maxAttempts": 3, "maxStarts": 10 },
  "retry": { "firstDelaySeconds": 60, "factor": 4, "maxDelaySeconds": 1800 },
  "maxParallel": 3,
  "steps": [
    { "id": "plan", "prompt": "Plan the docs cleanup of this repo; commit the plan as docs/cleanup-plan.md." },
    { "id": "pages", "worktree": true, "parallel": [
        { "id": "guide", "prompt": "Rewrite docs/guide.md per docs/cleanup-plan.md." },
        { "id": "api", "promptFile": "prompts/api.md" }
    ] },
    { "id": "build", "promptFile": "prompts/build.md", "check": { "command": "node --test tests/*.test.mjs" },
      "next": { "failed": "fix" } },
    { "id": "fix", "prompt": "The tests fail after the docs work; fix them.", "next": { "done": "build" } }
  ]
}
```

| Field | Rule | Default |
|---|---|---|
| `name` | `^[a-z0-9][a-z0-9-]{0,39}$` | required |
| (account) | not a job field | the account selected at start |
| `model` | a full `claude-opus-*` / `claude-sonnet-*` / `claude-haiku-*` id; an alias (`opus`, `sonnet`, `haiku`) is refused, because Claude Code decides what an alias means; anything with `fable` is refused | `claude-opus-5-5` |
| `effort` | `low` \| `medium` \| `high` \| `xhigh` \| `max` | not passed |
| `cwd` | absolute (or `~/...`), an existing folder; on Windows none of `"` `%` `^` `&` `\|` `<` `>` | required (steps and items may override) |
| `loopGuards.maxAttempts` | 1-10 failed attempts per step; a limit wait, pause, stop or takeover is not an attempt | 3 |
| `loopGuards.maxStarts` | 2-100 `claude` starts per step, for any reason | 10 |
| `retry` | first 10-3600 s, factor 1-10, max 60-21600 s, +-20% jitter | 60 s, x4, 1800 s |
| `stepTimeoutMinutes` | 5-10080, or `null` for none; a step running longer is stopped and retried | 240 |
| `maxParallel` | 1-3 bosses at once in this run | 3 |
| `steps` | 1-50 entries; ids unique across steps and items | required |
| `steps[].prompt` / `promptFile` | exactly one; the file relative to the job file and inside its folder (no `..`, no link out), UTF-8, at most 100 KB, not empty | required (not on a group) |
| `steps[].parallel` | 2-20 items `{ id, prompt \| promptFile, cwd?, model?, effort? }`: a group | none |
| `steps[].worktree` | groups only: each item runs in its own lane worktree on branch `long-run/<run-id>/<item-id>` | false: each item then needs its own `cwd` |
| `steps[].check.command` | a shell command run in the step folder after the boss says done; optional `timeoutMinutes` (default 30; a check stopped there fails, whatever its exit) | none |
| `steps[].next` | `{ done?, blocked?, "needs-owner"?, failed? }` -> a step id or `"end"` | `done` -> the next step; the rest hold the run |
| `steps[].maxVisits` | 1-10: how often a step may run in one run | 3 |

The loop guards (`maxAttempts`, `maxStarts`, `maxVisits`) stop a step that loops; they are not usage budgets. The step timeout
(240 minutes unless the job says otherwise) stops a step that is stuck. There is no budget and no wait cap: a job spends what
its steps need, and a weekly-limit wait can last days.

A failed step retries with backoff until a loop guard stops it. A usage limit makes the step wait until the reset time the limit
message prints plus 120 s, then continue the same session with `--resume`. A step that ends `blocked` or `needs-owner`, or that
a loop guard stops, holds the run (a LangGraph `interrupt`) until you continue it with `resume --answer`, `--retry`, `--skip`
or `--abandon`.

`start` copies the job, with every `promptFile` inlined, to `<run>/job.json`. Later edits of the original do nothing unless
`resume --reload-job <file>` (or `rerun --reload-job`) is used; that is allowed only when the steps already finished keep their
ids, kinds and order, and it prints which unfinished prompts changed.

Each boss gets the prompt on stdin with a fixed wrapper (run id, step, the earlier steps' summaries, "wait for every agent
you started") and must end with one line `STEP-RESULT: done`, `STEP-RESULT: blocked: <reason>` or `STEP-RESULT: needs-owner:
<question>`. A missing line gets a follow-up asking for it (each counts as a start, so `maxStarts` ends the loop).

## State

```
~/.claude/state/long-run/                 0700 (LONG_RUN_STATE_DIR overrides it)
  events.log, events.log.1, events.seq    one numbered line per event of every run (rotated at 1 MB, the number goes on)
  jobs/<name>.json                        job files the long-run skill writes
  <run-id>/                               <name>-<yyyymmdd-hhmmss>, local time
    job.json                              the frozen job, the sha256 of the original, runnerVersion
    run.json                              account, startedBy (terminal | session | schedule), createdAt
    checkpoints.sqlite                    LangGraph checkpoints (thread_id = run id)
    driver.json, driver.lock, driver.log  the driver: pid, host, heartbeat (30 s), status, waits, holds; the lock line is
                                          `<pid> <host> <start>` (the driver's process start)
    control/                              PAUSE, STOP, <id>.pause, <id>.stop, <id>.takeover, <id>.<time>-<n>-<uuid>.tell (one per message)
    steps/<id>.json, steps/.rerun-<n>/    one journal per step or item; journals a rerun set aside
    logs/<id>.<start>.jsonl, .stderr.log  each start's stream, token-shaped text scrubbed, cut at 50 MB
    events.jsonl, summary.md              this run's events; the report (steps, starts, tokens, branches)
  cwd-locks/<sha256 of the folder>        the live run using a folder (one live run per folder)
  schedules/<name>.json                   timed starts
~/.config/claude-setup/long-run.json      the ntfy server and topic (0600)
```

A run is held by a live driver while its heartbeat is under 120 s old, or while its lock names a live process on this
machine that `ps` shows started when the lock says (a driver that is starting, or one just woken from a sleep, whatever
its heartbeat), or, where `ps` cannot tell, one that started under 120 s ago. Otherwise it is `stale`; `resume` (or
autostart) continues it, and the old lock is removed by one resume at a time. See `docs/adr/0007-long-run-run-lock.md`. A child a
dead driver left running is ended first, and only when its command line holds the step's session id. A session with no
transcript (the driver died before the boss started, or Claude Code's 30-day cleanup removed it) is started fresh, and the
journal says so. Nothing prunes finished runs by itself: `long-run prune` does, when you run it.

## What survives a stop

When a run stops (a pause, a stop, a reboot, a crash or a killed driver) while a boss has subagents working:

- **Nothing in flight continues by itself.** The boss and everything it started end: on SIGTERM, SIGINT or SIGHUP the driver
  pauses the run cleanly, and it also ends what is left of each boss's process tree (a subagent's Bash runs in its own process
  group, so ending the boss's group alone would miss it). A SIGKILL of the driver cannot be caught: the boss keeps working with
  nobody reading it, `long-run status` warns `boss pid <n> of a lost driver is still running`, and `long-run resume` ends it
  and its tree before it continues.
- **The boss conversation survives**: the step continues the same session with `--resume`, so the boss sees its own Agent
  calls and their ids. A session that was never written (the driver died before the boss started) or that Claude Code's 30-day
  cleanup removed is started fresh instead.
- **The runner tells the resumed boss what was in flight.** The step journal records each agent the boss started (from its
  stream) and each git worktree that appeared during the step. Every resumed start begins with a `RESUME-STATE` block: the
  agents that did not finish (id, type, description, worktree), the worktrees with their uncommitted changes and new commits,
  and the commits the step already made. The boss is told to resume each unfinished agent with SendMessage (the agent keeps its
  history but restarts its last tool call), to start a new one only when SendMessage fails, to check each worktree first and
  never start a duplicate. Values from the stream are cut and quoted, so they read as data.
- **Worktrees and half-made work stay on disk.** At the end of a run, a worktree an agent of the step named in its result is
  removed when it has no uncommitted, untracked or ignored file, no assume-unchanged file or skip-worktree file on disk (git
  status does not show edits there) and no commit that is not on the step folder's HEAD or a remote; any other is kept and named in `summary.md`. Any other worktree that appeared during the step (another session's
  lane, say) is only listed, never removed. Branches are never deleted.
- A question (AskUserQuestion) inside a headless step has no popup to answer it (removed on 2026-11-25): Claude Code offers the
  tool in a `-p` run only when the run has a permission host to receive it, so a step should not count on asking.

## How you control a run

- Start: in a plain terminal, `claude-as <account>` (once per terminal), then `node ~/.claude/tools/long-run/long-run.mjs start job.json`.
  Or ask the lead in chat; it runs the same command. The run uses the account selected at that moment, and keeps it until you switch it.
- See it: `long-run status` lists every run; `long-run status <run>` lists each boss session that is running, paused or taken
  over, with its step, account, session id, folder and log file. `long-run watch <run> [step]` shows a step working live.
  `long-run live` keeps every running run on screen, its steps, waits and account, redrawn every 2 s; Ctrl-C quits.
- Pause or stop: `long-run pause <run> [step]` stops the session cleanly and keeps it ready to continue; `long-run stop <run>
  [step]` ends it (nothing restarts it by itself). `long-run resume <run>` continues either.
- Do a step yourself: `long-run takeover <run> <step>` pauses it and prints three lines (account, folder, `claude --resume <id>`).
  Paste them into a terminal and you are inside that session with its full history. When you quit, run `long-run resume <run>`:
  the boss checks what you did, finishes what is left and the step is judged as usual.
- Answer a question: when a step needs you, you get a ping; `long-run status <run>` shows the question; `long-run resume <run>
  --answer "..."`.
- Switch account: `long-run pause <run>`, wait until `long-run status <run>` says `paused`, then `long-run resume <run>
  --account <name>`. It prints `account <old> -> <new>` and records an `account-switched` event; `summary.md` names both
  accounts. Each unfinished step continues its own session on the new account, and a limit wait of the old account ends.
  Done steps keep the old name in their journal. The first start of each step on the new account writes its whole history
  into that account's prompt cache once. A running or limit-waiting run is refused with exit 4. A held, paused, stopped or
  taken-over run needs no pause. A live driver that started before the switch was written follows it at its next start: a
  waiting step ends its wait, and a running boss ends at its next safe point and continues on the new account; a boss that
  has already given its result keeps its verdict, and the next step starts on the new account. Upgrade: a driver started
  by an older version of this tool does not follow a switch, so until it has ended, switch only after `long-run pause <run>`.
  If run.json is not a readable regular file, the steps keep their account and the run gets one `run-file-unreadable` event.
- After a reboot, unfinished runs continue by themselves (autostart on); paused and stopped runs wait for you.

## How you control runs from a Claude session

- Open one Claude session for runs (any folder), on the model you want. Say what you want done, for example "run three steps
  overnight in my-app: plan the cleanup, do it, then fix the tests". The `long-run` skill makes that session the controller.
- It writes the job, shows you the steps, folder and model, and waits for your yes. Nothing starts before you say yes.
- After the start it follows the run's events by itself and tells you each one in one line: a step started, finished or failed,
  waiting for the usage limit (with the time it resumes), a question for you, the run finished.
- Talk to it in plain words: "how is it going?", "pause the build step", "stop everything", "continue", "re-run from step 2",
  "tell the build step to skip the docs and only fix the tests". The last one reaches the running boss within about 2 minutes:
  the runner stops it at the end of its current tool use and continues the same session with your message.
- "Let me take over step 2": it pauses that step and gives you three lines to paste in a terminal; you are inside that session
  with its whole history. When you quit, say "continue" and the step is checked as usual.
- The controller only steers: it does no project work itself. Each step's boss does the work with its own team (lex, dev, tess).
- Your words cost tokens in the controller only; the runner, the events and the waiting cost none.

The controller follows `events --follow --after <n>` with Claude Code's Monitor tool, which ends each watch after at most 30
minutes; the skill starts it again with the newest number, so no line is missed. Without Monitor it runs `events --wait-next
--after <n>` as a background command, which exits after the next lines (or after 2 h with `#<n> idle`).

## How parallel works here vs inside Claude Code

Two kinds of parallel work, and they stack:
- **Inside one boss (Claude Code's own).** One boss starts lex, dev and tess as subagents, at most 3 of each at once (their helpers are
  not counted). The boss pays its start-up once; each further subagent is cheap because it reuses the boss's cache: measured about 1.5k new cache tokens and
  $0.020 (API-price yardstick) per extra agent, plus about 20k tokens the boss reads per result.
- **Across bosses (the runner's).** The runner starts up to 3 bosses at once, each a full `claude -p` session with its own team
  of main agents. Each boss pays its own start-up: measured 75-76k input-side tokens, 29-38k of them new cache writes, about $0.12
  yardstick each. The graph itself costs no tokens.
- What you get for the extra start-ups: each boss restarts on its own after a crash, limit or reboot; one can be paused or taken
  over while the others work; and the work runs as 3 teams instead of 1 (up to 18 agents instead of 6).
- What it costs: about 2 extra start-ups (~60-75k cache tokens) for 3 bosses against 1, and the 5-hour window drains up to 3
  times faster while all 3 work. For many small tasks one boss with subagents is 3-5 times cheaper (measured: 10 tasks $1.22 as
  separate starts against $0.26-0.37 inside one boss). Use runner parallel for a few big, independent pieces of work; give a
  single boss the many small ones.
- Plan limits publish no weights for cache writes against reads, so the dollar figures compare, they do not bill.

## Why LangGraph.js

Needs: macOS and Windows with no compiler; reuse the account token store (Keychain, DPAPI) with no token on a command line;
survive a crash, a reboot and limit resets; fan-out, re-run and branching built in; one stack (Node).

| Option | No compiler | Token store | Survives restarts | Fan-out, re-run, branching | One stack |
|---|---|---|---|---|---|
| A. LangGraph.js + SqliteSaver (chosen) | good: prebuilt better-sqlite3 for Node 22-26 on darwin arm64/x64 and win32 x64 | good: imports `home/tools/account/lib` | good: a crash mid-step re-runs only that step | good: `Send`, `interrupt`, `getStateHistory` | good |
| B. Python LangGraph | ok: Python and uv on every machine | bad: re-implement the store or pipe the token out | good | good | bad |
| C. Plain Node, JSON-lines state | good: no native module | good | ok: own resume code | bad: fan-out, re-run and holds hand-built | good |

B loses on the token store and the stack; C loses on fan-out, re-run and branching. If better-sqlite3 stops shipping prebuilds
for a Node in use, C replaces only `lib/graph.mjs`.

## Threat model

- Secrets: the token comes from the account store inside the process and goes into the child's environment only; never into
  argv, a log, a journal, a usage row or a push. Every log line is scrubbed of `sk-ant-*`; files are 0600, folders 0700. Logs
  still hold what the model read (a `.env` it opened): they are local only.
- The ntfy topic is a shared secret with the ntfy server: anyone with it reads the pings, which hold only the job name, the step
  and a status word.
- The job file is the owner's code: `check.command` runs in a shell, like a Makefile. Prompts go on stdin, never argv. Ids,
  account names and paths are validated before they reach a path or a command.
- Runaway: only the loop guards and the holds after repeated failure; no usage credits (an account without credits recorded
  off is refused), never Fable, never an API key, no `--bare`. A job with many or long steps spends what it needs.
- Full access in `-p`: no command asks for permission, so a step can push or publish with nobody watching. AskUserQuestion
  takes the recommended option after 2 minutes.
- Two writers on one transcript: `resume` after a takeover refuses while the session looks open (its transcript changed in the
  last 60 s, or a running process has the session id in its command line) unless `--force`.

## Not verified

- The `-p` result shape on a usage limit: the limit text is searched in the result, its errors and stderr.
- Whether `-p` waits for background subagents before exiting: the prompt wrapper asks the boss to wait for every agent.
- Agent records come from the stream shapes of Claude Code 2.1.330 (an `Agent` tool use, `task_started`, the tool result's
  `agentId`, `task_notification`); another version may name them differently. A `stopped` notification is counted as not
  finished, so an agent the boss stopped on purpose is listed too.
- Windows: the tree of a boss is ended by `taskkill /T` only; the sweep of processes that outlive it is POSIX only.
- Windows: the detached driver after the terminal closes, `taskkill /T` through `claude.cmd`, the toast, keep-awake and
  `schtasks` are untested on a real Windows machine.
- Whether `Send` obeys `maxConcurrency`: the runner also holds its own semaphore.
- The cost of resuming a big session after its cache expired (`summary.md` shows tokens per step) and how plan limits weigh
  cache writes against reads.
- A scheduled start missed during sleep: macOS relies on launchd running it at wake; Windows misses it.
- A resume on another account (`resume --account`) was tried on two personal subscriptions on Opus 5.5 only, not on a Team or
  Enterprise organization. Sonnet 5.5 and Haiku 5.5 runs lose their earlier thinking after a switch: the API drops it, with
  no error (the visible conversation stays). See `docs/adr/0006-long-run-account-switch.md`.
- Windows (owner's choice): there is no process start-time check, so after a sleep of more than 90 s, a resume in the first
  ~30 s after waking could start a second driver beside the woken one (main's behaviour); the account stays correct.

## Notes for maintainers

- LangGraph reserves `:` in node names, so the nodes are `step/<id>`, `hold/<id>`, `fan/<id>`, `item/<id>` and `join/<id>`.
- `lib/` is split into more files than the design listed to keep each under 300 lines; `lib/README.md` names each one.
- Tests: `node --test tests/long-run-*.test.mjs` with a fake `claude` (`tests/long-run-fake-claude.mjs`) and temp HOMEs; no
  test spends tokens, installs a launchd agent or a scheduled task, or sends a push.
- Timeout knobs, for tests only: `CLAUDE_LONG_RUN_CONTROL_POLL_MS` (how often the driver reads the control files, default
  2000) and `CLAUDE_LONG_RUN_SWEEP_GRACE_MS` (the grace before SIGKILL for a boss's leftover processes, default 3000). A knob
  is named `CLAUDE_<TOOL>_<CONSTANT>` after the constant it sets (`lib/env-ms.mjs`); only a whole number of milliseconds
  from 1 to 2147483647 (2^31-1, Node's longest timer), written in digits only, is taken; anything else (text, a sign, a
  space, a fraction, `1e3`, `0x10`, 0, a larger number) keeps the default.
- Rollback: `autostart off`, `schedule remove` for each schedule, then remove this folder; `~/.claude/state/long-run/` stays.
