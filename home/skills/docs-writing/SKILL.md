---
name: docs-writing
description: Use when writing or changing docs or text a person reads - README, guides, API docs, changelog, release or migration notes, runbooks, error messages, help text, CLI output, UI copy. Preloaded by dev-docs.
---

Rules: X1-X11 (`~/.claude/standards/docs.md`), the Documents table and the no-AI test in `~/.claude/standards/readability.md`,
C34. Project documents are written for people and never mention AI.

1. Find what the change makes stale: grep the changed names, commands and flags in `*.md`, help texts and string files. Could a
   developer with no AI find, run and change it from these docs alone?
2. Pick the doc type for each page (X5): tutorial, how-to, reference or explanation. One page, one type.
3. Write by X6-X10: errors say what happened and what to do next, CLI text follows X7, one plain style.
4. Terms (X8): one word per concept, the same in UI, docs, errors and CLI. List them as `terms:`, with any clash you found in
   existing docs or UI.
5. Examples (X11): copy each command, path, flag and output from the code or a real run. List them as `examples:` for tess.
6. Keep it in proportion (C34): a small fix needs only its commit message; changed behaviour updates the README of its area; a
   changelog line only if the repo keeps one.

Done-gate: every stale doc updated or listed; `terms:` and `examples:` in the report; no command in a doc that does not exist.
