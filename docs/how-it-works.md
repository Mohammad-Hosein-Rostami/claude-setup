# How this setup works (no AI needed to read it)

This repo configures Claude Code: the rules it follows, the helper programs it runs, and the small scripts that watch
what it does. Everything is plain text and Node scripts. You can read, change and switch off any part by hand.

## What each folder holds

| Folder | What is in it |
| ------ | ------------- |
| `home/` | The content that gets linked into `~/.claude`. Editing a file here changes every running session at once. |
| `home/CLAUDE.md` | The global instructions every session reads (language, checks, token habits, safety). |
| `home/rules/` | One-line rules, each with an id. `core.md` is always on; the others apply to matching file paths. |
| `home/standards/` | The longer reference behind the rules, with examples (for human readability: `readability.md`). |
| `home/skills/` | Step-by-step workflows (`<name>/SKILL.md`) that Claude loads when the task matches. |
| `home/agents/` | Helper roles (implementer, architect, runner, ...), one file each, with their model and limits. |
| `home/project-notes/` | One note file per project, read through that project's uncommitted `CLAUDE.local.md`. |
| `home/hooks/` | Node scripts Claude Code runs on events (before a Bash command, when a session stops, ...). |
| `home/lead-rules.md`, `home/lead.md` | The lead's rules (model routing, delegation, job form), printed to the main session at start. |
| `home/tools/` | Command-line tools with their own README (`ui-check`, `ui-coverage`, `recall`, ...). |
| `settings/` | `base.json` plus one file per OS. They are merged into `~/.claude/settings.json`. |
| `plugins/` | The list of plugins to install. |
| `tools/` | System programs to install (`Brewfile`, `windows-tools.ps1`); not the same as `home/tools/`. |
| `.githooks/` | The pre-commit hook: gitleaks on the staged changes and `node --check` of each staged hook file. It only runs after `scripts/install.sh` sets `core.hooksPath`. |
| `scripts/` | `install.sh`, `install.ps1` and `doctor.sh` (its check groups are in `scripts/doctor/`). |
| `tests/` | The test suite (`node:test`); the done-check runs the tests related to a change, the whole suite is run by hand. |
| `docs/` | The documents for people. Start with `catalog.md` for a list of everything. |

## How one prompt flows

1. You start Claude with `claude --model <m> --effort <e>`. The `session-notes.mjs` and `lead-text.mjs` hooks print the lead rules.
2. `skill-router.mjs` reads your prompt and names the skills that fit (for example `ui-quality-pass` for a UI edit).
3. Claude reads `home/CLAUDE.md` and the rules whose paths match the files it works on.
4. The lead hands work to agents from `home/agents/`. Each agent file lists its model, tools and size limits.
5. Before each Bash command, `pre-bash-guard.mjs` checks it. Risky commands (push, `rm -rf`, secrets) open a dialog. When a
   rewrite would remove the question (a `$VAR` command word, `rm`/`push` inside `$(...)` or a heredoc, a literal secret), the
   first send is sent back to Claude with the fix instead; the same command sent again opens the dialog.
6. After each edit, `post-edit.mjs` runs the project's formatter.
7. When an agent or the session stops, `done-check.mjs` runs the project's own type check, lint and related tests on the code that changed
   (section below). The other Stop hooks check the reply against any size cap you gave, and look for uncommitted files and loose branches.

The hook list with exact triggers is in `docs/catalog.md` (section Hooks) and `home/hooks/README.md`.

## The done-check

Layer by layer, from the cheapest: the Bash guard and gitleaks (safety, unchanged), the formatter after each edit, the **done-check** at
every stop, the same check again when a lane is landed, one risk review for risky lanes, and the UI pixel checks.

- **At a stop.** The hook `home/hooks/done-check.mjs` (Stop and SubagentStop) finds the code files the stopping agent changed since its
  first tool call and, per package (the nearest `package.json`), detects what the project itself offers: a `typecheck` script or
  `tsc`, eslint, and the `test` script's vitest, jest or `node --test` parts, run only on the tests that relate to the changed files. It
  also scans the diff for deleted, skipped or loosened tests and silenced lint or type errors. Everything runs through
  `home/tools/done-check/` (its README has the command line); nothing is installed from the network.
- **Old failures do not count.** A failure is re-run on the base commit in a temporary copy; one that fails there too is listed as
  `old` and never blocks.
- **No loops.** A new failure blocks the stop once for that exact state (the agent fixes it in the same conversation); the same
  state again passes as `left open`, and the third stop in a row passes with "change approach". A check that cannot run
  (`not run`) never blocks and is never shown as ok. If the hook itself crashes the stop goes through; the land check is the hard gate.
- **Landing.** `land-lane` runs the same check on the landed tip, reuses a green result for the same change, and for a lane in a risk
  class asks for the one `reviewer` run (`home/agents/reviewer.md`) before it lands.
- **The ledger.** Every run and every label (`done-check.mjs label`) is one row in `~/.claude/state/done-check/ledger.jsonl`, with no
  code and no file names. `done-check.mjs stats` and a line of `scripts/doctor.sh` show which check raises too many false alarms
  (over 10% after 10 blocks). Changing a rule is a human decision: edit `home/tools/done-check/risk-rules.json`.
- **Skip it by hand.** `DONE_CHECK_SKIP=all` (or `types`, `lint`, `tests`, comma separated) in the environment of the session.

## Where each kind of rule lives, and how to change one

| You want to change | Edit | Then |
| ------------------ | ---- | ---- |
| A rule every session follows | `home/rules/core.md` (one line, keep the id) | update `docs/catalog.md` if the id range changes |
| A rule for some file types | `home/rules/<area>.md` (`paths:` in the frontmatter) | none |
| The long explanation of a rule | `home/standards/<area>.md` | none |
| How a helper role behaves | `home/agents/<name>.md` | update its row in `docs/catalog.md` |
| A workflow | `home/skills/<name>/SKILL.md` | update its row in `docs/catalog.md` |
| A permission or hook wiring | `settings/base.json` (or the OS file) | run `scripts/install.sh` to rebuild `~/.claude/settings.json` |

Edit in a git worktree, not the main checkout: the files are live in every session. Land by rebasing onto main and fast-forwarding (`git merge --ff-only`). Details: `CLAUDE.md` (this repo's
own rules) and `docs/usage.md`.

## Turn a hook off by hand

- One hook, until you re-run the installer: open `~/.claude/settings.json`, find the `command` that names the script
  (for example `pre-bash-guard.mjs`) and delete that entry from its `hooks` list.
- One hook, for good: delete the same entry from `settings/base.json` and run `scripts/install.sh`.
- Some hooks have a switch: `CLAUDE_SKILL_ROUTER=off` turns the skill router off; `CLAUDE_POST_EDIT_SKIP=format`
  (or `all`) skips the formatter; `DONE_CHECK_SKIP=all` skips the done-check.

## Read the guard log

Every question the Bash guard asked, and the answer, is one JSON line in `~/.claude/logs/guard.jsonl`
(`CLAUDE_GUARD_LOG` changes the path). Show the last lines with `tail -n 20 ~/.claude/logs/guard.jsonl`. The outcomes are
allow, deny, timeout, remembered, bounce (sent back once for a rewrite; the line names the classes in `class` and holds no command
text), no-gui and dialog-failed. The log never stores secrets. What the guard asks about is in
`docs/troubleshooting.md`.

## Run the tests

From the repo root:

    node --test tests/*.test.mjs

Never run bare `node --test`. The `ui-check` tool has its own tests: `pnpm --dir home/tools/ui-check test`.

The done-check runs the tests related to a change when an agent or the session stops, and `land-lane` runs it again at landing; the pre-commit
hook and a push run no tests. Run the whole suite, or one file (`node --test tests/estimate.test.mjs`), when you want to know that everything still works. Tests of parts that were removed may still sit in `tests/` until they are pruned.

## Install on another machine

    git clone <repo> ~/Desktop/claude-setup && cd ~/Desktop/claude-setup
    scripts/install.sh --dry-run        # preview
    scripts/install.sh                  # macOS, Linux, Git Bash

On Windows use `powershell -ExecutionPolicy Bypass -File scripts\install.ps1`. Existing files are moved to
`~/.claude-backup-<stamp>/`, never deleted. Put machine-only settings in `settings/local.json` (copy
`settings/local.json.example`). Check the result with `scripts/doctor.sh`. Full steps: `docs/setup.md`.
