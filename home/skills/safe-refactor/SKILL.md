---
name: safe-refactor
description: Use when restructuring code without changing behaviour, including renames, extractions and moves.
---

Rules: R1-R4 (`~/.claude/standards/refactor.md`), C1-C4, C18.

1. State the goal and the behaviour that must not change. If the goal needs a behaviour change, split it out first.
2. Check coverage of the code to move. If thin, write characterisation tests that pin current behaviour (odd outputs too) and commit them first (T2).
3. Capture the public API (exports, route shapes, schemas) as a baseline list.
4. Work in mechanical steps: rename, extract, move, inline. Test after each; commit only when green (C16).
   For renames and structural matches, prefer the LSP tool (references) or `ast-grep` (`sg run -p '<pattern>'`) over regex.
5. Never mix a refactor and a behaviour change in one commit. Never edit a test to fit the refactor; if a test must change, stop and explain.
6. Large moves: add the new path, switch callers in batches, delete the old path when none remain.
7. Delete dead code and unused exports (`knip`) (C8). Check size limits (C3, C4).
8. Diff the public API against the baseline: empty, or listed in the PR body.

Done-gate: tests green before and after (exit codes quoted); API diff empty or listed; then `verify-done`.
