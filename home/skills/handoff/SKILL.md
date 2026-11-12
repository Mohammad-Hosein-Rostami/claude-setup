---
name: handoff
description: Write a compact handoff note so work can continue in a fresh session after /clear. Use at a phase change, before /clear, or when the user says handoff or continue later.
disable-model-invocation: true
effort: low
---

Write `HANDOFF.md` in the scratchpad or project root (max 40 lines):

1. **Goal** and constraints (user's words where they matter).
2. **Done**: files changed (paths), decisions and why.
3. **State**: what passes or fails now, exact error text.
4. **Next steps**: ordered, each concrete enough to run without asking.
5. **Don't redo**: dead ends already ruled out.

Then tell the user: run `/clear`, then "continue from HANDOFF.md". Delete the file once the next session has absorbed it.
