---
name: handoff
description: Use when work must carry over to a fresh session - at a phase change, after repeated compactions, before /clear, or when the user says handoff or continue later. Writes a compact HANDOFF.md.
effort: low
---

Write `HANDOFF.md` in the project root (never committed: hide it with `.git/info/exclude`), max 40 lines, in this order:

1. **Goal** and constraints (user's words where they matter).
2. **Rules**: the standing rules the owner gave for this job, one line each.
3. **Decisions**: one item each, with why.
4. **Files touched**: from `git status --porcelain` and `git log --oneline <start>..HEAD` (paste the command output, never
   from memory); the branch and head sha the same way. Then the session id (`echo $CLAUDE_CODE_SESSION_ID`) and its agents,
   with their branches and folders, from `node ~/.claude/tools/board/board.mjs show --refresh`, and every open branch and
   worktree from `git worktree list`, each pasted as printed (never kept by hand); the note adds only each one's owner and
   what it waits for.
5. **Last check**: the command run and its exact result or error text (copied from the log).
6. **Open questions**: each with who decides.
7. **Next**: ordered steps, each concrete enough to run without asking.
8. **Don't redo**: dead ends already ruled out, one `-` item each.
9. **Surprises**: what behaved other than expected.
10. **Reports**: only the paths of report files agents wrote; never their content.

Entries are itemized and updated in place: add, mark done or edit one item; never rewrite the note from the old one, and
keep every earlier item word for word unless it is wrong (then mark it, do not delete it). The boss keeps no running log of
lanes and agents; it writes this note only before a restart.

Then tell the user: run `/clear`, then "continue from HANDOFF.md". Delete the file once the next session has absorbed it.
