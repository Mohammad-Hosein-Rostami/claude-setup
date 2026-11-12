# Modes

Three setup modes trade cost against force. Default is `medium` (the setup as `home/CLAUDE.md` describes it).

## Launch

    ccm                 # medium
    ccm normal          # economy
    ccm high -c         # full force, extra args go to claude

`ccm` runs `claude --effort <effort> [--settings ~/.claude/modes/<mode>.json]` with `CLAUDE_MODE=<mode>`.
`CCM_DRY_RUN=1 ccm high` prints the command instead of running it. `scripts/install.sh` links `ccm` to
`~/.local/bin/ccm` (bash only; not linked on Windows).

## Switch in a session

`/mode normal|medium|high` records the mode for the session and injects its playbook. Effort, fast mode and the forced
Opus subagent model are fixed at launch, so the hook also prints the switches you still type (`/effort ...`, `/fast`).
`/mode` alone shows the active mode. Restart with `ccm <mode>` to get every switch.

## What each mode changes

| Mode | Effort | Subagent model | Workflows | Checks | Reviews |
| ---- | ------ | -------------- | --------- | ------ | ------- |
| normal | medium | Sonnet 5.5 (Haiku for lookups) | none; size `small` | only those asked + post-edit hook | risky changes only |
| medium | high | Sonnet 5.5, Haiku mechanical | on opt-in | as asked | reviewer + verify-done after non-trivial changes |
| high | ultracode (xhigh) | Opus 5.5 at high, forced | unrestricted, used for substantive tasks | full suite, e2e, run the app | reviewer, security-auditor, `/code-review max`, repeat until clean |

## Cost

`high` turns on fast mode (bills usage credits) and ultracode (standing workflows at xhigh), and forces Opus on all
subagents: expect much higher spend. `autoContinueAtUsageLimit` (base settings) keeps a run going past a usage limit.

Files: `home/modes/` (playbooks, settings layers), `home/bin/ccm`, `home/hooks/mode.mjs`, `home/skills/mode`.
