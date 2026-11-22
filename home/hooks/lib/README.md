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
- `command-checks.mjs`, `rm-paths.mjs`, `bare-glob.mjs`, `find-delete.mjs`, `eval-check.mjs`, `shell-hazards.mjs`, `dangerous-scan.mjs`,
  `raw-risk.mjs`, `outward.mjs`, `remote.mjs`, `code-writes.mjs`, `git-runs.mjs`: one file per kind of risky command (`rm -r`,
  `find -delete`, `eval`, hidden execution, push or publish, production hosts, code rewritten from Bash, commands git runs).
- `account-reads.mjs`: the one exemption from the stored-secret ask: a Keychain read of the account tool's own service
  (`claude-setup-account`), which the owner allows (2026-11-19); any other service keeps the ask.
- `cd-folder.mjs`: the folders the guard follows a line through after `cd`, `pushd` or `popd` (the rules are in the module's
  header).
- `merge-commit.mjs`: advice, never an ask: a `git merge` or `git pull` that can create a merge commit (linear history, C37).
- `branch-move.mjs`: advice, never an ask: a branch moved by `update-ref`, `branch -f` or `push|fetch .`, which leaves the folder
  where it is checked out behind (land with `merge --ff-only`, C37).
- `wait-advice.mjs`: advice, never an ask: a `for|while|until` loop that sleeps 5 s or more, or a single `sleep` of 30 s or more (a sleep loop holds the turn, and a repeated check costs a model call each time). Pure; a time it cannot read (`sleep $n`) gives no advice, and the hook drops the advice for a call sent with `run_in_background: true`.
- `git-advice.mjs`: all three git advices in one call (merge commit, branch move, a copy of an existing lane branch); the copy-branch advice asks git (one 2 s budget per command line), and any git error or timeout gives no advice.
- `inert-arguments.mjs`: empties the single-quoted arguments of programs that never run them (echo, printf, grep, rg, jq, sed, git log) before `raw-risk.mjs` looks for dangerous words, only in shapes it can prove harmless.
- `secrets.mjs`: finds literal secrets in a command and masks them.
- `verdict.mjs`: shared wording of the reasons.

Asking and remembering:
- `timed-ask.mjs`: the timed dialog (osascript, PowerShell or zenity).
- `timed-ask-text.mjs`: the dialog's text for `timed-ask.mjs`: masked, visible values, detail lines, the timeout rule.
- `timed-ask-async.mjs`: the same dialog as a promise that an abort signal (or `closeLiveDialogs`, run when the hook is stopped) can close; used by the question popups.
- `question-reply.mjs`: AskUserQuestion for `permission-timed-allow.mjs`, one popup per question with its own wait.
- `question-answered.mjs`: the mark that the owner answered a question in the terminal (hashes of session, agent and question texts only), so the open popup closes.
- `notify-note.mjs`: the texts and terminal sequences of `notify.mjs`, the effective channel, and the per-session queue of notes no hook event carries (`queueNote`, `takeNotes`).
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
- `diagnostics.mjs`: used by `post-edit.mjs` (parses a failed format run into `file:line RULE-ID message` lines). `edit-log.mjs`: the per-user hook temp root (`tempRoot`, `checkedTempRoot`) that `agent-budget.mjs` and `writer-agents.mjs` keep their records in.
- `own-edits.mjs`: the files a session or agent changed with Edit/Write/MultiEdit/NotebookEdit, recorded and read by `commit-gate.mjs`.
- `gated-folder.mjs`: the folder a Stop or SubagentStop gate looks at (the session's own worktree, never a folder it only cd'd into; for a lead also one worktree per repository of the files the session edited, `editedWorktrees`) and the hardened git calls that read it, the discovery ones time-bound; used by `commit-gate.mjs` and `git-tidy-gate.mjs` (also `namesFilterProgram`, `readHead`), and its `gitOut` by `typecheck-plan.mjs` (the git top).
- `tidy-gate-store.mjs`: the per-session state file of `git-tidy-gate.mjs` (check verdict per repo and fingerprint, states already blocked, chain length).
- `dirty-baseline.mjs`: the dirty files of a worktree (path + content hash) at the first tool call of a session or agent, so `commit-gate.mjs` can count files a Bash command made or changed.
- `read-only-command.mjs`: whether a Bash command is git or reading only (no writing option, no output to a file), for
  `agent-budget.mjs`'s escalation.
- `writer-agents.mjs`: which agent types write files (agent files' `tools:` line); `commit-gate.mjs` uses its agent-file check and its
  read-only brief and launch checks.
- `agent-launches.mjs`: the launch record of every agent of a session and the cap of 5 running at once (`MAX_RUNNING_AGENTS`):
  `agent-model-guard.mjs` records each launch (writers with the `isolated` and `readOnly` flags), `agent-budget.mjs` marks it started and
  ended on SubagentStart and SubagentStop; a stopped agent that makes a tool call again counts again. The store is
  `~/.claude/state/agent-writers/<session>.json` (a historic folder name).
- `stop-block-count.mjs`: the stop-block counter every blocking Stop/SubagentStop gate calls once (`countedGate`): counts blocks in a row per
  session and agent, resets on a tool call (`markToolCall` from `agent-budget.mjs`), records `gate overridden` past the cap and
  `gate crashed or timed out`; read by `scripts/doctor.sh` and `resume-notice.mjs`.
- `unfinished-work.mjs`: the parts of the session-start notice for work left open: plain writer agents with no recorded finish, open owner questions of recent ask queues, the HANDOFF.md "Don't redo" list (`sessionNotes`); used by `resume-notice.mjs`. Its name avoids `session-notes.mjs`, the lead-rules hook.
- `read-only-hold.mjs`: whether a stopping subagent is held to its `read-only:` / `scratchpad-only:` brief, which of its recorded files
  lie outside the temp and scratchpad roots, and the block reason; used by `commit-gate.mjs`.
- `gate-routes.mjs`: the prompt patterns and lines of the skill router's gate routes (bug, done, restructure, git history, repeated report); used by `skill-router.mjs`.
- `reply-cap.mjs`: reads a reply-size cap from a prompt; used by `agent-budget.mjs` and `final-reply-cap.mjs`.
- `transcript.mjs`: reads the session transcript (context size, STATUS file).
- `state-files.mjs`: the state files in `~/.claude/state/modes` (read without following a link or waiting on a FIFO, written as a whole by rename, pruned within bounds), used by `session-notes.mjs` and `compact-notes.mjs`.
- `big-context.mjs`, `compact-notes.mjs`, `project-agents.mjs`: the notes `session-notes.mjs` prints (`project-agents.mjs` also runs as a command for `doctor.sh`). The project-agents note is built from six parts, each of which cites what it read in the Claude Code bundle: `agent-folders.mjs` (the `.claude/agents` folders Claude Code loads: from the session folder up to the git root, never the home folder), `agent-file-walk.mjs` (their entries, subfolders included, under fixed limits and never through a link or a hard link), `agent-frontmatter.mjs` (an agent file's frontmatter found by Claude Code's own rules, then read exactly when it is in a strict plain subset of YAML and called "not plain" otherwise), `project-agents-text.mjs` (the wording and the 800-character cap), `project-agents-timed.mjs` (runs the note in a child process with at most 2 s, less when the hook's 4 s budget has less left, for the SessionStart hook, so a hostile folder can cost the session only this note, which then reads "not checked") and `shown-name.mjs` (how a file name or path from a repository or a transcript is shown: plain, or quoted with everything outside printable ASCII escaped; `doctor.sh` and `compact-notes.mjs` use it too).
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
