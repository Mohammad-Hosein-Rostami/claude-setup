# Daily use

How to work with this setup day to day. Editing the repo itself is in [usage.md](usage.md); install is in
[setup.md](setup.md); every file is listed in [catalog.md](catalog.md).

## Start
Run `ccm <mode>` (`ccm` alone is medium). Switch inside a session with `/mode <mode>`. Extra args go to claude:
`ccm high -c`. Full flags are in [modes.md](modes.md).

| Mode | Lead model | Pick it when | Cost note |
| ---- | ---------- | ------------ | --------- |
| `normal` | Opus 5.5, effort high | Small or routine work; you want the week to last | Up to 2 agents at once, terse reports |
| `medium` | Opus 5.5, effort high | Default for most tasks | Up to 3 writing agents at once |
| `high` | Opus 5.5, effort high | Wide, multi-part tasks where speed matters | Up to 6 writing agents at once; more usage |
| `extra-high` | Opus 5.5, effort max | Architecture, hard bugs, risky code, key decisions | Max effort on the lead and important agents |
| `ultra-high` | Fable 5.2, effort high | The hardest work; Fable decides, others do the work | Fable is capped at 50% of the weekly limit |

Fable cap: when `ultra-high` reports the limit, exit and run `ccm extra-high -c` to continue the same conversation on
Opus. Keep extra usage off in claude.ai so nothing can bill credits. For the hardest work only:
`CCM_LEAD_EFFORT=xhigh ccm ultra-high`.

## A normal task
- One task per session. For an unrelated next task, `/clear` or start a new session first.
- The lead plans, decides and delegates: `scout` reads, `runner` runs checks, `implementer` writes code, `reviewer`
  and `security-auditor` review. Technical choices are made and stated in one line; owner decisions are asked.
- The lead picks the form by the job (any mode; the rule is in `home/CLAUDE.md`, "Inline, agent or workflow"). Inline, no agent:
  lookups (`/quick` for a read-only one), reading code, one command, a one-file or under-30-line edit (it still runs
  `review-tier` before it lands). One background agent: one implementer lane, one lane's review set, one research question,
  one debug hypothesis set inside a running job. A workflow: 2+ lanes or writers in parallel (`/wf-build`), review panels with fix rounds across
  lanes (`/wf-review`), research over several sources (`/wf-research`), `/wf-bugfix`, `/wf-land`, `/wf-sync`,
  `/wf-git-cleanup`, a multi-stage job that must survive an exit, or when you ask (`/wf-step` runs one agent in the progress view). Landing and machine sync always run their
  workflow, whatever the size; `/wf-bugfix` is for a bug that survived one fix or needs parallel hypotheses and
  `/wf-git-cleanup` for a tangle or several repos; a hypothesis set inside a running job is an agent.
- Gates: targeted checks once after the last edit (through `runner`); the set `review-tier`
  prints (agents or the `wf-review` workflow, by the rule above) (`reviewer`, plus `security-auditor` and Opus lenses for risky classes and at landing); `ui-quality-pass` for UI;
  then `verify-done`.
- While a workflow runs you can keep talking to the lead: it answers questions and asks yours without stopping the
  agents. A command that runs over about 5 minutes goes to the background with its `timeout` set (at most 2 h); `watch.mjs` is for waiting on a
  session or an agent, not on a command.
- The final answer says what changed and what was not run. No recap of the process.

## Long or unattended runs
- Run long or unattended sessions in a plain terminal app (or tmux), not an editor's built-in terminal: closing or
  reloading the editor window ends every session in it. Resume with `ccm <mode> -c`.
- A question (AskUserQuestion) gets one timed dialog per question, one after the other (hook `permission-timed-allow.mjs`; the
  dialog shows the question, its options with the recommended one first and what happens with no answer), each with its own
  wait: with no answer in 60 s (`CLAUDE_QUESTION_TIMEOUT_S`; from 5 questions on less, so all popups end before the terminal
  question auto-continues) or on "Use recommended" it takes that question's "(Recommended)" option, else its first. An answer
  taken on timeout arrives with the note "No answer in 1 min: this option was taken by default, not chosen by the owner
  (UNCONFIRMED)"; a click on "Use recommended" arrives with none. Enter on question 1 means "Use recommended"; on questions 2..N
  Enter means "Answer in terminal", so a keypress meant for the terminal never answers. "Answer in terminal" (or Esc) opens the
  normal question; answering it there, or turning it down there, closes the open dialog.
  With no GUI (ssh, no display) the terminal question stays and auto-continues after 5 min (`askUserQuestionTimeout`; the CLI
  takes only 60s, 5m, 10m or never), a timer that pauses while that terminal window is focused, after any keypress, and with
  Remote Control on. The recommended option is chosen to be safe with nobody there, and each default taken is logged.
- Guard dialogs (`git push`, publish, `rm -rf` outside the project or of a whole folder such as `rm -rf *`, prod-host writes, literal secrets) default to
  Allow and go ahead after 2 min (`CLAUDE_ASK_TIMEOUT_S`; a secret-only ask `CLAUDE_ASK_SECRET_TIMEOUT_S`, also 2 min).
  Every Claude Code permission prompt (any tool, MCP tools, Agent, plan approval, protected files, any mode, background
  agents and `claude -p`) gets the same dialog and goes ahead after 2 min (`CLAUDE_PERMISSION_TIMEOUT_S`); the dialog
  shows the guard's reason when the guard asked. Questions get their own dialog (above).
  Over ssh or with no display there is no dialog: Claude Code's own prompt, or its deny in a `-p` run. A click on Deny blocks
  for good. A command Claude can rewrite (a `$VAR` command word, `rm`/`push` inside `$(...)` or a heredoc, a literal
  secret) is first sent back to Claude once with the fix, so no dialog waits; the message also names what will still
  ask after the rewrite (a push, an `rm` outside the project ...), and sent again unchanged, it gets the dialog. A
  secret sent back this way shows you no dialog, so Claude names its kind in the final report: rotate it if needed.
  A quality rule (a hand-edited lockfile, a `git merge` or plain `git pull` that can create a merge commit, a wait by sleeping: a
  `sleep` loop or one long `sleep`) is advice, not a dialog: Claude gets the fix once (let the package manager write the lockfile;
  rebase or `--ff-only`; run the long command in the background with a `timeout`), and the same
  command sent again runs. Every ask and its outcome is in `~/.claude/logs/guard.jsonl`.
- Watch a run from a second session: `node ~/.claude/tools/watch/watch.mjs <session-id>` under the Monitor tool; it
  prints one line per event that needs action and flags a stall. See its README (`home/tools/watch/README.md`).
  With `--exit-on-event` in a background command it prints the first such event and exits, so a quiet hour costs the
  lead no turns (in an unattended run set the command's `timeout`, at most 2 h: without one it stops after 30 min). A session that only finished its turn and waits for its owner is not a stall: add `idle` to the
  class list (`--exit-on-event owner,idle`) to be told, otherwise it stays quiet. Idle is only told for a session whose process is registered
  (watch by session id, not by file path); in any doubt the silence is still a stall.
- A run that must survive a dropped connection starts a watch on its own session id with
  `--exit-on-event api-error,stall,limit`, as a background command with `timeout` 7200000 (an unattended run stops one without it after 30 min); when the watch exits, the run is woken and carries on.
- Background agents hand decisions to the lead through the ask queue: `node ~/.claude/tools/ask/ask.mjs init` prints
  the queue path, and the lead runs Monitor on `node ~/.claude/tools/ask/ask.mjs watch --queue <path>`. See
  `home/tools/ask/README.md` and the `ask-owner` skill.

## What to expect from agents
- Agents get one full brief (checks, failure cases to test, defaults) and finish it instead of stopping to ask about
  technical details; each default they took is listed in the report. Only your decisions (scope, money, irreversible,
  credentials) reach you. Expect fewer status messages.
- Before reporting, an agent tries to break its own work and says what it tried. The independent review still runs.
- Review findings go back in one message. An agent that has been idle over 5 minutes is replaced by a fresh one that
  gets the spec and the diff, because resuming bills its old context again.
- Agents commit what is green at 80 tool calls and must return a status report by 120. An agent that ends without one is
  continued once, not restarted.
- An instruction that holds for the whole job ("always", "keep", "from now on") is written to `STATUS.md` under
  `## Standing rules`, so it survives a compaction or a resume. When `STATUS.md` is created or a session resumes, the
  lead backfills it from your own earlier messages with `recall.mjs --owner --session current`.
- Saying that a fix did not hold ("still wrong", "i told you before", "third time") makes the agent reproduce the exact
  symptom first and check it before it replies.

## Restructuring a repository
Say what to remove or merge ("remove Nx", "merge the apps into one project") and the `repo-restructure` skill loads.
- The agent writes lists of what to delete, keep and propose (it asks before deleting anything you did not name), and
  records a baseline (install, typecheck, lint, tests, build) before the first change.
- Each step is a small commit you can revert alone; files git does not track are never touched without your yes.
- Env files are compared by variable name only, and a final sweep greps hidden folders for leftovers of the old layout.
- You can run the two checks yourself: `node ~/.claude/tools/refs/refs.mjs check .` (paths that point nowhere) and
  `node ~/.claude/tools/env-names/env-names.mjs diff <saved-file> .` (env names added or removed).

## Clean git history
History stays one straight line (rule C37): no merge commits, no branch merged into another.
- Agents commit on their own branch; the lead rebases each lane onto main and lands it with `git merge --ff-only`, one
  lane at a time, then removes the landed branch and worktree.
- Ask "clean up the git tree" and the `git-linear-history` skill loads; it backs up first and proves the tree is unchanged.
- The two commands: `node ~/.claude/tools/git-tidy/git-tidy.mjs check` (what is left to clean) and `... prune --apply`.
- Pushes and remote branch deletes still ask you.

## Keeping context
- Auto-compaction runs at a 400000-token window (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`); the status line shows the
  context size. Run `/compact` at a natural seam, not mid-step.
- Multi-day work: keep `STATUS.md` (decisions, vocabulary, a `## Work items` table); the lead re-reads its first 60 lines
  after a compaction, lists the job's rows first and edits them only with `status.mjs add|start|done|deliver`; a hand-over is recorded by itself (the `status-deliver.mjs` Stop hook) when a turn ends with no open row, and `status.mjs deliver "<what>"` records one while rows stay open. The lead pastes the `Finish:` block of `node ~/.claude/tools/estimate/estimate.mjs STATUS.md` as every estimate; the status
  line shows the same committed time as `done by 21:40`, `all rows done`, `handed over 17:54`, `work left ~99 h` for a job longer than any finished one, or `done ? <cause>` when the tool refuses or fails (nothing only when STATUS.md is missing; the forms are in the estimate README).
- A detail from an earlier session or before a compaction: `recall`
  (`node ~/.claude/tools/recall/recall.mjs "<terms>"`, add `--session current` after a compaction).
- Phase change, repeated compactions or `/clear`: run the `handoff` skill, then `/clear` and say
  "continue from HANDOFF.md".
- Start a fresh session for an unrelated task, or when context is large and the next step is a new phase.

## Resume after an exit or an account switch
Workflow runs keep a journal on disk, so an exit, a usage-limit stop or a switch of account loses no finished agent.
1. Start the session again: `ccm <mode> -c` (or `claude --resume <session id>`) in the same folder. After a switch of account, start it in the same folder with the other account.
2. The start notice (`<workflow-resume>`) lists every unfinished run of the folder: what finished, what was cut off, the worktrees and branches it owns, the STATUS.md last used. Say "/wf-resume" and the lead continues each run (same script and args; a run of another session gets its journal copied in first).
3. A run marked "may still be running" is left alone until `/workflows` shows it ended. `node ~/.claude/tools/wf-resume/wf-resume.mjs list` prints the notice again at any time. A run you give up is hidden with `wf-resume.mjs abandon <runId>` (it touches no git; relaunching the run lists it again).
Only the session that owns a journal can resume it by itself; the copy step (`wf-resume.mjs adopt`) is what makes a new session able to. Re-check it after a Claude Code upgrade: it relies on the undocumented folder layout.

## At a usage limit
Wait for the subscription reset. Never turn on credits, `/fast`, or `/code-review ultra`. In `ultra-high`, a Fable
cap means `ccm extra-high -c`, not credits.

## After changing the setup
- Skills, agents, rules, standards, hooks, tools and modes are live through symlinks: new edits apply at once, and
  hook scripts run fresh on each call.
- Settings, hooks config, CLAUDE.md, agents and plugins are read when a session starts, and the lead rules load at
  start: restart open sessions (`/exit`, then `claude -c`).
- `~/.claude/settings.json` is a merged copy: change `settings/base.json`, then re-run `scripts/install.sh`.
- Because the repo is live in every session, edit hooks and tools in a git worktree (`scripts/lane-new.sh <name>` makes one on `lane/<name>` and installs the tool dependencies); when the suite is green, rebase onto main and
  fast-forward (`git merge --ff-only`).

## Another machine
`git pull`, then `scripts/install.sh` (Windows PowerShell:
`powershell -ExecutionPolicy Bypass -File scripts\install.ps1`). Run `scripts/doctor.sh` to check: it prints one summary line
(`doctor (MacBook, Claude Code 2.1.328): 1 FAIL, 1 WARN, 38 ok`), then only the lines that need a fix; `--all` prints every line.

On Windows without Developer Mode the installer copies files instead of linking them, so they do not follow later
edits: re-run the installer after every pull. Not yet tested on Windows: `install.ps1` has not been run there, the
guard tests have not been run there (`tests/pin-home.mjs` and the warm-exec fakes assume POSIX scripts), and
`doctor.sh` needs Git Bash and `jq` (there is no PowerShell doctor).

## Where things are
- Reports from agents and audits: `~/Desktop/claude-setup-reports/`.
- Guard log: `~/.claude/logs/guard.jsonl`.
- Typecheck gate run log (one line per check at a stop: what ran or why it was skipped): `~/.claude/logs/typecheck-gate.jsonl`.
- What exists: [catalog.md](catalog.md). Problems: [troubleshooting.md](troubleshooting.md).
