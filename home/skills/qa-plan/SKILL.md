---
name: qa-plan
description: Use when deciding which checks a change needs before calling it done - tests, typecheck, lint, build, review, new tests, edge cases, dependency, security, non-pixel UI. Reading the diff is review-checklist.
---

Write the plan into the detail file before the first check runs.

1. Inputs: base (the parent of the oldest commit in the brief's `commits:`), tip (the brief's `main:` sha), spec, acceptance
   lines. An empty range (`git diff --name-only <base>...<tip>` prints nothing) is `not checked: empty range`, never a pass.
2. Risk: `node ~/.claude/tools/risk/risk.mjs --base <base> --tip <tip> --repo <dir>`. `risk: unknown` counts as risky.
3. Kinds from `git diff --name-only <base>...<tip>`: code, tests only, docs or text only, dependencies (manifest or lockfile),
   UI (`.tsx .jsx .vue .css .scss .html`, styles), config or CI (`.github/`, Dockerfiles), the project's AI setup (`.claude/`,
   `CLAUDE.md`, `AGENTS.md`), pixel (a Figma or matrix brief: not tess's).
4. Commands: read them from the project, in this order: CI config (`.github/workflows/*.yml` and similar: what the team really
   runs), `package.json` scripts, Makefile, README, CONTRIBUTING. Never invent a command. A missing one is `not run (no command)`.
5. Check table:

   | Kind / risk | Checks |
   |---|---|
   | any code | typecheck; lint on changed files; related tests (the runner's own: `vitest related <files>`, `jest --findRelatedTests <files>`; else test files that import or are named for the changed files); build when the project has one; the `examples:` dev-docs listed, run in tess's check folder when they are local and safe |
   | risky or large, or no related-test mapping | the full suite instead of related tests (only with `suite: yes`); build; review; edge cases; base comparison for every failure |
   | dependencies | `<pm> audit --prod` at high severity (network: `not run (network)` when offline); lockfile diff: new packages, `hasInstallScript`, widened ranges, a new registry or a git or URL source; osv-scanner when installed |
   | security class | `standards/security.md` S1-S11 against the diff; gitleaks on the range when installed (`gitleaks git --log-opts="<base>..<tip>" --redact`) |
   | UI, non-pixel | ui-quality-pass items 1-8 read against the diff; the project's a11y or e2e tests; `ui-check responsive` at 320, 768, 1280 only when the brief gives a URL |
   | tests only | run them; the "can it fail" check (tess, "Verify tess-write's tests") |
   | docs or text only | none (links: `node ~/.claude/tools/refs/refs.mjs check .` when the repo uses it) |
   | AI setup or CI | the repo's own tests for them; review on the gate class |
   | smoke (`qa: smoke`) | When dev's report has `smoke: <command> \| expect: <observable>`: one `tess-run` call runs it 1 time (a code path) or 3 times (the result depends on the model's choices), every `claude` start with `--model sonnet --output-format stream-json --verbose`, each try in `<detail dir>/smoke/try-<n>/`: `command.txt`, `stdout.jsonl`, `stderr.txt`, `exit.txt`, `seconds.txt`, and the check line `expect \| observed \| PASS/FAIL`. A usage-limit stop is `not run (limit, resets <time>)`. Nothing waits for it. |
   | e2e (`qa: e2e`) | only when the owner asks, or a final pass; never per feature: tess's `e2e` section (`node tests/e2e/run.mjs --all`) |

   A tool that is not installed (gitleaks, osv-scanner, Playwright) or an audit with no network is `not run (<why>)`, never a
   pass; on a risky feature it keeps the verdict from `main: ok`.
6. Acceptance map: each acceptance line -> the test that proves it (`file::name`) or `uncovered` (a case for tess-write).
7. Edge-case list, only for a risky change or one the brief asks for, by what changed: input parsing (empty, missing, huge, unicode, hostile names), paths (spaces, Windows `\`,
   symlinked `~/.claude`), files and state (two runs at once, crash midway, stale lock or temp file), time (`datetime-handling`),
   error paths (a failed read taken as empty), upgrade and rollback (old data, old config). Each probe names what it touches and
   runs with a temporary `HOME`, `USERPROFILE` and `TMPDIR` (`mktemp -d`), never the real `~/.claude`, a real database or a
   live system.
8. Test-file changes inside a code diff: list each edited or deleted assertion and each new skip, `.only`, `todo` or raised timeout
   as a finding candidate (agents edit tests to pass them).
9. Order: cheap and narrow first (typecheck, lint, related tests), then build and suite. Run the full suite directly, once per
   main sha: only with `suite: yes`, recorded in `<git common dir>/cs-suite/<sha>.txt`. Run every planned check; never stop at
   the first failure.

Done-gate: the plan names every check with its command or `not run (why)`, the acceptance map has no blank line, and the
edge-case list names what each probe touches.

## Which tess work a change gets (the boss routes by this)

| Change | tess work (`qa:`) | When | Landing |
|---|---|---|---|
| docs, comments or text only, `risk: none` | none | - | lands |
| code, `risk: none` (dependency and non-pixel UI too) | `checks` (+ `deps`, `ui` by kind); tess-write fills untested acceptance lines | in the next tess round on main: 3 features landed and not checked, or the job's last piece landed; nothing waits | lands at once |
| risky: security, data, money, concurrency, gate, large | `full`: full suite, build, review, edge cases | on main at once after the risky piece lands; no new piece touches its feature's files until tess returns | lands first, then tess |
| the owner asks (test, review, write tests, check X) | what was asked, on main | at once | as asked |
| a Claude-facing feature first works (dev's `smoke:` line) | `qa: smoke`: 1-3 real Claude tries, recorded | at once | nothing waits |
| pixel work | none: dev-pixel and pixel-qa; its logic code follows the rows above | - | - |

tess checks only main, one feature per tess, started only by the boss. Its brief: `qa:`, `repo:`, `main: <sha>`, `worktree:` (the
snapshot lane the boss claimed at that sha), `feature:`, `commits:` (the feature's landed commits, from `board tick`),
`suite: yes|no` (`yes` on exactly one tess per sha), `spec:`, `acceptance:`, `risk:`. tess replies `main: ok` or `main: must-fix <n>`.
