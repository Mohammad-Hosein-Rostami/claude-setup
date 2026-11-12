# Modes

Three setup modes trade speed against token thrift. Default is `medium` (the setup as `home/CLAUDE.md` describes it).

## Launch

    ccm                 # medium
    ccm normal          # thrift
    ccm high -c         # full speed, extra args go to claude

`ccm` runs `claude [--settings ~/.claude/modes/<mode>.json]` with `CLAUDE_MODE=<mode>`. It never sets effort.
`CCM_DRY_RUN=1 ccm high` prints the command instead of running it. `scripts/install.sh` links `ccm` to
`~/.local/bin/ccm` (bash only; not linked on Windows).

## Switch in a session

`/mode normal|medium|high` records the mode for the session, writes `fastMode` in `~/.claude/settings.json`
(hot-reloaded) and injects the playbook. Nothing is left to type. `/mode` alone shows the active mode. The hook also
syncs fast mode on session startup and resume.

## Same in every mode

Lead = Opus 5.5 at effort high; per-task model and effort (agent pins and the escalation rules in `home/CLAUDE.md`);
the quality gates (tests, `runner` checks, `reviewer`, `security-auditor`, `verify-done`). Modes change only speed and
token thrift.

## What differs

| Mode | Fast mode | Parallelism | Workflows | Reports |
| ---- | --------- | ----------- | --------- | ------- |
| normal | off | one agent at a time unless two are independent and needed now | only when asked; size small (<5) | terse; `/compact` at every seam; no speculative work |
| medium | off | independent work in parallel | on opt-in; size medium (<10) | as `CLAUDE.md` |
| high | on (auto) | wide fan-out: parallel research, one `deep-debugger` per hypothesis, test-writer + implementer, split parts, reviewer + security-auditor | authorized; unrestricted size | not capped |

## Cost and caveats

- Fast mode bills usage credits. `high` turns it on; other modes remove the key.
- `fastMode` is machine-wide: the last writer wins, so two sessions in different modes overwrite each other. A plain
  `claude` start (no `ccm`, no `/mode`) leaves it alone, so a manual `/fast` survives. A CLI write to settings.json in
  the same few milliseconds as the hook's can be lost (accepted).
- `ccm high` also launches with ultracode (`high.json`): standing workflow orchestration at the current effort, not
  a higher effort. It cannot be turned off mid-session, so after `/mode medium`
  or `normal` the hook tells the model not to start workflows unless asked; restart with `ccm <mode>` to drop it.
- `scripts/doctor.sh` ignores `fastMode` when checking settings drift; `install.sh` carries it over on reinstall.

Files: `home/modes/` (playbooks, settings layers), `home/bin/ccm`, `home/hooks/mode.mjs`, `home/skills/mode`,
`tests/mode.test.mjs` (`node --test tests/*.test.mjs`).
