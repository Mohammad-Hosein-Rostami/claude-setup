# modes

Setup modes: normal (economy), medium (default), high (full force).

- `<mode>.md`: playbook injected into the session by `hooks/mode.mjs` (SessionStart and `/mode <m>`).
- `normal.json`, `high.json`: extra settings layered over the base by `ccm` through `claude --settings`.
  Medium has none: it is the base settings.
- Read by `home/bin/ccm` (launcher) and `home/hooks/mode.mjs` (hook). Linked as `~/.claude/modes`.

How to use: [docs/modes.md](../../docs/modes.md).
