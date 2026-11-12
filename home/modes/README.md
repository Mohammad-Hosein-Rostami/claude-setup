# modes

Setup modes: normal (thrift), medium (default), high (full speed). They change only parallelism, workflows and report
brevity, and each applies to one session only.

- `<mode>.md`: playbook injected into the session by `hooks/mode.mjs` (SessionStart and `/mode <m>`).
- No settings layers: the mode is the per-session state file plus `CLAUDE_MODE`; nothing machine-wide
  is written. Subscription usage only.
- Read by `home/bin/ccm` (launcher) and `home/hooks/mode.mjs` (hook). Linked as `~/.claude/modes`.

How to use: [docs/modes.md](../../docs/modes.md).
