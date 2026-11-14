# How this setup works (no AI needed to read it)

This repo configures Claude Code: the rules it follows, the helper programs it runs, and the small scripts that watch
what it does. Everything is plain text and Node scripts. You can read, change and switch off any part by hand.

## What each folder holds

| Folder | What is in it |
| ------ | ------------- |
| `home/` | The content that gets linked into `~/.claude`. Editing a file here changes every running session at once. |
| `home/CLAUDE.md` | The global instructions every session reads (language, quality gates, token habits, safety). |
| `home/rules/` | One-line rules, `id | rule | check`. `core.md` is always on; the others apply to matching file paths. |
| `home/standards/` | The longer reference behind the rules, with examples (for human readability: `readability.md`). |
| `home/skills/` | Step-by-step workflows (`<name>/SKILL.md`) that Claude loads when the task matches. |
| `home/agents/` | Helper roles (reviewer, implementer, architect, ...), one file each, with their model and limits. |
| `home/hooks/` | Node scripts Claude Code runs on events (before a Bash command, when a session stops, ...). |
| `home/modes/` | Playbooks for the five modes (`normal` to `ultra-high`) and `_lead.md`, the lead's routing rules. |
| `home/tools/` | Command-line tools with their own README (`readable`, `ui-check`, `ui-coverage`, `recall`, ...). |
| `settings/` | `base.json` plus one file per OS. They are merged into `~/.claude/settings.json`. |
| `plugins/` | The list of plugins to install. |
| `scripts/` | `install.sh`, `install.ps1` and `doctor.sh`. |
| `tests/` | The test suite (`node:test`). |
| `docs/` | The documents for people. Start with `catalog.md` for a list of everything. |

## How one prompt flows

1. You start Claude with `ccm <mode>`. The `mode.mjs` hook prints the mode's playbook and the lead rules.
2. `skill-router.mjs` reads your prompt and names the skills that fit (for example `verify-done` for "done").
3. Claude reads `home/CLAUDE.md` and the rules whose paths match the files it works on.
4. The lead hands work to agents from `home/agents/`. Each agent file lists its model, tools and size limits.
5. Before each Bash command, `pre-bash-guard.mjs` checks it. Risky commands (push, `rm -rf`, secrets) open a dialog.
6. After each edit, `post-edit.mjs` runs the project's formatter and lint. When an agent stops, `typecheck-gate.mjs`
   typechecks what it edited.
7. At the end the Stop hooks check the reply against any size cap you gave.

The hook list with exact triggers is in `docs/catalog.md` (section Hooks) and `home/hooks/README.md`.

## Where each kind of rule lives, and how to change one

| You want to change | Edit | Then |
| ------------------ | ---- | ---- |
| A rule every session follows | `home/rules/core.md` (one line, keep the id) | update `docs/catalog.md` if the id range changes |
| A rule for some file types | `home/rules/<area>.md` (`paths:` in the frontmatter) | run the tests |
| The long explanation of a rule | `home/standards/<area>.md` | none |
| How a helper role behaves | `home/agents/<name>.md` | update its row in `docs/catalog.md` |
| A workflow | `home/skills/<name>/SKILL.md` | update its row in `docs/catalog.md` |
| A permission or hook wiring | `settings/base.json` (or the OS file) | run `scripts/install.sh` to rebuild `~/.claude/settings.json` |

Edit in a git worktree, not the main checkout: the files are live in every session. Details: `CLAUDE.md` (this repo's
own rules) and `docs/daily-use.md`.

## Turn a hook off by hand

- One hook, until you re-run the installer: open `~/.claude/settings.json`, find the `command` that names the script
  (for example `pre-bash-guard.mjs`) and delete that entry from its `hooks` list.
- One hook, for good: delete the same entry from `settings/base.json` and run `scripts/install.sh`.
- Some hooks have a switch: `CLAUDE_SKILL_ROUTER=off` turns the skill router off; `CLAUDE_POST_EDIT_SKIP=typecheck`
  (or `all`) skips the typecheck gate.

## Read the guard log

Every question the Bash guard asked, and the answer, is one JSON line in `~/.claude/logs/guard.jsonl`
(`CLAUDE_GUARD_LOG` changes the path). Show the last lines with `tail -n 20 ~/.claude/logs/guard.jsonl`. The outcomes are
allow, deny, timeout, no-gui and dialog-failed. The log never stores secrets. What the guard asks about is in
`docs/troubleshooting.md`.

## Run the tests

From the repo root:

    node --test tests/*.test.mjs

Never run bare `node --test`. The `ui-check` tool has its own tests: `pnpm --dir home/tools/ui-check test`. The
pre-commit hook runs the suite and gitleaks, so a commit with a failing test is refused.

## Check a project for readability

    node ~/.claude/tools/readable/readable.mjs check <project-folder> --changed

It lists folders with no README, names like `utils`, files with no header comment and uncommented config keys. Its README
is `home/tools/readable/README.md`; the reasons are in `home/standards/readability.md`.

## Install on another machine

    git clone <repo> ~/Desktop/claude-setup && cd ~/Desktop/claude-setup
    scripts/install.sh --dry-run        # preview
    scripts/install.sh                  # macOS, Linux, Git Bash

On Windows use `powershell -ExecutionPolicy Bypass -File scripts\install.ps1`. Existing files are moved to
`~/.claude-backup-<stamp>/`, never deleted. Put machine-only settings in `settings/local.json` (copy
`settings/local.json.example`). Check the result with `scripts/doctor.sh`. Full steps: `docs/setup.md`.
