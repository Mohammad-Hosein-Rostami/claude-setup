---
name: clean-code
description: Use when writing or changing code, and again before finishing a coding step - naming, size, complexity, types, errors, comments, duplication, dead code, scope.
---

The code-level half of the core rules (the C ids are the ones dev's agent file lists). Enforce the limits with the project's
linter where it has one.

1. Scope: build only what the task asks (C1, KISS and YAGNI); touch only the files it needs (C18); fix the root cause, not the
   symptom, at every site of its class (C22).
2. Names say what a thing is or does: nouns for types, verbs for functions, `is/has/can` for booleans; no `data`, `util`,
   `helper`, `manager`, `temp` (C5). One word per concept everywhere.
3. One function, one job (C3): at most 40 lines, 4 parameters (an options object beyond), nesting 3, complexity 10, cognitive
   complexity 15. Files at most 300 lines, split by responsibility (C4).
4. Early returns over deep nesting. Named constants, not magic numbers or strings (C6). Prefer `const`/readonly and pure
   functions; side effects at the edges (C20).
5. Types (C19): strict mode, no `any`, no unexplained `!`, exhaustive `switch`; no cast to silence a type error.
6. Errors (C9, C10): never swallow (`catch {}`); fail fast where the failure starts; validate external input at the boundary
   with a schema and trust internal types after it; throw typed errors that keep the cause; no floating promises.
7. Comments say why, never what; delete dead and commented-out code (C8). A file you create or substantially edit opens with a
   header comment: purpose, exports, invariants (C26). Public functions and types you create or change get a doc comment: what,
   why, args, returns, errors; `TODO(ref): reason` (C27).
8. Duplication: look for an existing helper first; extract on the third copy (C2). Prefer duplication over the wrong
   abstraction: no interface with one implementation, pass-through wrapper, factory, generic layer or option "for later" (C33).
9. Composition over inheritance; an interface only at a real boundary (an external system, a second implementation or a test
   double), owned by the consumer (C7); no long chains (`a.b.c.d()`).
10. Match the neighbours: read two nearby files and copy naming, error style and imports first (C17). Leave formatting to the
    formatter (C21).
11. Read `~/.claude/standards/readability.md` (C31-C36). It governs new work and the lines you change, not old code. Last step,
    the no-AI test: could a developer with no AI find, run, read and change this from the repo alone?

Before finishing, check the smells agents leave behind:

| Smell | Find it with |
| ----- | ------------ |
| Giant file/function | `max-lines`, `max-lines-per-function`, `complexity` |
| Copy-paste | `jscpd` |
| Unused code or exports | `knip`, `tsc --noUnusedLocals` |
| Defensive code for impossible states | `no-unnecessary-condition`, `no-useless-catch` |
| `any`, casts, non-null assertions | `no-explicit-any`, `no-non-null-assertion`, `tsc --strict` |
| One-implementation interface, wrapper, factory | count the callers |
| `process.env` or hard-coded hosts outside config | grep |
| Diff touches more than the task needs | `git diff --stat` (C18) |
| Deleted, skipped or weakened tests | grep the diff for `skip`, `.only`, `ts-ignore`, `eslint-disable` (C13) |

Done-gate: lint clean at these limits; no new duplicate blocks; every new abstraction has a named caller; no check weakened.
