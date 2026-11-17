# home/hooks/lib

Helper modules for the hooks in `home/hooks/` (one folder up). A hook script reads the event, calls these helpers and
prints the answer. They hold the rules, so a rule can be tested without starting a hook. Plain Node 22 ES modules, no
dependencies. Each file starts with a comment that lists its exports.

## What is here

Reading a shell command (used by `pre-bash-guard.mjs`; pure functions, they never run anything):
- `shell-words.mjs`, `shell-lexer.mjs`, `ansi-c.mjs`, `braces.mjs`, `message-text.mjs`: split a command into words and
  decode quoting, brace lists and `$'...'`. `shell-words.mjs` is the entry point; `shell-lexer.mjs` is a second, separate parser.
- `command-of.mjs`: finds the real command behind `sudo`, `env`, `VAR=x` and keywords.
- `git-options.mjs`: reads git's own options before the subcommand (`git -C dir -c k=v push`); an option it does not know is
  read both ways (a flag, or taking the next word), so an option value never hides the subcommand.
- `sql.mjs`: tells whether a `psql` or `mysql` statement only reads, and which host it talks to.

Rules that decide whether to ask the owner (used by `pre-bash-guard.mjs`):
- `command-checks.mjs`, `rm-paths.mjs`, `find-delete.mjs`, `eval-check.mjs`, `shell-hazards.mjs`, `dangerous-scan.mjs`,
  `raw-risk.mjs`, `outward.mjs`, `remote.mjs`, `code-writes.mjs`, `git-runs.mjs`: one file per kind of risky command (`rm -r`,
  `find -delete`, `eval`, hidden execution, push or publish, production hosts, code rewritten from Bash, commands git runs).
- `merge-commit.mjs`: advice, never an ask: a `git merge` or `git pull` that can create a merge commit (linear history, C37).
- `branch-move.mjs`: advice, never an ask: a branch moved by `update-ref`, `branch -f` or `push|fetch .`, which leaves the folder
  where it is checked out behind (land with `merge --ff-only`, C37).
- `secrets.mjs`: finds literal secrets in a command and masks them.
- `verdict.mjs`: shared wording of the reasons.

Asking and remembering:
- `timed-ask.mjs`: the timed dialog (osascript, PowerShell or zenity).
- `timed-ask-async.mjs`: the same dialog as a promise that an abort signal (or `closeLiveDialogs`, run when the hook is stopped) can close; used by the question popups.
- `question-reply.mjs`: AskUserQuestion for `permission-timed-allow.mjs`, one popup per question with its own wait.
- `question-answered.mjs`: the mark that the owner answered a question in the terminal (hashes of session, agent and question texts only), so the open popup closes.
- `question-rejected.mjs`: notices in the session transcript that the owner turned the question down in the terminal ("Chat about this", Esc), which runs no tool and leaves no mark, so the open popup closes.
- `remembered-ask.mjs`, `allowed-literals.mjs`: per-session memory of secrets the owner already allowed (hashes only).
- `answered-commands.mjs`: a command the guard's dialog allowed, handed to `permission-timed-allow.mjs` so Claude Code's own prompt for it opens no second dialog (hashes of session, agent, directory and command only; used once; 10 s window).
- `bounce-once.mjs`: the first time a command asks because of how it is written (a variable command word, a risky word
  inside `$(...)` or a heredoc, a literal secret), it is sent back to the agent with the fix instead of the dialog, and any
  other reason it asks for is named as one that will still ask; the same command again gets the dialog. Per-session store
  in `~/.claude/state/guard-bounced` (hashes only). `reason-classes.mjs` gives every guard reason a fixed class name.
  Advice (a quality rule: a hand-edited lockfile, a merge commit) uses the same store: alone, the first send is sent back
  with the fix and the same command again runs with no dialog; next to a reason that asks, the advice is only added to it.
- `session-store.mjs`: the per-session files of `allowed-literals.mjs` and `bounce-once.mjs`. It checks the folder and file
  with lstat, never follows a link or waits on a FIFO, and cleans up only its own old files.
- `session-lock.mjs`: `withSessionLock` makes hooks that record at the same moment take turns, so none drops another's record
  (built on `session-store.mjs`). The lock holds `<pid> <random token>` and is removed only by the run that holds it; a lock is
  taken over only when its pid is gone (or it has no token) and it is over 0.5 s old, or it is over 5 s old. One waiter at a time
  takes a lock over, behind an O_EXCL `<lock>.break` file (a waiter that cannot create it treats the lock as busy; a stale `.break`
  file is removed by the next waiter); the lock is renamed aside only while it is still the stale one, and a different file is
  linked back. If the stale lock's holder releases in that instant and two callers take the name, the moved lock is deleted: a lock
  is not guaranteed to survive a take-over. A caller may name the lock file (`lockFile`, as `status.mjs` does with
  `.<name>.status-lock`).
- `guard-log.mjs`: the decision log, one JSON line per decision.

Other hooks:
- `diagnostics.mjs`, `edit-log.mjs`: used by `post-edit.mjs` and `typecheck-gate.mjs` (check output parsing, list of edited files).
- `own-edits.mjs`: the files a session or agent changed with Edit/Write/MultiEdit/NotebookEdit, recorded and read by `commit-gate.mjs`.
- `gated-folder.mjs`: the folder a Stop or SubagentStop gate looks at (the session's own worktree, never a folder it only cd'd into) and the hardened git calls that read it; used by `commit-gate.mjs` and `git-tidy-gate.mjs`.
- `dirty-baseline.mjs`: the dirty files of a worktree (path + content hash) at the first tool call of a session or agent, so `commit-gate.mjs` can count files a Bash command made or changed.
- `read-only-command.mjs`: whether a Bash command is git or reading only (no writing option, no output to a file), for
  `agent-budget.mjs`'s escalation.
- `writer-agents.mjs`: which agent types write files (agent files' `tools:` line), and the record of a session's running writers that
  `agent-model-guard.mjs` writes on launch and `agent-budget.mjs` ends on SubagentStop; `commit-gate.mjs` uses its agent-file check.
- `gate-routes.mjs`: the prompt patterns and lines of the skill router's gate routes (bug, done, restructure, git history, repeated report); used by `skill-router.mjs`.
- `reply-cap.mjs`: reads a reply-size cap from a prompt; used by `agent-budget.mjs` and `final-reply-cap.mjs`.
- `transcript.mjs`: reads the session transcript (context size, STATUS file).
- `big-context.mjs`, `compact-notes.mjs`, `lead-note.mjs`, `project-agents.mjs`: the notes `mode.mjs` prints (`project-agents.mjs` also runs as a command for `doctor.sh`).
- `owner-words.mjs`: the owner's words in a prompt, without pasted logs (`<pasted_content>`), harness blocks and compaction summaries; used by `skill-router.mjs` and `big-context.mjs`.

## Test

Tests live in `tests/` (one folder up from `home/`, at the repo root). Run all of them:

    node --test tests/*.test.mjs

Never run a bare `node --test`. One file at a time works too, for example `node --test tests/pre-bash-guard.test.mjs`.

## Watch out for

- The guard never blocks for good: a rule asks, and a missing answer lets the command go ahead. A bounce (`bounce-once.mjs`)
  only sends a command back once; sent again, it asks. Keep that when you add a rule, and add a reason to the bounce classes
  only when rewriting the command removes the ask. A new rule's reason needs a class in `reason-classes.mjs` and a row in
  `tests/pre-bash-guard-reason-classes.test.mjs`; that test fails until both exist.
- The two parsers (`shell-words.mjs` and `shell-lexer.mjs`) are meant to be independent. Do not make one call the other.
- Guard tests pin `HOME` (`tests/pin-home.mjs`): `guard-log.mjs` and `remote.mjs` read it when they load.
- `docs/how-it-works.md` explains how a prompt reaches these hooks.
