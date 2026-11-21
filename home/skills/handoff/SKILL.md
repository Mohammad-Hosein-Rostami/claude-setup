---
name: handoff
description: Write a compact handoff note so work can continue in a fresh session after /clear. Use at a phase change, after repeated compactions, before /clear, or when the user says handoff or continue later.
effort: low
---

Write `HANDOFF.md` beside the session's `STATUS.md` (else in the project root), max 40 lines. It uses the digest's
template, in this order, so the next session reads the same sections the compaction digest prints:

1. **Goal** and constraints (user's words where they matter).
2. **Rules**: point to `STATUS.md` `## Standing rules` (added with `status.mjs rule`, ids `R<n>`); copy none here.
3. **Decisions**: one item each, with why.
4. **Files touched**: from `git status --porcelain` and `git log --oneline <start>..HEAD` (paste the command output, never
   from memory); the branch and head sha the same way.
5. **Last check**: the command run and its exact result or error text (copied from the log).
6. **Open questions**: each with who decides.
7. **Next**: ordered steps, each concrete enough to run without asking (also `status.mjs next <row> "<step>"`).
8. **Don't redo**: dead ends already ruled out, one `-` item each (the session-start notice and the digest print this list).
9. **Surprises**: what behaved other than expected.
10. **Reports**: only the report paths (their name format is stated in `reviewer.md` and `security-auditor.md`); never
    their content.

Entries are itemized and updated in place: add, mark done or edit one item; never rewrite the note from the old one, and
keep every earlier item word for word unless it is wrong (then mark it, do not delete it).

Then tell the user: run `/clear`, then "continue from HANDOFF.md". Delete the file once the next session has absorbed it.
