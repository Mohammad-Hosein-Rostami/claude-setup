# Daily use

## Workflow
Edit in `~/.claude/...` or in `home/...` (the same files, via symlinks) -> `git add` -> `git commit` (Conventional
Commits; the pre-commit hook runs gitleaks on staged changes and `node --check` on staged hook files). Never `git push` unless the owner says so. On another machine: `git pull`, then
`scripts/install.sh` only if `settings/`, `plugins/` or a tool's dependencies changed. Run `scripts/doctor.sh` when
something looks off.

Keep every file valid at each commit: the files are live in every Claude session on this machine.

## Add a skill
1. `home/skills/<name>/SKILL.md` with frontmatter `name` and a one-line `description` that starts "Use when ..."
   (the description is loaded in every session: keep it short), except explicit-invoke skills (`escalate`, `quick`,
   `handoff`, `token-audit`), which describe the command instead. Optional: `model`, `disable-model-invocation: true`
   for slash-command-only skills.
2. Body: numbered steps, a done-gate, rule ids it enforces; link a `standards/` file instead of inlining long reference.
3. Add the row to `docs/catalog.md` (edit by hand, copying the description verbatim from the frontmatter).

## Add an agent
`home/agents/<name>.md` with frontmatter `name`, `description` ("Use to ..."), `model` (alias `haiku`, `sonnet` or `opus`, or a full id such as `claude-opus-5-5`), `effort`,
optional `tools`/`disallowedTools`. State what it returns and a size cap. Add a routing line to
`home/CLAUDE.md` if it changes who does what. Add it to `docs/catalog.md`. No `maxTurns`: a turn cap stops the agent mid-task; keep it focused through its prompt instead.

## Add a rule
`home/rules/<area>.md`: frontmatter `paths: [globs]` (omit for always-on), then one line per rule starting with its `ID`.
Put long examples in `home/standards/<area>.md`. Use a new id prefix or continue the existing numbering.

## Add a tool
`home/tools/<name>/` with its own `README.md` and `package.json`; the folder is already linked via `tools`. Dependencies
go in that package.json and its lockfile (committed); `node_modules/` is gitignored. Extend `install_tool_deps` in the
installers if it needs an install step, and `doctor.sh` if it has external requirements.

## Commits
Small and atomic. Types in use: `feat`, `fix`, `docs`, `refactor`, `chore`. Never `--no-verify`; the guard hook blocks it.
