# Modes

Five setup modes trade parallelism, token thrift and lead strength against speed. Default is `medium` (the setup as `home/CLAUDE.md`
describes it). Every session has its own mode; nothing a mode does touches machine-wide state or other sessions.

## Launch

    ccm                 # medium (new session), or a resumed session's saved mode
    ccm normal          # thrift
    ccm high -c         # full speed, extra args go to claude
    ccm extra-high      # high + lead Opus 5.5 at max (claude --model opus --effort max)
    ccm ultra-high -c   # high + lead Fable 5.2 at max (claude --model fable --effort max)

`ccm <mode>` runs `claude` with `CLAUDE_MODE=<mode>` and, for extra-high and ultra-high only, the lead flags above;
`ccm` without a mode word runs plain `claude`. Mode words are case-insensitive.
A first word that is neither a mode nor a flag is an error (typo guard); to pass a prompt, name the mode first:
`ccm medium "fix the login bug"`. It passes no settings.
`CCM_DRY_RUN=1 ccm high` prints the command instead of running it. `scripts/install.sh` links `ccm` to
`~/.local/bin/ccm` (macOS, Linux and Git Bash, where it is copied; keep `~/.local/bin` on PATH).

Windows: in Git Bash run `ccm <mode>` as above. In PowerShell or cmd run `ccm <mode>` (resolved to `ccm.cmd`, which needs no execution-policy change);
`scripts\install.ps1` installs `ccm.cmd` in `~/.claude/bin` (on the user PATH) and `ccm.ps1` in `~/.claude/bin/ps/` (not on PATH, so PowerShell resolves `ccm` to the shim; new terminals see the PATH).
It behaves the same, including `CCM_DRY_RUN=1`.

## Switch in a session

`/mode normal|medium|high|extra-high|ultra-high` (also `/mode extra high`) records the mode in this session's state file (`~/.claude/state/modes/<session>`, pruned
after 14 days) and injects the playbook. Launch and switch behave identically. `/mode` alone shows the active mode.
Other sessions are not affected. The mode survives `/compact` and (macOS/Linux) `/clear`; on Windows `/clear` falls
back to the launch mode. A resumed session (`claude -c`, `--resume`, `ccm -c`) keeps its saved mode; `ccm <mode> -c`
resumes it in that mode instead. In a window started with `ccm <mode>`, `/resume` also opens the session in that
mode; use `/mode` to change it.

The lead model and effort cannot be changed by a hook, and `/model <x>` inside a session saves machine-wide. So
extra-high and ultra-high set the lead at launch with `ccm`. A `/mode` switch into them (unless this window was
launched with `ccm <mode>`), or a start not launched with `ccm <mode>` or whose model does not match, makes the hook add a note telling you to run `ccm <mode> -c`; a switch out of them says the lead is still
at max and to run `ccm <mode> -c` to return it to Opus 5.5 at high.

## Same in every mode

Per-task model and effort (agent pins and the escalation rules in `home/CLAUDE.md`); the quality gates (tests,
`runner` checks, `reviewer`, `security-auditor`, `verify-done`). normal, medium and high keep the lead at Opus 5.5 at
effort high and change only parallelism, workflows and report brevity; extra-high and ultra-high also change the lead
and add the Opus-max escalations.

## What differs

A workflow is a script that runs many agents in phases.

| Mode | Lead (main session) | Important jobs | Parallel agents | Workflows | Reports |
| ---- | ------------------- | -------------- | --------------- | --------- | ------- |
| normal | Opus 5.5, effort high | pinned agents + CLAUDE.md escalations | up to 3 at once, based on need | only when you ask for one in your message; up to 4 agents | terse; `/compact` only when context is large; no speculative work |
| medium | Opus 5.5, effort high | same | independent work in parallel | Claude may propose one and say roughly what it costs; starts only after you say yes; up to 9 agents | as `CLAUDE.md` |
| high | Opus 5.5, effort high | same | wide fan-out: parallel research, one `deep-debugger` per hypothesis, test-writer + implementer, split parts, reviewer + security-auditor | Claude starts one itself for substantive multi-part tasks, no size limit | same short final answer as medium; detail goes to files |
| extra-high | Opus 5.5, effort max | architecture/planning, hard or failed-once bugs, risky or final reviews, security audits, risky code, key decisions: agents with `model: "opus", effort: "max"` | as high | as high | as high |
| ultra-high | Fable 5.2, effort max | as extra-high (Opus 5.5 at max) | as high | as high | as high |

A risky or final review means auth, data or migrations, money, concurrency, security, and the last review before a
merge or push. In extra-high and ultra-high these go to Opus at max.

Choosing `ccm high|extra-high|ultra-high` or `/mode` with one of them is your standing request for workflows. If
Claude still asks first, answer "use a workflow" once.

## Subscription only

No mode spends usage credits: no fast mode (`/fast`), no `/code-review ultra` or ultrareview. Speed in `high` comes
only from parallel agents and workflows. At a usage limit Claude waits for the subscription reset
(`autoContinueAtUsageLimit`).

Fable 5.2 (ultra-high) is included only on Max, Ultra and Team Premium plans, capped at 50% of the weekly limit; past
the cap, or on Pro, it bills usage credits. Keep extra usage turned off in your claude.ai settings; then
nothing can bill credits. When Fable's cap is reached the CLI reports the limit: exit and continue the same
conversation with `ccm extra-high -c` (Opus still has the rest of your weekly limit).

Files: `home/modes/` (playbooks), `home/bin/ccm`, `home/bin/ccm.ps1`, `home/hooks/mode.mjs`, `home/skills/mode`,
`tests/mode.test.mjs`, `tests/ccm.test.mjs` (`node --test tests/*.test.mjs`).
