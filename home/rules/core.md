# Core rules (always on): id | rule | check
C1 | KISS/YAGNI: build only what the task asks | rev
C2 | Reuse existing helpers; dedupe at the 3rd use | jscpd, rev
C3 | One job per function: <=40 lines, <=4 params, depth <=3 | eslint
C4 | Files <=300 lines; split by responsibility | eslint
C5 | Intent-revealing names; no data/tmp/util/helper | eslint, rev
C6 | No magic numbers or strings; use named constants | eslint
C7 | Depend on interfaces at real boundaries (an external system, a second implementation or a test double); compose over inherit | rev
C8 | Comments say why, not what; delete dead code | eslint, knip
C9 | Never swallow errors; no empty catch; fail fast | eslint, grep
C10 | Validate all external input at the boundary with a schema | grep, rev
C11 | New logic ships with a test that fails without it | rev
C12 | Before done, run the checks the owner asked for; list the rest as "not run" | rev
C13 | Never weaken checks: no ts-ignore, eslint-disable, skip, only | grep diff
C14 | Add no dependency unless needed; verify it exists | audit
C15 | No secrets in code, logs or commits | gitleaks
C16 | Small atomic Conventional Commits | commitlint
C17 | Match the repo's existing conventions; read neighbours first | rev
C18 | Touch only files the task needs | diff vs file list
C19 | TS strict, no any, no unexplained !, exhaustive switch | tsc, eslint
C20 | Immutable and pure by default; side effects at the edges | eslint, rev
C21 | Leave formatting to the formatter | formatter hook
C22 | Fix the root cause; when an approach fails twice, change approach (root-cause-debug, deep-debugger, /escalate) and keep going until done | rev
C23 | Grep, then read line ranges; no cat of big files; show failing test lines only | rev
C24 | Delegated work returns <=300 words with file:line evidence | rev
C25 | One task per session; compact at a natural seam, never stop a run for context size | usage
C26 | Every source file you create or substantially edit opens with a header comment (purpose, exports, invariants); a folder of 3+ files has a README | rev
C27 | Public functions and types you create or substantially edit have doc comments (what, why, args, returns, errors); TODO(ref): reason | rev
C29 | Done means fresh evidence: verify commands ran; no test deleted, skipped or weakened | verify-done
C30 | Bash for the guard: write the command word out (no `$VAR` as the command), secrets via env or file, no rm -rf or push in the same call as a heredoc or `$(...)`, no `rm -r` outside the project (leave scratchpad and temp folders: it always asks); the guard bounces these once with the fix, and the same command sent again asks (an unanswered ask stalls a run up to 30 s); a hand-edited lockfile or a merge that can create a merge commit is denied once with advice: follow it (no owner dialog) | guard log
C31 | Human-first: a developer with no AI can find, read, run and change it; of two designs with the same result take the easier to read; never trade away scope, accuracy or a performance target for it | rev
C32 | New files and folders follow the language or framework's standard layout and are named for what they hold; no new misc/utils/common folders; in an existing repo follow its layout (C17) | readable, rev
C33 | No abstraction with a single use: no interface with one implementation, pass-through wrapper, factory, generic layer or option "for later"; shared code is extracted per C2 | rev
C34 | Docs in proportion, in the repo's existing places and format: a small fix needs only a clear commit message; a new module or changed behaviour updates the README of its area; a choice others would question gets a decision record where the repo keeps them (else a comment or the commit body); a changelog line only if the repo keeps one | readable, rev
C35 | Config values you add or change explain themselves: a comment for any non-obvious value, units in the name or comment; do not split one setting across files; local values go in a git-ignored file with an example | rev
C36 | C31-C35 govern new work and the lines a task changes. Existing code keeps its conventions (C17) and files the task does not need stay untouched (C18): no renames, moves, restructures, added headers or READMEs for old code unless the owner asks; report what you saw instead | rev
C37 | Git history is one line: rebase onto the base and land with `git merge --ff-only`; no merge commits, no merging one branch into another, `git pull --rebase`; once landed, delete the branch and its worktree (`git-tidy prune`); never rewrite commits already on a shared remote branch without the owner's yes | git-tidy
