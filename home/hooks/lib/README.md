# home/hooks/lib

Helper modules for the hooks in `home/hooks/` (one folder up). A hook script reads the event, calls these helpers and
prints the answer. They hold the rules, so a rule can be tested without starting a hook. Plain Node 22 ES modules, no
dependencies. Each file starts with a comment that lists its exports.

## What is here

Asking and remembering (the question popup, `question-popup.mjs`):
- `timed-ask.mjs`: the timed dialog (osascript, PowerShell or zenity).
- `timed-ask-text.mjs`: the dialog's text for `timed-ask.mjs`: masked, visible values, detail lines, the timeout rule.
- `timed-ask-async.mjs`: the same dialog as a promise that an abort signal (or `closeLiveDialogs`, run when the hook is stopped) can close; used by the question popups.
- `question-reply.mjs`: AskUserQuestion for `question-popup.mjs`, one popup per question with its own wait.
- `question-answered.mjs`: the mark that the owner answered a question in the terminal (hashes of session, agent and question texts only), so the open popup closes.
- `notify-note.mjs`: the texts and terminal sequences of `notify.mjs` (a question note shows the marker's short header: `a question (Scope)`) and the effective channel.
- `question-rejected.mjs`: notices in the session transcript that the owner turned the question down in the terminal ("Chat about this", Esc), which runs no tool and leaves no mark, so the open popup closes.
- `secrets.mjs`: masks the literal secrets in a dialog's text (`maskSecrets`).
- `session-store.mjs`: small per-session files (`asking-marker.mjs`, `question-answered.mjs` and others). It checks the folder and file
  with lstat, never follows a link or waits on a FIFO, and cleans up only its own old files.
- `session-lock.mjs`: `withSessionLock` makes hooks that record at the same moment take turns, so none drops another's record
  (built on `session-store.mjs`). The lock holds `<pid> <random token>` and is removed only by the run that holds it; a lock is
  taken over only when its pid is gone (or it has no token) and it is over 0.5 s old, or it is over 5 s old. One waiter at a time
  takes a lock over, behind an O_EXCL `<lock>.break` file (a waiter that cannot create it treats the lock as busy; a stale `.break`
  file is removed by the next waiter); the lock is renamed aside only while it is still the stale one, and a different file is
  linked back. If the stale lock's holder releases in that instant and two callers take the name, the moved lock is deleted: a lock
  is not guaranteed to survive a take-over. A caller may name the lock file (`lockFile`).
- `plain-file.mjs`: the one safe open (no waiting, no link followed, regular files only, no append to a hard-linked file, a size cap) for the session transcript and the other files the hooks and tools read or append.
- `asking-marker.mjs`: the small file `~/.claude/state/asking/<session>.json` that says a question or permission prompt waits for the owner; one writer here, read by the status line, `notify.mjs` and the board. It holds the first question's short header label (`header`, cut and cleaned by `cleanHeader` at `MAX_HEADER_CHARS` by the writer and by `readAsking`: control, format (bidi overrides and isolates, zero-width) and line-separator characters and `;` are dropped (`UNSAFE_TEXT`, also used for every note text); a marker without one reads as empty) and no question text. It expires by age.

Other hooks:
- `diagnostics.mjs`: used by `post-edit.mjs` (parses a failed format run into `file:line RULE-ID message` lines). `format-trust.mjs`: used by `post-edit.mjs` (whether a project's `format` script may run: `CLAUDE_POST_EDIT_TRUST_FORMAT=1` for the project, else only one plain call of a known formatter, as its binary). `edit-log.mjs`: the per-user hook temp root (`tempRoot`, `checkedTempRoot`) that `team-switch.mjs` keeps its notice markers in.
- `gated-folder.mjs`: the folder a hook looks at (the session's own worktree, never a folder it only cd'd into) and the hardened git calls that read it, the discovery ones time-bound; used by `git-tidy-gate.mjs` and `project-merge.mjs` (also `namesFilterProgram`, `readHead`).
- `new-file-size.mjs`: the size limit for new files (5 MB) and `namesPath`, the brief test that lets a named file through; used by `git-tidy land`.
- `tidy-check-child.mjs`, `tidy-gate-notes.mjs`: for `git-tidy-gate.mjs`: the `git-tidy check` child and its slim verdict, and the session-start text naming the unlanded lanes.
- `agent-brief.mjs`: shared reads (`readFileHead`, the nearest git root and its git folder without running git).
- `tidy-gate-store.mjs`: the per-session state file of `git-tidy-gate.mjs` (the check verdict per repo and fingerprint).
- `writer-agents.mjs`: which agent types write files (agent files' `tools:` line, `WRITER_TYPES`, `READ_ONLY_TYPES`); used by
  `gated-folder.mjs` and the board.
- `project-agents.mjs`: the project-agents line of the `project-merge.mjs` lead note (it also runs as a command for `doctor.sh`; it never tells the lead to edit a project agent file). The project-agents note is built from six parts, each of which cites what it read in the Claude Code bundle: `agent-folders.mjs` (the `.claude/agents` folders Claude Code loads: from the session folder up to the git root, never the home folder), `agent-file-walk.mjs` (their entries, subfolders included, under fixed limits and never through a link or a hard link), `agent-frontmatter.mjs` (an agent file's frontmatter found by Claude Code's own rules, then read exactly when it is in a strict plain subset of YAML and called "not plain" otherwise), `project-agents-text.mjs` (the wording and the 800-character cap), `project-agents-timed.mjs` (runs the note in a child process with at most 2 s, less when the hook's 4 s budget has less left, for the project-merge hook, so a hostile folder can cost the session only this note, which then reads "not checked") and `shown-name.mjs` (how a file name or path from a repository or a transcript is shown: plain, or quoted with everything outside printable ASCII escaped; `doctor.sh` uses it too).
- `project-note-key.mjs`, `project-setup-scan.mjs`, `project-merge-text.mjs`: the parts of the note `project-merge.mjs` prints. `project-note-key.mjs` finds the repo key (the `remote.origin.url` name with scheme, userinfo, host, port, `.git` and `_git` removed, as `<seg-2>-<seg-1>` then `<seg-1>`; else the main checkout's folder name, found from `git rev-parse --git-common-dir` so a worktree maps to it; without git the highest folder below HOME holding `.svn`, else the folder name) and reads the notes by it (regular files with one name only, at most 8 KiB each; a git failure in a repository gives no key, never a guessed one). `project-setup-scan.mjs` reads the project's AI files without following any link (each link it meets is named under "Not checked"), under entry, depth, size and time limits, and keeps values only for the model, effort, permission mode, `disableAllHooks` and our check switches (every other setting and env value by its key alone); it also exports `teamSetEnv` (env keys the committed settings set and the local file does not; every key is read, not only the first 200 the note shows).
- `team-switch.mjs`: our switches (`CLAUDE_POST_EDIT_SKIP`, `CLAUDE_POST_EDIT_TRUST_FORMAT`) as a hook may honour them: one set only by a project's committed `.claude/settings.json` (not by `.claude/settings.local.json` or the shell alone), or met with an unreadable settings file, is ignored with a one-line warning and the check runs (owner R22-Q3: the stricter rule applies). The project folders are `CLAUDE_PROJECT_DIR` plus the folders the hook knows, never the home folder (its settings are the user's own). Used by `post-edit.mjs`. `project-merge-text.mjs` is the wording and the 6,000-character cap; every repository name goes through `shown-name.mjs`.

## Test

Tests live in `tests/` (one folder up from `home/`, at the repo root). Run all of them:

    node --test tests/*.test.mjs

Never run a bare `node --test`. One file at a time works too, for example `node --test tests/timed-ask.test.mjs`.

## Watch out for

- `docs/how-it-works.md` explains how a prompt reaches these hooks.
