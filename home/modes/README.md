# modes

Setup modes: normal (thrift), medium (default), high (full speed). They change only speed and tokens.

- `<mode>.md`: playbook injected into the session by `hooks/mode.mjs` (SessionStart and `/mode <m>`).
- `normal.json`, `high.json`: extra settings layered over the base by `ccm` through `claude --settings`
  (workflow size; high also sets ultracode). Medium has none: it is the base settings.
- Fast mode is not here: the hook writes `fastMode` into `~/.claude/settings.json` (on for high only).
- Read by `home/bin/ccm` (launcher) and `home/hooks/mode.mjs` (hook). Linked as `~/.claude/modes`.

How to use: [docs/modes.md](../../docs/modes.md).
