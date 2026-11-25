# Editing the setup

## Workflow
Edit in `~/.claude/...` or in `home/...` (the same files, via symlinks) -> `git add` -> check the staged changes and the
message by hand (`gitleaks git --staged --redact --verbose`, `node scripts/share-check.mjs --staged`, and
`node scripts/share-check.mjs --commit-msg <file>` on the message in a file; `CLAUDE.md` has the steps) -> `git commit`
(Conventional Commits). Never `git push` unless the owner says so. On another machine: `git pull`, then `scripts/install.sh`
only if `settings/`, `plugins/` or a tool's dependencies changed. When something looks off, ask `tess` for a setup check.

Keep every file valid at each commit: the files are live in every Claude session on this machine.

## Add a skill
1. `home/skills/<name>/SKILL.md` with frontmatter `name` and a one-line `description` that starts "Use when ..." or
   "Use for ..." and stays near 200 characters (it is loaded in every session). Optional: `model`,
   `disable-model-invocation: true` for slash-command-only skills.
2. Body: numbered steps, a done-gate, rule ids it enforces; link a `standards/` file instead of inlining long reference.
3. The catalog row comes from that frontmatter: `docs/catalog.md` is generated and git-ignored, so you do not edit it. Install
   writes it; `node scripts/catalog.mjs write` rebuilds it by hand, and `node scripts/catalog.mjs check` names each file that
   lacks its description line and exits 1.

## Add an agent
`home/agents/<name>.md` with frontmatter `name`, `description` ("Use when ..." or "Use for ...", near 200 characters), `model` (alias `haiku`, `sonnet` or `opus`, or a full id such as `claude-opus-5-5`), `effort`,
optional `tools`/`disallowedTools`. State what it returns and a size cap. Add a routing line to
`home/CLAUDE.md` if it changes who does what. A main agent (only the boss starts it) is also named in the "Only the boss starts" line of
`home/CLAUDE.md`. Its catalog row comes from the same frontmatter (see "Add a skill", step 3). No `maxTurns`: at the cap the agent stops and returns a partial result that has to be resumed; keep it focused through its prompt instead.

## Add a rule
`home/rules/<area>.md`: frontmatter `paths: [globs]` (omit for always-on), then one line per rule starting with its `ID`.
Put long examples in `home/standards/<area>.md`. Use a new id prefix or continue the existing numbering.

## Add a tool
`home/tools/<name>/` with its own `README.md` (its first line after the heading is the catalog description) and `package.json`; the folder is already linked via `tools`. Dependencies
go in that package.json and its lockfile (committed); `node_modules/` is gitignored. Extend `install_tool_deps` in the
installers if it needs an install step.

## Commits
Small and atomic. Types in use: `feat`, `fix`, `docs`, `refactor`, `chore`. Never `--no-verify`.
