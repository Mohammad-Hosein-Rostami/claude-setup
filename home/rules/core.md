# Core rules (always on): id | rule
C1 | KISS/YAGNI: build only what the task asks
C2 | Reuse existing helpers; dedupe at the 3rd use
C3 | One job per function: <=40 lines, <=4 params, depth <=3, so each one is read and tested whole
C4 | Files <=300 lines; split by responsibility, so a reader holds one file in mind
C5 | Intent-revealing names; no data/tmp/util/helper
C6 | No magic numbers or strings; use named constants
C7 | Depend on interfaces at real boundaries (an external system, a second implementation or a test double); compose over inherit
C8 | Comments say why, not what; delete dead code
C9 | Never swallow errors; no empty catch; fail fast
C10 | Validate all external input at the boundary with a schema
C11 | New behaviour starts from the spec's acceptance lines; a bug fix starts with a failing repro command; the done-check runs the tests related to the change
C12 | The done-check runs by itself at every stop that changed code (typecheck, lint on changed lines, related tests, weakened-test scan): fix each new failure it names, and the whole class, before you stop
C13 | Never weaken or silence a check to make it pass: no ts-ignore, eslint-disable, skipped, deleted, loosened or `.only` tests; a silenced check hides the defect it exists to catch (the done-check scans for it)
C14 | Add no dependency unless needed; verify it exists
C15 | No secrets in code, logs or commits
C16 | Small atomic Conventional Commits after every green step; never end a turn or an agent run with uncommitted work (commit-gate blocks it)
C17 | Match the repo's existing conventions; read neighbours first
C18 | Touch only files the task needs
C19 | TS strict, no any, no unexplained !, exhaustive switch
C20 | Immutable and pure by default; side effects at the edges
C21 | Leave formatting to the formatter
C22 | Fix the root cause, not the symptom
C28 | When an approach fails twice, change approach (root-cause-debug, deep-debugger, /escalate) and keep going until done
C23 | Grep, then read line ranges; no cat of big files; show failing test lines only
C24 | Delegated work returns <=300 words with file:line evidence; a smaller cap in the agent file or the brief wins
C25 | One task per session; compact at a natural seam, never stop a run for context size
C26 | Every source file you create or substantially edit opens with a header comment (purpose, exports, invariants); a folder of 3+ files has a README
C27 | Public functions and types you create or substantially edit have doc comments (what, why, args, returns, errors); TODO(ref): reason
C29 | Done means the last `checks:` line is green, or its `none related`, `not run` and `old fail` are told as they are; say verified only for what you ran
C30 | Bash for the guard: write the command word out (no `$VAR` as the command) and secrets via env or file; when the guard bounces a command it gives the fix or the advice: send the fix, follow the advice (an unanswered ask stalls a run up to 2 min)
C31 | Human-first: a developer with no AI can find, read, run and change it; of two designs with the same result take the easier to read; never trade away scope, accuracy or a performance target for it
C32 | New files and folders follow the language or framework's standard layout and are named for what they hold; no new misc/utils/common folders; in an existing repo follow its layout (C17)
C33 | No abstraction with a single use: no interface with one implementation, pass-through wrapper, factory, generic layer or option "for later"; shared code is extracted per C2
C34 | Docs in proportion, in the repo's existing places and format: a small fix needs only a clear commit message; a new module or changed behaviour updates the README of its area; a choice others would question gets a decision record where the repo keeps them (else a comment or the commit body); a changelog line only if the repo keeps one
C35 | Config values you add or change explain themselves: a comment for any non-obvious value, units in the name or comment; do not split one setting across files; local values go in a git-ignored file with an example
C36 | C31-C35 govern new work and the lines a task changes. Existing code keeps its conventions (C17) and files the task does not need stay untouched (C18): no renames, moves, restructures, added headers or READMEs for old code unless the owner asks; report what you saw instead
C37 | Git history is one line at all times: rebase onto the base, land with `git merge --ff-only`, `git pull --rebase`, no merge commits; once landed, delete the branch and its worktree (`git-tidy prune`); a re-done lane continues its branch (never -N, -fixes, -vN); never rewrite commits on a shared remote branch without the owner's yes (the guard and the git-tidy gate enforce the rest)
