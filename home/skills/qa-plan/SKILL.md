---
name: qa-plan
description: Use when deciding which checks a change needs before calling it done - tests, typecheck, lint, build, review, new tests, edge cases, dependency, security, non-pixel UI. Reading the diff is review-checklist.
---

Write the plan into the detail file before the first check runs.

1. Inputs: base (the `from` of the oldest `<from>..<to>` range in the brief's `commits:`), tip (the brief's `main:` sha),
   spec, acceptance lines. An empty range (`git diff --name-only <base>...<tip>` prints nothing) is `not checked: empty
   range`, never a pass.
2. Risk: `node ~/.claude/tools/risk/risk.mjs --base <base> --tip <tip> --repo <dir>`. `risk: unknown` counts as risky.
3. Kinds from `git diff --name-only <base>...<tip>`: code, tests only, docs or text only, dependencies (manifest or lockfile),
   UI (`.tsx .jsx .vue .css .scss .html`, styles), config or CI (`.github/`, Dockerfiles), the project's AI setup (`.claude/`,
   `CLAUDE.md`, `AGENTS.md`), pixel (a Figma or matrix brief: not tess's).
4. Commands: read them from the project, in this order: CI config (`.github/workflows/*.yml` and similar: what the team really
   runs), `package.json` scripts, Makefile, README, CONTRIBUTING. Never invent a command. A missing one is `not run (no command)`.
5. Check table. The default is the quick look (`qa:` empty or `quick`), the first three rows: one short pass, one
   `tess-run` call, no other helper. The rest run only when the owner asked in chat (the brief's `qa:` names it); smoke
   runs on dev's `smoke:` line.

   | Kind / `qa:` | Checks |
   |---|---|
   | quick test (any code, tests only, AI setup or CI) | related tests (the runner's own: `vitest related <files>`, `jest --findRelatedTests <files>`; else the test files the diff changed and those that import or are named for the changed files); the project's typecheck, else a syntax check of each changed file (`node --check`, `bash -n`, `python -m py_compile`); a failing one also on the base (new or old) |
   | quick review (any change) | you read the diff once against the brief, the spec and the acceptance lines (steps 6 and 8); no probes, no second round |
   | docs or text only | none (links: `node ~/.claude/tools/refs/refs.mjs check .` when the repo uses it) |
   | `full` (owner asks) | lint on changed files; the full suite instead of related tests (only with `suite: yes`); build when the project has one; the `examples:` dev-docs listed, run in tess's check folder when they are local and safe; tess-review and tess-simple; edge cases (step 7); tess-write for uncovered lines; the rows below by kind |
   | `deps` (owner asks, or in `full`) | `<pm> audit --prod` at high severity (network: `not run (network)` when offline); lockfile diff: new packages, `hasInstallScript`, widened ranges, a new registry or a git or URL source; osv-scanner when installed |
   | security class (in `full` or `review`) | `standards/security.md` S1-S11 against the diff; gitleaks on the range when installed (`gitleaks git --log-opts="<base>..<tip>" --redact`) |
   | `ui`, non-pixel (owner asks, or in `full`) | ui-quality-pass items 1-8 read against the diff; the project's a11y or e2e tests; `ui-check responsive` at 320, 768, 1280 only when the brief gives a URL |
   | `tests` (owner asks) | tess-write's tests; the "can it fail" check (tess, "Verify tess-write's tests") |
   | AI setup or CI (in `full` or `review`) | review on the gate class |
   | smoke (`qa: smoke`) | When dev's report has `smoke: <command> \| expect: <observable>`: one `tess-run` call runs it 1 time (a code path) or 3 times (the result depends on the model's choices), every `claude` start with `--model sonnet --output-format stream-json --verbose`, each try in `<detail dir>/smoke/try-<n>/`: `command.txt`, `stdout.jsonl`, `stderr.txt`, `exit.txt`, `seconds.txt`, and the check line `expect \| observed \| PASS/FAIL`. A usage-limit stop is `not run (limit, resets <time>)`. Nothing waits for it. |
   | e2e (`qa: e2e`) | only when the owner asks, or a final pass; never per feature: tess's `e2e` section (`node tests/e2e/run.mjs --all`) |

   A tool that is not installed (gitleaks, osv-scanner, Playwright) or an audit with no network is `not run (<why>)`, never a
   pass; on a risky feature it keeps the verdict from `main: ok`.
6. Acceptance map: each acceptance line -> the test that proves it (`file::name`) or `uncovered` (a follow-up; in `full`, a tess-write case).
7. Edge-case list, only in `full` or `edge`, by what changed: input parsing (empty, missing, huge, unicode, hostile names), paths (spaces, Windows `\`,
   symlinked `~/.claude`), files and state (two runs at once, crash midway, stale lock or temp file), time (`datetime-handling`),
   error paths (a failed read taken as empty), upgrade and rollback (old data, old config). Each probe names what it touches and
   runs with a temporary `HOME`, `USERPROFILE` and `TMPDIR` (`mktemp -d`), never the real `~/.claude`, a real database or a
   live system.
8. Test-file changes inside a code diff: list each edited or deleted assertion and each new skip, `.only`, `todo` or raised timeout
   as a finding candidate (agents edit tests to pass them).
9. Order: cheap and narrow first (typecheck, lint, related tests), then build and suite. Run the full suite directly, once per
   main sha: only with `suite: yes`, recorded in `<git common dir>/cs-suite/<sha>.txt`. Run every planned check; never stop at
   the first failure.

Done-gate: the plan names every check with its command or `not run (why)`, the acceptance map has no blank line, and (in
`full` or `edge`) the edge-case list names what each probe touches.

## Which tess work a change gets (the boss routes by this)

| Change | tess work (`qa:`) | When | Landing |
|---|---|---|---|
| docs, comments or text only, `risk: none` | none | - | lands |
| code, `risk: none` (dependency and non-pixel UI too) | the quick look | in the next tess round on main: 3 features landed and not checked, or the job's last piece landed; nothing waits | lands at once |
| risky: security, data, money, concurrency, gate, large | the quick look; the boss names the risk to the owner in one line, so the owner can ask for `full` | on main at once after the risky piece lands; no new piece touches its feature's files until tess returns | lands first, then tess |
| the owner asks in chat (`full`, review, write tests, edge cases, check X) | what was asked, on main | at once | as asked |
| a Claude-facing feature first works (dev's `smoke:` line) | `qa: smoke`: 1-3 real Claude tries, recorded | at once | nothing waits |
| pixel work | none: dev-pixel and pixel-qa; its logic code follows the rows above | - | - |

The boss routes on the higher of dev's report `risk:` and lex's plan `risk:` and `qa:` for the feature (`risk: unknown` is
risky). tess checks only main, one feature per tess, started only by the boss, which claims a snapshot lane per tess at
main's sha X (`node ~/.claude/tools/git-tidy/git-tidy.mjs lane claim --repo <abs> --snapshot --base <X>`) and runs
`lane release` after that tess returns. Its brief: `qa:`, `repo:`, `main: <sha>`, `worktree:` (that snapshot lane),
`feature:`, `commits:` (the tick's `commits <feature>:` line, one `<from>..<to>` range per land), `suite: yes|no` (only with
`full`: `yes` on exactly one tess per sha; the others reuse its result), `spec:`, `acceptance:`, `risk:`. tess replies `main: ok` or
`main: must-fix <n>`. The boss re-checks a must-fix's repro in a snapshot lane of the newest main before it becomes the next
piece.
