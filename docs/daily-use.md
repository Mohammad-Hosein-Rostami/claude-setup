# Daily use

How to work with this setup day to day. Editing the repo itself is in [usage.md](usage.md); install is in
[setup.md](setup.md); every file is listed in [catalog.md](catalog.md).

## Start
Run `ccm <mode>` (`ccm` alone is medium). Switch inside a session with `/mode <mode>`. Extra args go to claude:
`ccm high -c`. Full flags are in [modes.md](modes.md).

| Mode | Lead model | Pick it when | Cost note |
| ---- | ---------- | ------------ | --------- |
| `normal` | Opus 5.5, effort high | Small or routine work; you want the week to last | Up to 2 agents at once, terse reports |
| `medium` | Opus 5.5, effort high | Default for most tasks | Up to 3 agents; a workflow only after you say yes |
| `high` | Opus 5.5, effort high | Wide, multi-part tasks where speed matters | Up to 6 agents, workflows on its own; more usage |
| `extra-high` | Opus 5.5, effort max | Architecture, hard bugs, risky or final reviews, security | Max effort on the lead and important agents |
| `ultra-high` | Fable 5.2, effort high | The hardest work; Fable decides, others do the work | Fable is capped at 50% of the weekly limit |

Fable cap: when `ultra-high` reports the limit, exit and run `ccm extra-high -c` to continue the same conversation on
Opus. Keep extra usage off in claude.ai so nothing can bill credits. For the hardest work only:
`CCM_LEAD_EFFORT=xhigh ccm ultra-high`.

## A normal task
- One task per session. For an unrelated next task, `/clear` or start a new session first.
- The lead plans, decides and delegates: `scout` reads, `runner` runs checks, `implementer` writes code, `reviewer`
  and `security-auditor` review. Technical choices are made and stated in one line; owner decisions are asked.
- Gates: targeted checks once after the last edit (through `runner`); `reviewer` for a non-trivial change, plus
  `security-auditor` for a risky one; `ui-quality-pass` for UI; then `verify-done`.
- The final answer says what changed and what was not run. No recap of the process.

## Long or unattended runs
- A terminal question that nobody answers auto-continues after 60 s and Claude takes the recommended option. The timer
  pauses while that terminal window is focused, after a keypress, and with Remote Control on. Click another app before
  you leave. The recommended option is chosen to be safe with nobody there, and each default taken is logged.
- Guard dialogs (`git push`, publish, `rm -rf` outside the project, prod-host writes, literal secrets) default to
  Allow and go ahead after 180 s (`CLAUDE_ASK_TIMEOUT_S`); a secret-only ask after 30 s. A click on Deny blocks
  for good. A command Claude can rewrite (a `$VAR` command word, `rm`/`push` inside `$(...)` or a heredoc, a literal
  secret) is first sent back to Claude once with the fix, so no dialog waits; the message also names what will still
  ask after the rewrite (a push, an `rm` outside the project ...), and sent again unchanged, it gets the dialog. A
  secret sent back this way shows you no dialog, so Claude names its kind in the final report: rotate it if needed.
  Every ask and its outcome is in `~/.claude/logs/guard.jsonl`.
- Watch a run from a second session: `node ~/.claude/tools/watch/watch.mjs <session-id>` under the Monitor tool; it
  prints one line per event that needs action and flags a stall. See its README (`home/tools/watch/README.md`).
  With `--exit-on-event` in a background command it prints the first such event and exits, so a quiet hour costs the
  lead no turns. A session that only finished its turn and waits for its owner is not a stall: add `idle` to the
  class list (`--exit-on-event owner,idle`) to be told, otherwise it stays quiet. Idle is only told for a session whose process is registered
  (watch by session id, not by file path); in any doubt the silence is still a stall.
- A run that must survive a dropped connection starts a watch on its own session id with
  `--exit-on-event api-error,stall,limit`; when the watch exits, the run is woken and carries on.
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

## Keeping context
- Auto-compaction runs at a 400000-token window (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`); the status line shows the
  context size. Run `/compact` at a natural seam, not mid-step.
- Multi-day work: keep `STATUS.md` (decisions, vocabulary, a `## Work items` table); the lead re-reads its first 60 lines
  after a compaction and takes every estimate from `node ~/.claude/tools/estimate/estimate.mjs STATUS.md`.
- A detail from an earlier session or before a compaction: `recall`
  (`node ~/.claude/tools/recall/recall.mjs "<terms>"`, add `--session current` after a compaction).
- Phase change, repeated compactions or `/clear`: run the `handoff` skill, then `/clear` and say
  "continue from HANDOFF.md".
- Start a fresh session for an unrelated task, or when context is large and the next step is a new phase.

## At a usage limit
Wait for the subscription reset. Never turn on credits, `/fast`, or `/code-review ultra`. In `ultra-high`, a Fable
cap means `ccm extra-high -c`, not credits.

## After changing the setup
- Skills, agents, rules, standards, hooks, tools and modes are live through symlinks: new edits apply at once, and
  hook scripts run fresh on each call.
- Settings, hooks config, CLAUDE.md, agents and plugins are read when a session starts, and the lead rules load at
  start: restart open sessions (`/exit`, then `claude -c`).
- `~/.claude/settings.json` is a merged copy: change `settings/base.json`, then re-run `scripts/install.sh`.
- Because the repo is live in every session, edit hooks and tools in a git worktree and merge when the suite is
  green.

## Another machine
`git pull`, then `scripts/install.sh` (Windows PowerShell:
`powershell -ExecutionPolicy Bypass -File scripts\install.ps1`). Run `scripts/doctor.sh` to check.

On Windows without Developer Mode the installer copies files instead of linking them, so they do not follow later
edits: re-run the installer after every pull. Not yet tested on Windows: `install.ps1` has not been run there, the
guard tests have not been run there (`tests/pin-home.mjs` and the warm-exec fakes assume POSIX scripts), and
`doctor.sh` needs Git Bash and `jq` (there is no PowerShell doctor).

## Where things are
- Reports from agents and audits: `~/Desktop/claude-setup-reports/`.
- Guard log: `~/.claude/logs/guard.jsonl`.
- What exists: [catalog.md](catalog.md). Problems: [troubleshooting.md](troubleshooting.md).
