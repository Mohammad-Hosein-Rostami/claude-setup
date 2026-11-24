# How this setup works (no AI needed to read it)

This repo configures Claude Code: the rules it follows, the helper programs it runs, and the small scripts that watch
what it does. Everything is plain text and Node scripts. You can read, change and switch off any part by hand.

## What each folder holds

| Folder | What is in it |
| ------ | ------------- |
| `home/` | The content that gets linked into `~/.claude`. Editing a file here changes every running session at once. |
| `home/CLAUDE.md` | The short global instructions every session reads (language, who does what, questions, git, safety). |
| `home/rules/` | One-line rules, each with an id, that apply to matching file paths (`paths:` in the frontmatter). |
| `home/standards/` | The longer reference behind the rules, with examples (for human readability: `readability.md`). |
| `home/skills/` | Step-by-step workflows (`<name>/SKILL.md`) that Claude loads when the task matches. |
| `home/agents/` | The agents (lex, dev, tess and their helpers), one file each, with their model, effort and preloaded skills. |
| `home/project-notes/` | Shared notes, one file per project; personal notes live in `personal/project-notes/`, which `~/.claude/project-notes` links to. |
| `personal/` | Your own layer, git-ignored and its own git repo, made by the installer from `personal.example/`: `CLAUDE.md` (your rules), `project-notes/`, `share-deny.txt`. |
| `home/hooks/` | Node scripts Claude Code runs on events (before a Bash command, after an edit, at session start, ...). |
| `home/tools/` | Command-line tools with their own README (`ui-check`, `ui-coverage`, `land`, ...). |
| `settings/` | `base.json` plus one file per OS. They are merged into `~/.claude/settings.json`. |
| `plugins/` | The list of plugins to install. |
| `tools/` | System programs to install (`Brewfile`, `windows-tools.ps1`); not the same as `home/tools/`. |
| `.githooks/` | The pre-commit hook: gitleaks on the staged changes and `node --check` of each staged hook file. It only runs after `scripts/install.sh` sets `core.hooksPath`. |
| `scripts/` | `install.sh`, `install.ps1` and `doctor.sh` (its check groups are in `scripts/doctor/`). |
| `tests/` | The test suite (`node:test`), run by hand. |
| `docs/` | The documents for people. Start with `catalog.md` for a list of everything. |

## How one prompt flows

1. You start Claude with `claude --model <m> --effort <e>`. The main session is the boss.
2. Claude reads `home/CLAUDE.md`, your `personal/CLAUDE.md` and the rules whose paths match the files it works on.
3. The boss hands the work to `lex` (plan), `dev` (build) or `tess` (tests and reviews, mostly when you ask), at most 6 at
   once. Each agent file lists its model, tools, preloaded skills and the helpers it may start.
4. Before each Bash command, `pre-bash-guard.mjs` checks it. Risky commands (push, `rm -rf`, prod-host writes) open a dialog. When a
   rewrite would remove the question (a `$VAR` command word, `rm`/`push` inside `$(...)` or a heredoc, a word or arithmetic known
   only at run time), the first send is sent back to Claude with the fix instead; the same command sent again opens the dialog.
   A literal secret in a command (a test password) asks nothing; the log names its kind (owner decision R22-G1).
5. After each edit, `post-edit.mjs` runs the project's formatter.
6. Tests, type check, lint and reviews run mostly when you ask for them (`tess`, `tess-review`); lex and dev may also start
   `tess` where a check is needed. No check runs by itself when an agent stops.

The hook list with exact triggers is in `docs/catalog.md` (section Hooks) and `home/hooks/README.md`.

## The UI checks

Nobody labels UI work. `node ~/.claude/tools/ui-proof/ui-proof.mjs plan` reads the request (the brief, which quotes your words),
the diff and the screens the diff reaches, and returns the check plan, whose depth fits the change (rules:
`home/standards/ui-checks.md`):

| Depth | When | Proof |
| ----- | ---- | ----- |
| none | only tests, docs pages or dev config changed | nothing |
| same | dependencies only, or a "no visual change" request | renders before and after are identical |
| render | logic, text or look on a screen with no design | renders before and after: no new problem; logic also needs its tests |
| visual | a new screen or state (no render before), or a screen with no url to open | the `dev-pixel` compare loop and the `pixel-qa` final gate |
| pixel | a design word or Figma link in the request, or a look change on a screen with a Figma frame | the full pixel-perfect path, unchanged: `figma-pixel-perfect`, `ui-check run` rounds until every state passes, then the `pixel-qa` final gate on the tree that lands |

Evidence only raises the plan: a brief line `UI-PLAN: <depth>` can make it stricter, never lighter, and what cannot be read takes
a stricter path. `ui-proof check --plan` checks the proof of a plan; there are no waivers. Old problems on both sides are
printed as `follow-up:` lines; new ones fail the check.

## Where each kind of rule lives, and how to change one

| You want to change | Edit | Then |
| ------------------ | ---- | ---- |
| A rule every session follows | `home/CLAUDE.md` (keep it short) | none |
| A rule for some file types | `home/rules/<area>.md` (`paths:` in the frontmatter) | none |
| The long explanation of a rule | `home/standards/<area>.md` | none |
| How an agent behaves | `home/agents/<name>.md` | update its row in `docs/catalog.md` |
| A workflow | `home/skills/<name>/SKILL.md` | update its row in `docs/catalog.md` |
| A permission or hook wiring | `settings/base.json` (or the OS file) | run `scripts/install.sh` to rebuild `~/.claude/settings.json` |

Edit in a git worktree, not the main checkout: the files are live in every session. Land by rebasing onto main and fast-forwarding (`git merge --ff-only`). Details: `CLAUDE.md` (this repo's
own rules) and `docs/usage.md`.

## Turn a hook off by hand

- One hook, until you re-run the installer: open `~/.claude/settings.json`, find the `command` that names the script
  (for example `pre-bash-guard.mjs`) and delete that entry from its `hooks` list.
- One hook, for good: delete the same entry from `settings/base.json` and run `scripts/install.sh`.
- Some hooks have a switch: `CLAUDE_POST_EDIT_SKIP=format` (or `all`) skips the formatter.

## Read the guard log

Every question the Bash guard asked, and the answer, is one JSON line in `~/.claude/logs/guard.jsonl`
(`CLAUDE_GUARD_LOG` changes the path). Show the last lines with `tail -n 20 ~/.claude/logs/guard.jsonl`. The outcomes are
allow, deny, timeout, bounce (sent back once for a rewrite; the line names the classes in `class` and holds the reason and the
masked command, as an ask line does), secret (a literal secret ran unasked; the line names its kind in `reason` and holds no
command), no-gui and dialog-failed; lines written before owner decision R22-G1 may also say remembered (a secret allowed earlier in
the session). The log never stores secrets. What the guard asks about is in
`docs/troubleshooting.md`.

## Run the tests

From the repo root:

    node --test tests/*.test.mjs

Never run bare `node --test`. The `ui-check` tool has its own tests: `pnpm --dir home/tools/ui-check test`.

No test runs by itself: the pre-commit hook and a push run none. Run the whole suite, or one file
(`node --test tests/principles.test.mjs`), when you want to know that everything still works, or ask `tess` to.

## Install on another machine

    git clone <repo> ~/Desktop/claude-setup && cd ~/Desktop/claude-setup
    scripts/install.sh --dry-run        # preview
    scripts/install.sh                  # macOS, Linux, Git Bash

On Windows use `powershell -ExecutionPolicy Bypass -File scripts\install.ps1`. Existing files are moved to
`~/.claude-backup-<stamp>/`, never deleted. Put machine-only settings in `settings/local.json` (copy
`settings/local.json.example`). Check the result with `scripts/doctor.sh`. Full steps: `docs/setup.md`.
