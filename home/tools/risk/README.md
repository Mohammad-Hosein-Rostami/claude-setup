# risk

Prints one line naming the risk classes a change falls in (security, data, money, concurrency, gate, large), or `none`.

Says which risk classes a change falls in, so the boss knows whether landing waits for tess: `security` (login, sessions,
tokens, secrets, permissions, uploads), `data` (migrations, schemas, SQL), `money` (payments, billing, refunds), `concurrency`
(locks, queues, workers), `gate` (the setup's own hooks, gate tools and steering texts, a project's CI, git hooks and Claude Code
settings) and `large`. It runs only when someone calls it (dev before its report, tess in its `qa-plan`); no hook or setting
calls it. Node 22, git, no dependencies.

```sh
node ~/.claude/tools/risk/risk.mjs --base <rev> [--tip <rev>] [--repo <dir>] [--json]
```

- The change is the merge base of `--base` and `--tip` compared with `--tip` (what `git diff <base>...<tip>` shows), so a base
  branch that moved on does not count its own commits. Without `--tip` it is the merge base compared with the worktree, with
  uncommitted and untracked files.
- `--repo` is any folder inside the repository (default: the current folder).

Output, one line on stdout:

```text
risk: none (12 lines, 2 files)
risk: security, gate (230 lines, 7 files)
risk: unknown (no commit named "nope")
```

Classes come in a fixed order: security, data, money, concurrency, gate, large (a class added to the rule file comes after them).
The counts are every changed line and file, tests and docs included. With `--json` a classified change prints
`{"classes":[{"class":"gate","file":"home/hooks/x.mjs"},{"class":"large","file":""}],"lines":530,"files":9}`; an unknown change
prints the same `risk: unknown (...)` line as without it.

| Exit | Meaning |
| ---- | ------- |
| 0 | classified (`none` included) |
| 1 | unknown: git failed, a revision names no commit, or the folder is not a repository. Unknown counts as risky. |
| 2 | usage error (no `--base`, an unknown option or a stray word) |

## How a file is classed

- A path is read in lower case with `/` separators (a Windows `\` counts as one) and a space where a name changes case, so
  `sessionLock.ts` reads `session lock.ts` and `JWTService.ts` reads `jwt service.ts`.
- `words` match one whole word of a folder or file name: `useSession.ts` and `src/auth/` are security, `tokenizer.ts`,
  `author.ts` and `guardian.ts` are not. `paths` match anywhere in the path. `checkout` and `ledger` are not money words.
- Tests by their own name (`*.test.ts`, `*.spec.js`) and plain docs (`.md`, `.txt`) are left out: in no class and not counted
  for `large`. The steering texts are kept (agent files, `SKILL.md`, `CLAUDE.md`, `AGENTS.md`, the rules, settings): they are
  `gate` and count like code.
- A JavaScript or TypeScript file whose changed lines are all comments or blank lines is left out. Any doubt (a deleted file, a
  git error, an unreadable file, a Vue file) keeps the class.
- `large` is more than 400 changed lines or more than 15 changed files, both without the left-out files.

## Tuning the rules

The rules are restored from the removed done-check classifier. The `gate` class covers, among others, the setup's gate tools,
CI workflows, husky hooks and the `.claude` settings and hooks.

The classes live in `risk-rules.json` (version 2: `leftOut`, `keep`, `classes.<name>.paths` or `.words`, `large.lines`,
`large.files`; every entry is a regular expression read against the path form above). Edit that file, then make
`DEFAULT_RISK_RULES` in `lib/risk.mjs` equal to it (the built-in copy used when the file is missing or invalid; a test checks the
two are equal). A bad rule file never switches the classes off: the built-in rules apply and a warning goes to stderr.

Files: `risk.mjs` (the command), `lib/range.mjs` (the changed files and lines from git), `lib/risk.mjs` (the classes),
`lib/code-lines.mjs` (which lines hold code). Tests: `tests/risk-tool.test.mjs`.
