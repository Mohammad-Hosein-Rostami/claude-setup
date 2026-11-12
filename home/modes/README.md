# modes

Setup modes: normal (thrift), medium (default), high (full speed), extra-high (high plus lead Opus 5.5 at max) and
ultra-high (high plus lead Fable 5.2 at max). normal/medium/high change only parallelism, workflows and report
brevity; extra-high/ultra-high also change the lead and send important jobs to Opus at max. Each applies to one
session only.

- `_lead.md`: lead-only rules (modes, model routing, delegation), printed before the playbook at SessionStart.
- `<mode>.md`: playbook injected into the session by `hooks/mode.mjs` (SessionStart and `/mode <m>`).
- No settings layers: the mode is the per-session state file plus `CLAUDE_MODE`; nothing machine-wide
  is written. Subscription usage only.
- Read by `home/bin/ccm` and `home/bin/ccm.ps1` (launchers, set the lead flags) and `home/hooks/mode.mjs` (hook). Linked as `~/.claude/modes`.

How to use: [docs/modes.md](../../docs/modes.md).
