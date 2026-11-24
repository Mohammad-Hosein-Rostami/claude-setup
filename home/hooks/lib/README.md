# home/hooks/lib

Helper modules for the hooks in `home/hooks/` (one folder up). A hook script reads the event, calls these helpers and
prints the answer. They hold the rules, so a rule can be tested without starting a hook. Plain Node 22 ES modules, no
dependencies. Each file starts with a comment that lists its exports.

## What is here

Reading a shell command (used by `pre-bash-guard.mjs`; pure functions, they never run anything):
- `shell-words.mjs`, `shell-lexer.mjs`, `ansi-c.mjs`, `braces.mjs`, `message-text.mjs`: split a command into words and
  decode quoting, brace lists and `$'...'`. `shell-words.mjs` is the entry point; `shell-lexer.mjs` is a second, separate parser.
  `segment-marks.mjs` holds the flags both parsers put on a segment (`.piped`, `.joinedBy`, `.gluedTo`, `.arrayList`), so they give one shape.
- `command-of.mjs`: finds the real command behind `sudo`, `env`, `VAR=x` and keywords.
- `git-options.mjs`: reads git's own options before the subcommand (`git -C dir -c k=v push`); an option it does not know is
  read both ways (a flag, or taking the next word), so an option value never hides the subcommand.
- `sql.mjs`: tells whether a `psql` or `mysql` statement only reads, and which host it talks to.

Rules that decide whether to ask the owner (used by `pre-bash-guard.mjs`):
- `command-checks.mjs`, `rm-paths.mjs`, `bare-glob.mjs`, `find-delete.mjs`, `eval-check.mjs`, `shell-hazards.mjs`, `dangerous-scan.mjs`,
  `raw-risk.mjs`, `outward.mjs`, `remote.mjs`, `git-runs.mjs`: one file per kind of risky command (`rm -r`,
  `find -delete`, `eval`, hidden execution, push or publish, production hosts, commands git runs).
- `rm-kind.mjs`: is an `rm` recursive as far as its option words can be read (an unquoted `$F` where the options stand counts); `moved-text.mjs`: after a `cd`, a recursive `rm` or deleting `find` in quoted text or in the body of a heredoc a program runs asks.
- `other-deleters.mjs`: deleters other than `rm` (rimraf, `rsync --delete`, PowerShell and `cmd` delete text), judged on the same targets as `rm -r`.
- `same-line-values.mjs`: what a line's own variables hold for the `rm -r` rule beyond the literal values `rm-paths.mjs` tracks: the folder
  a `D=$(mktemp -d <template>)` makes in a scratch area, and the names a line with a loop or a function writes more than once (unknown).
- `runtime-values.mjs`: values a line gets only when it runs: arithmetic on them is bounced once with the fix, then asks (bash runs
  `a[$(cmd)]` inside `$(( ))`), and so is a word filled in from `read`, an array or `"$@"` in a command a rule reads; it also tells
  `shell-hazards.mjs` which `((` bash reads as arithmetic.
- `loop-values.mjs`: the values of a plain `for` list (`for d in a b c`), so the loop body is judged once per value instead of as a
  word known only at run time. A list counts only when every item is a plain literal word that neither bash nor zsh changes (no glob, `~` or leading `=`), the name has one `for` header and is read
  only as `$NAME` or `${NAME}`, and the line has at most 64 combinations (`MAX_LOOP_READINGS`); the values fill in only between the
  header and its `done`. Anything else keeps the run-time bounce.
- `docker-advice.mjs`: advice, never an ask: `docker rm` (also `podman`, `nerdctl`, `container rm`) without `-v` leaves the
  container's anonymous volumes on disk; the first send gets the fix (`docker rm -fv`, or `run --rm`), the same command again runs.
- `credential-send.mjs`: asks when a private credential file (`~/.ssh/id_*`, `.aws/credentials`, `.netrc` ...) and a network sender (curl, scp, nc, a cloud upload) are in one command line.
- `git-run-values.mjs`: the values git runs from a variable or config entry (`GIT_EDITOR`, `GIT_SSH_COMMAND` ...); asks when the guard cannot read what would run. Used by `git-runs.mjs`.
- `guard-state-write.mjs`: asks before a write, removal, link or FIFO under `~/.claude/private` or the guard's own state (remembered allows, bounce records, log); reading is allowed.
- `captured-read.mjs`: drops the "prints a stored secret" ask of a line that only captures the read in a variable (`X=$(security find-generic-password -s gh -w)`); a read that is printed, piped or redirected still asks.
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
- `secrets.mjs`: finds literal secrets in a command and masks them. A secret asks nothing (owner decision R22-G1): the guard logs one
  line naming its kind (outcome `secret`), never the value; gitleaks still checks commits.
- `data-text.mjs`: the parts of a command that `secrets.mjs` treats as data (a stored quoted heredoc body nothing else in the command can run or read, an inert program's quoted argument).
- `verdict.mjs`: shared wording of the reasons.

Asking and remembering:
- `timed-ask.mjs`: the timed dialog (osascript, PowerShell or zenity).
- `timed-ask-text.mjs`: the dialog's text for `timed-ask.mjs`: masked, visible values, detail lines, the timeout rule.
- `timed-ask-async.mjs`: the same dialog as a promise that an abort signal (or `closeLiveDialogs`, run when the hook is stopped) can close; used by the question popups.
- `question-reply.mjs`: AskUserQuestion for `permission-timed-allow.mjs`, one popup per question with its own wait.
- `question-answered.mjs`: the mark that the owner answered a question in the terminal (hashes of session, agent and question texts only), so the open popup closes.
- `notify-note.mjs`: the texts and terminal sequences of `notify.mjs` (a question note shows the marker's short header: `a question (Scope)`), the effective channel, and the per-session queue of notes no hook event carries (`queueNote`, `takeNotes`).
- `question-rejected.mjs`: notices in the session transcript that the owner turned the question down in the terminal ("Chat about this", Esc), which runs no tool and leaves no mark, so the open popup closes.
- `remembered-ask.mjs`: bounce once, else ask the owner (`askOrBounce`), and the one log line for a literal secret (`logSecretKind`:
  its kind, no command, no value). `allowed-literals.mjs`: the per-session store of secrets allowed before R22-G1 (hashes only); the
  guard no longer writes it, and `guard-state-write.mjs` still guards its folder.
- `answered-commands.mjs`: a command the guard's dialog allowed, handed to `permission-timed-allow.mjs` so Claude Code's own prompt for it opens no second dialog (hashes of session, agent, directory and command only; used once; 10 s window).
- `bounce-once.mjs`: the first time a command asks because of how it is written (a variable command word, a risky word
  inside `$(...)` or a heredoc, a word or arithmetic known only at run time), it is sent back to the agent with the fix instead
  of the dialog, and any other reason it asks for is named as one that will still ask; the same command again gets the dialog.
  Per-session store in `~/.claude/state/guard-bounced` (hashes only); the bounce log line holds the masked command and the
  reason, as an ask line does. `reason-classes.mjs` gives every guard reason a fixed class name.
  Advice (a quality rule: a hand-edited lockfile, a merge commit, `docker rm` without `-v`) uses the same store: alone, the first send is sent back
  with the fix and the same command again runs with no dialog; next to a reason that asks, the advice is only added to it.
- `session-store.mjs`: the per-session files of `allowed-literals.mjs` and `bounce-once.mjs`. It checks the folder and file
  with lstat, never follows a link or waits on a FIFO, and cleans up only its own old files.
- `session-lock.mjs`: `withSessionLock` makes hooks that record at the same moment take turns, so none drops another's record
  (built on `session-store.mjs`). The lock holds `<pid> <random token>` and is removed only by the run that holds it; a lock is
  taken over only when its pid is gone (or it has no token) and it is over 0.5 s old, or it is over 5 s old. One waiter at a time
  takes a lock over, behind an O_EXCL `<lock>.break` file (a waiter that cannot create it treats the lock as busy; a stale `.break`
  file is removed by the next waiter); the lock is renamed aside only while it is still the stale one, and a different file is
  linked back. If the stale lock's holder releases in that instant and two callers take the name, the moved lock is deleted: a lock
  is not guaranteed to survive a take-over. A caller may name the lock file (`lockFile`).
- `guard-log.mjs`: the decision log, one JSON line per decision.
- `plain-file.mjs`: the one safe open (no waiting, no link followed, regular files only, no append to a hard-linked file, a size cap) for the host list, the decision logs and the session transcript (`readPlainFileTail` reads only its end).
- `asking-marker.mjs`: the small file `~/.claude/state/asking/<session>.json` that says a question or permission prompt waits for the owner; one writer here, read by the status line, `notify.mjs` and the board. It holds the first question's short header label (`header`, cut and cleaned by `cleanHeader` at `MAX_HEADER_CHARS` by the writer and by `readAsking`: control, format (bidi overrides and isolates, zero-width) and line-separator characters and `;` are dropped (`UNSAFE_TEXT`, also used for every note text); a marker without one reads as empty) and no question text. It expires by age.

Other hooks:
- `diagnostics.mjs`: used by `post-edit.mjs` (parses a failed format run into `file:line RULE-ID message` lines). `edit-log.mjs`: the per-user hook temp root (`tempRoot`, `checkedTempRoot`) that `agent-budget.mjs` and `writer-agents.mjs` keep their records in.
- `gated-folder.mjs`: the folder a hook looks at (the session's own worktree, never a folder it only cd'd into) and the hardened git calls that read it, the discovery ones time-bound; used by `git-tidy-gate.mjs` and `project-merge.mjs` (also `namesFilterProgram`, `readHead`).
- `new-file-size.mjs`: the size limit for new files (5 MB) and `namesPath`, the brief test that lets a named file through; used by `git-tidy land`.
- `tidy-check-child.mjs`, `tidy-gate-notes.mjs`: for `git-tidy-gate.mjs`: the `git-tidy check` child and its slim verdict, and the session-start text naming the unlanded lanes.
- `agent-brief.mjs`, `copy-branch-brief.mjs`: for `agent-model-guard.mjs`: the fixed lines it adds to an Agent brief (the Standing rules line), and the gate that sends back a brief telling the agent to make a copy of an existing lane branch (`<lane>-2`, `-fix`, `-redo`).
- `brief-fields.mjs`: the `worktree:` field of a writer brief and its value, read from the text with no lookups (a `,` or `;` separates fields only in a `KEY: value` header; a quoted value is read whole; two distinct values name many); used by `writer-agents.mjs`.
- `ui-brief-gate.mjs`: the UI brief gate of `agent-model-guard.mjs`: a `ui-implementer` or `visual-qa` brief without a usable `MATRIX: <path>` (or an allowed `MATRIX: none: <reason>`) is sent back once with the `ui-coverage init` advice.
- `open-writers.mjs`: the open launch records of plain writer agents (closed only at their SubagentStop), so a writer that died with its session is listed in the next session's notice; used by `writer-agents.mjs` and `agent-launches.mjs`.
- `tidy-gate-store.mjs`: the per-session state file of `git-tidy-gate.mjs` (the check verdict per repo and fingerprint).
- `read-only-command.mjs`: whether a Bash command is git or reading only (no writing option, no output to a file), for
  `agent-budget.mjs`'s escalation.
- `writer-agents.mjs`: which agent types write files (agent files' `tools:` line, `WRITER_TYPES`, `READ_ONLY_TYPES`), a brief's lane
  worktree and the open writer launches; used by `gated-folder.mjs`, `agent-launches.mjs` and the board.
- `agent-launches.mjs`: the launch record of every agent of a session and the cap of 5 running at once (`MAX_RUNNING_AGENTS`):
  `agent-model-guard.mjs` records each launch (writers with the `isolated` and `readOnly` flags), `agent-budget.mjs` marks it started and
  ended on SubagentStart and SubagentStop; a stopped agent that makes a tool call again counts again. The store is
  `~/.claude/state/agent-writers/<session>.json` (a historic folder name).
- `stop-block-count.mjs`: the stop-block counter every blocking Stop/SubagentStop gate calls once (`countedGate`): counts blocks in a row per
  session and agent (gates of one event are spawned together and count once; a gate started after the chain's last block, or a hook's second block, is the next continuation even with an identical reply and any hook mix; the counts file keeps the newest 100 agents under its own byte cap, rules in `stop-block-entry.mjs`), resets on a tool call (`markToolCall` from `agent-budget.mjs`), records `gate overridden` past the cap and
  `gate crashed or timed out`; read by `scripts/doctor.sh`.
- `stop-block-entry.mjs`: the chain entry of the stop-block counter: `nextEntry` (does a block join the last event or start the next continuation), the compact stored form and `countsText` (newest 100 agents, cut to `MAX_COUNTS_BYTES`); used only by `stop-block-count.mjs`.
- `reply-cap.mjs`: reads a reply-size cap from a prompt and, for an agent report, the body the cap counts (`reportBody`: the Constraints, Not run and Caveats sections left out); used by `agent-budget.mjs`.
- `transcript.mjs`: reads the session transcript (context size, STATUS file, the model and effort of the newest reply) through `plain-file.mjs`, so a FIFO or link at the path never holds a hook.
- `project-agents.mjs`: the project-agents line of the `project-merge.mjs` lead note (it also runs as a command for `doctor.sh`; it never tells the lead to edit a project agent file). The project-agents note is built from six parts, each of which cites what it read in the Claude Code bundle: `agent-folders.mjs` (the `.claude/agents` folders Claude Code loads: from the session folder up to the git root, never the home folder), `agent-file-walk.mjs` (their entries, subfolders included, under fixed limits and never through a link or a hard link), `agent-frontmatter.mjs` (an agent file's frontmatter found by Claude Code's own rules, then read exactly when it is in a strict plain subset of YAML and called "not plain" otherwise), `project-agents-text.mjs` (the wording and the 800-character cap), `project-agents-timed.mjs` (runs the note in a child process with at most 2 s, less when the hook's 4 s budget has less left, for the project-merge hook, so a hostile folder can cost the session only this note, which then reads "not checked") and `shown-name.mjs` (how a file name or path from a repository or a transcript is shown: plain, or quoted with everything outside printable ASCII escaped; `doctor.sh` uses it too).
- `project-note-key.mjs`, `project-setup-scan.mjs`, `project-merge-text.mjs`: the parts of the note `project-merge.mjs` prints. `project-note-key.mjs` finds the repo key (the `remote.origin.url` name with scheme, userinfo, host, port, `.git` and `_git` removed, as `<seg-2>-<seg-1>` then `<seg-1>`; else the main checkout's folder name, found from `git rev-parse --git-common-dir` so a worktree maps to it; without git the highest folder below HOME holding `.svn`, else the folder name) and reads the notes by it (regular files with one name only, at most 8 KiB each; a git failure in a repository gives no key, never a guessed one). `project-setup-scan.mjs` reads the project's AI files without following any link (each link it meets is named under "Not checked"), under entry, depth, size and time limits, and keeps values only for the model, effort, permission mode, `disableAllHooks` and our check switches (every other setting and env value by its key alone); it also exports `teamSetEnv` (env keys the committed settings set and the local file does not; every key is read, not only the first 200 the note shows).
- `team-switch.mjs`: our skip switch (`CLAUDE_POST_EDIT_SKIP`) as a hook may honour it: one set only by a project's committed `.claude/settings.json` (not by `.claude/settings.local.json` or the shell alone), or met with an unreadable settings file, is ignored with a one-line warning and the check runs (owner R22-Q3: the stricter rule applies). The project folders are `CLAUDE_PROJECT_DIR` plus the folders the hook knows, never the home folder (its settings are the user's own). Used by `post-edit.mjs`. `project-merge-text.mjs` is the wording and the 6,000-character cap; every repository name goes through `shown-name.mjs`.

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
