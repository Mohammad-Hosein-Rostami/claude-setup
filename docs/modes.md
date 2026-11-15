# Modes

Five setup modes trade parallelism and lead strength against usage. Every mode runs the same rules and checks, including risky or final review on Opus at max; the modes differ in the lead model and effort, agents at once, workflow start, Fable-max escalation and report length. Default is `medium` (the setup as `home/CLAUDE.md` and
`home/modes/_lead.md` describe it). Every session has its own mode; nothing a mode does touches machine-wide state or other sessions.

## Launch

    ccm                 # medium (new session), or a resumed session's saved mode
    ccm normal          # fewest agents
    ccm high -c         # full speed, extra args go to claude
    ccm extra-high      # high + lead Opus 5.5 at max (claude --model opus --effort max)
    ccm ultra-high -c   # high + lead Fable 5.2 at high (claude --model fable --effort high)
    CCM_LEAD_EFFORT=xhigh ccm ultra-high   # same, lead effort overridden (low|medium|high|xhigh|max)

`ccm <mode>` runs `claude` with `CLAUDE_MODE=<mode>` and, for extra-high and ultra-high only, the lead flags above;
`ccm` without a mode word runs plain `claude`. Mode words are case-insensitive.
`CCM_LEAD_EFFORT` (low|medium|high|xhigh|max) replaces the lead effort of extra-high and ultra-high only; any other value is a usage error (exit 2); the other modes ignore it.
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
at its launch effort and to run `ccm <mode> -c` to return it to Opus 5.5 at high.

## Same in every mode

Per-task model and effort (agent pins and the escalation rules in `home/modes/_lead.md`); the quality gates (tests,
`runner` checks, `reviewer`, `security-auditor`, `verify-done`, `ui-quality-pass`, `visual-qa`, `ui-coverage`, the findings check and the judge models), and risky or final review and security audit on Opus at max. normal, medium and high keep the lead at Opus 5.5 at
effort high and change only parallelism, workflows and report brevity; extra-high and ultra-high also change the lead
and add the Opus-max escalations for architecture, hard bugs and risky code (Fable max in ultra-high).

## What differs

A workflow is a script that runs many agents in phases.

| Mode | Lead (main session) | Important jobs | Parallel agents | Workflows | Reports |
| ---- | ------------------- | -------------- | --------------- | --------- | ------- |
| normal | Opus 5.5, effort high | pinned agents + lead-rule escalations | up to 2 at once (lane budget) | only when you ask for one in your message; up to 4 agents | terse; `/compact` only when context is large |
| medium | Opus 5.5, effort high | same | up to 3 at once, independent work in parallel | Claude may propose one and say roughly what it costs; starts only after you say yes; up to 9 agents | as the lead rules and `CLAUDE.md` |
| high | Opus 5.5, effort high | same | up to 6 at once; wide fan-out: parallel research, one `deep-debugger` per hypothesis, test-writer + implementer, split parts, reviewer + security-auditor | Claude starts one itself for substantive multi-part tasks, no size limit | same short final answer as medium; detail goes to files |
| extra-high | Opus 5.5, effort max | architecture/planning, hard or failed-once bugs, risky or cross-module code, key decisions: agents with `model: "opus", effort: "max"` | as high (up to 6) | as high | as high |
| ultra-high | Fable 5.2, effort high (`CCM_LEAD_EFFORT` overrides) | Fable decides and delegates; hard problems to `architect` / `deep-debugger` with `model: "fable", effort: "max"`; risky or cross-module code to Opus 5.5 at max; the `agent-model-guard.mjs` hook moves Explore to Sonnet and Plan to Opus (every mode) when no model is given | as high, up to 8 at once | as high | as high |

Every mode: a parallel request first gets a one-line usage-limit forecast.

A risky or final review means auth, data or migrations, money, concurrency, security, and the last review before a
merge or push. In every mode these go to Opus at max (`reviewer`, `security-auditor`).

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

Files: `home/modes/` (playbooks; `_lead.md` is the lead-only rules printed at SessionStart before the playbook), `home/bin/ccm`, `home/bin/ccm.ps1`, `home/hooks/mode.mjs`, `home/hooks/agent-model-guard.mjs`, `home/skills/mode`,
`tests/mode.test.mjs`, `tests/ccm.test.mjs`, `tests/agent-model-guard.test.mjs` (`node --test tests/*.test.mjs`).
