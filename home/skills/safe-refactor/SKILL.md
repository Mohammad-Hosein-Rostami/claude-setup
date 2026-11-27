---
name: safe-refactor
description: Use when restructuring code without changing behaviour, including renames, extractions and moves.
---

Rules: R1-R4 (`~/.claude/standards/refactor.md`), C1-C4, C18.

This skill is for code-level refactors. A whole-repository restructure (removing a build tool, merging packages, folder moves with config changes) uses `repo-restructure`.

1. State the goal and the behaviour that must not change. If the goal needs a behaviour change, split it out first.
2. Check coverage of the code to move. If thin, read every caller and, where the project has tests, name the characterisation tests that would pin current behaviour (odd outputs too), for tess-write, before the move.
3. Capture the public API (exports, route shapes, schemas) as a baseline list.
4. Work in mechanical steps: rename, extract, move, inline. After each step every user of a changed name follows, tests included (Grep the old name: no hit left), then commit it (C16); name the related tests of the code you move for tess, which runs them on the base after the land.
   For renames and structural matches, prefer the LSP tool (references) or `ast-grep` (`sg run -p '<pattern>'`) over regex.
5. Never mix a refactor and a behaviour change in one commit. A test that names an old name (an import, a call) you update yourself, by reading: change only that name, keep what it checks (never delete, skip or loosen it, C13), never run it, and name it as `stale pin: <file:line> <old> -> <new>`. Any other test that must change means behaviour changed: stop and explain.
6. Large moves: add the new path, switch callers in batches, delete the old path when none remain.
7. Delete dead code and unused exports (`knip`) (C8). Check size limits (C3, C4).
8. Diff the public API against the baseline: empty, or listed in the PR body.

Done-gate: no user of an old name left (the search you ran named); each test you updated for an old name listed as a stale pin; the related tests named for tess; API diff empty or listed.
