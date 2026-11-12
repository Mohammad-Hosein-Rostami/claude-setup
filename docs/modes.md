# Modes

Three setup modes trade parallelism and token thrift against speed. Default is `medium` (the setup as `home/CLAUDE.md`
describes it). Every session has its own mode; nothing a mode does touches machine-wide state or other sessions.

## Launch

    ccm                 # medium (new session), or a resumed session's saved mode
    ccm normal          # thrift
    ccm high -c         # full speed, extra args go to claude

`ccm <mode>` runs `claude` with `CLAUDE_MODE=<mode>` and nothing else; `ccm` without a mode word runs plain `claude`.
A first word that is neither a mode nor a flag is an error (typo guard); to pass a prompt, name the mode first:
`ccm medium "fix the login bug"`. It never sets effort and passes no settings.
`CCM_DRY_RUN=1 ccm high` prints the command instead of running it. `scripts/install.sh` links `ccm` to
`~/.local/bin/ccm` (bash only; not linked on Windows).

## Switch in a session

`/mode normal|medium|high` records the mode in this session's state file (`~/.claude/state/modes/<session>`, pruned
after 14 days) and injects the playbook. Launch and switch behave identically. `/mode` alone shows the active mode.
Other sessions are not affected. The mode survives `/compact` and (macOS/Linux) `/clear`; on Windows `/clear` falls
back to the launch mode. A resumed session (`claude -c`, `--resume`, `ccm -c`) keeps its saved mode; `ccm <mode> -c`
resumes it in that mode instead. In a window started with `ccm <mode>`, `/resume` also opens the session in that
mode; use `/mode` to change it.

## Same in every mode

Lead = Opus 5.5 at effort high; per-task model and effort (agent pins and the escalation rules in `home/CLAUDE.md`);
the quality gates (tests, `runner` checks, `reviewer`, `security-auditor`, `verify-done`). Modes change only
parallelism, workflows and report brevity.

## What differs

A workflow is a script that runs many agents in phases.

| Mode | Parallel agents | Workflows | Reports |
| ---- | --------------- | --------- | ------- |
| normal | up to 3 at once, based on need | only when you ask for one in your message; up to 4 agents | terse; `/compact` at every seam; no speculative work |
| medium | independent work in parallel | Claude may propose one when it clearly helps and says roughly what it costs; starts only after you say yes; up to 9 agents | as `CLAUDE.md` |
| high | wide fan-out: parallel research, one `deep-debugger` per hypothesis, test-writer + implementer, split parts, reviewer + security-auditor | Claude starts one itself for substantive multi-part tasks, no size limit (choosing `ccm high` or `/mode high` is your standing request) | not capped |

## Subscription only

No mode spends usage credits: no fast mode (`/fast`), no `/code-review ultra` or ultrareview. Speed in `high` comes
only from parallel agents and workflows. At a usage limit Claude waits for the subscription reset
(`autoContinueAtUsageLimit`).

Files: `home/modes/` (playbooks), `home/bin/ccm`, `home/hooks/mode.mjs`, `home/skills/mode`,
`tests/mode.test.mjs` (`node --test tests/*.test.mjs`).
