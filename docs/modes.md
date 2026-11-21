# Modes

Five setup modes trade parallelism and lead strength against usage. Every mode runs the same rules and checks, including risky or final review on Opus at max; the modes differ in the lead model and effort, writing agents at once, Fable-max escalation and report length. Default is `medium` (the setup as `home/CLAUDE.md` and
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
`ccm` sets the lead at launch for every mode (Opus 5.5 at high for normal/medium/high). A `/mode` switch into extra-high or ultra-high (unless this window was
launched with `ccm <mode>`), or a start not launched with `ccm <mode>` or whose model does not match (for normal/medium/high: a known model that is not Opus), makes the hook add a note telling you to run `ccm <mode> -c`; a switch out of them says the lead is still
at its launch effort and to run `ccm <mode> -c` to return it to Opus 5.5 at high.

## Same in every mode

Per-task model and effort (agent pins and the escalation rules in `home/modes/_lead.md`); the quality gates (tests,
`runner` checks, `reviewer`, `security-auditor`, `verify-done`, `ui-quality-pass`, `visual-qa`, `ui-coverage`, the findings check and the judge models), and risky or final review and security audit on Opus at max. normal, medium and high lead on Opus 5.5 at
effort high (`ccm` pins it, so a resume of a Fable session returns to Opus) and change only parallelism and report brevity; extra-high and ultra-high change the lead
and add the Opus-max escalations for architecture, hard bugs and risky code (Fable max in ultra-high).

## What differs

A workflow is a script that runs many agents in phases; the lead uses one only when the job needs it (below).

| Mode | Lead (main session) | Important jobs | Writing agents at once | Workflows | Reports |
| ---- | ------------------- | -------------- | --------------- | --------- | ------- |
| normal | Opus 5.5, effort high | pinned agents + lead-rule escalations | up to 2 at once (lane budget) | by the job (see below) | terse; `/compact` only when context is large |
| medium | Opus 5.5, effort high | same | up to 3 at once, independent work in parallel | by the job (see below) | as the lead rules and `CLAUDE.md` |
| high | Opus 5.5, effort high | same | up to 6 at once; wide fan-out: parallel research, one `deep-debugger` per hypothesis, test-writer + implementer, split parts, reviewer + security-auditor | by the job (see below) | same short final answer as medium; detail goes to files |
| extra-high | Opus 5.5, effort max | architecture/planning, hard or failed-once bugs, risky or cross-module code, key decisions: agents with `model: "opus", effort: "max"` | as high (up to 6) | as high | as high |
| ultra-high | Fable 5.2, effort high (`CCM_LEAD_EFFORT` overrides) | Fable decides and delegates; hard problems to `architect` / `deep-debugger` with `model: "fable", effort: "max"`; risky or cross-module code to Opus 5.5 at max; the `agent-model-guard.mjs` hook moves Explore to Sonnet and Plan to Opus (every mode) when no model is given | as high, up to 8 at once | as high | as high |

Every mode: a parallel request first gets a one-line usage-limit forecast.

A risky or final review means auth, data or migrations, money, concurrency, security, and the last review before a
merge or push. In every mode these go to Opus at max (`reviewer`, `security-auditor`).

In every mode the lead picks inline, one background agent or a workflow by the job (`home/CLAUDE.md`, "Inline, agent or
workflow"); a workflow is started through the `workflows` skill (one section per workflow) listed in [workflows](../home/workflows/README.md). Landing and machine sync always run their workflow, whatever the size; bugfix and git cleanup run theirs when the job needs it (a bug that survived one fix, a tangle or several repos). A mode limits only the agents that write at once; reads, reviews and
verifiers are not capped by the mode.

## Picks per step (same in every mode)

Reviews, verifiers, judges, tests and runners use the same model and effort in every mode. A mode changes cost and speed,
never a gate. Extra-high starts the first try of architect, deep-debugger and a risky implementer one rung higher (never lower).

| Step | Model / effort | Escalate |
| ---- | -------------- | -------- |
| Plan, design | lead inline; `architect` Opus high | xhigh when hard or security-critical; max as tie-break |
| Build: implementer, test-writer | Sonnet medium; implementer high for cross-module code; Opus high for lock or transaction code | two failed verify rounds: one rung up |
| Runner steps (tier, join, suite, rebase, land, status, sync, cleanup) | Haiku medium; the script judges the exit codes | unclassified failure: Sonnet medium diagnoses |
| Review: correctness lens | `reviewer` Sonnet high | |
| Review: risk lens (risky class or landing) | `reviewer` Opus max | |
| Review: extra lens (over 400 lines, concurrency-lite, mid-lane) | `reviewer` Opus high | risky class: max |
| Review: audit | `security-auditor` Opus max for security, data, money, untrusted input, concurrency with security, and at every landing; Opus high for a hooks-only change mid-lane | `exploitable: unknown`: max audit of those lines |
| Review: verifier (per 5 findings) | same model and effort as the finder at least | `real: false` from a weaker model, or verifier and finder disagree: Opus max judge; security findings are never dropped |
| Review: fix | `implementer` Sonnet high; Opus high for concurrency findings | blocking twice in one area: `deep-debugger` |
| Bugfix: hypotheses, judge | `deep-debugger` Opus high; judge Opus xhigh | failed fix: xhigh, then max |
| Research: scope, synthesis, critic | Opus high | |
| Research: gatherers, re-checks, patches | Sonnet high | |
| Quick lookup | `/quick` (scout, Haiku medium) | needs judgement: the `step` workflow with `scout` Sonnet |
| One-step work (architect design, UI build, visual-qa final gate) | the `step` workflow: the agent file's model and effort | |
| Git cleanup plan | Sonnet high | owner items go to the lead |

| Mode | Writing agents at once | Lead | First try one rung higher (cost only) |
| ---- | ---------------------- | ---- | -------------------------------------- |
| normal | 2 | Opus high | |
| medium | 3 | Opus high | |
| high | 6 | Opus high | |
| extra-high | 6 | Opus max | architect, deep-debugger, risky implementer start at Opus max |
| ultra-high | 8 | Fable high | hard design or bug starts at Fable max |

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
