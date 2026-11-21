# Check categories (`home/checks/`)

`categories.json` is the one list of check categories and each one's default (`"on"` or `"off"`), plus a `covers` line
that `/check` shows. Tests, type checks, reviews, UI checks and probes are off by default (owner, 2026-11-21: "make them
disable by default and only and only use them if i specificly ask for it"). The owner changes them per session with
`/check` (`home/skills/check/`), recorded in `~/.claude/state/checks/<session-id>.json` by `home/hooks/checks-switch.mjs`;
every gate asks `home/hooks/lib/checks-on.mjs` (`isOn`). A new category is a new entry here plus the gates that ask for it.
`smart` is the one category on by default (owner, 2026-11-21: "one category ON by default ... very selective ... very low
token usage"): `home/hooks/smart-check.mjs` at Stop runs the pinned scans and picks each check kind's level from the change
(`home/tools/smart-check/README.md`); `/check off smart` turns it off for the session, `/check <cat>` still adds a heavy category.
Always on, never a category: gitleaks on commit, the Bash guard, `node --check` of changed hook files.
