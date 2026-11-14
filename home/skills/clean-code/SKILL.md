---
name: clean-code
description: Use when writing or changing code, and again before finishing a coding step - naming, size, complexity, errors, comments, duplication, dead code, scope.
---

Limits match C3/C4; enforce with the project's linter.

1. Names say what a thing is or does: nouns for types, verbs for functions, `is/has/can` for booleans; no `data`, `util`, `helper`, `manager`, `temp` (C5).
2. One function, one job: complexity 10, cognitive 15, nesting 3, params 4 (options object beyond), 40 lines per function, 300 per file.
3. Early returns over deep nesting. Named constants, not magic values. Prefer `const`/readonly, pure functions, side effects at the edges.
4. Errors: never swallow (`catch {}`); validate at boundaries and trust internal types; throw typed errors that keep the cause; no floating promises (C9, C10).
5. Comments say why, never what; delete commented-out code. Public functions get a doc comment (C27).
6. Duplication: look for an existing helper first; extract on the third copy (C2). Prefer duplication over the wrong abstraction. YAGNI: no option, interface or layer with a single use (C33).
7. Composition over inheritance; an interface only at a real boundary (an external system, a second implementation or a test double), owned by the consumer; no long chains (`a.b.c.d()`).
8. Match the neighbours: read two nearby files and copy naming, error style and imports first (C17).
9. Read `~/.claude/standards/readability.md` (C31-C36). It governs new work and the lines you change, not old code. Last step, the no-AI test: could a developer with no AI find, run, read and change this from the repo alone?

Before finishing, check the smells agents leave behind:

| Smell | Find it with |
| ----- | ------------ |
| Giant file/function | `max-lines`, `max-lines-per-function`, `complexity` |
| Copy-paste | `jscpd` |
| Unused code or exports | `knip`, `tsc --noUnusedLocals` |
| Defensive code for impossible states | `no-unnecessary-condition`, `no-useless-catch` |
| One-implementation interface, wrapper, factory | count the callers |
| `process.env` or hard-coded hosts outside config | grep |
| Diff touches more than the task needs | `git diff --stat` (C18) |
| Deleted, skipped or weakened tests | grep diff (C13) |

Done-gate: lint clean at these limits; no new duplicate blocks; every new abstraction has a named caller. Then `verify-done`.
