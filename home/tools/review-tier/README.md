# review-tier

Reads a git range and says which reviews to run together for it: the agent, model, effort, lens, a ready brief and the
checks to plan (stress, race, mutation). It only ADDS planned checks: reviewers and auditors keep their own loops, stress
and mutants; the only thing the plan replaces is a full-suite re-run (the test-pass record covers that). Node 22, no
dependencies; it reads git and writes one log line.

Run: `node ~/.claude/tools/review-tier/review-tier.mjs [<range>] [--landing] [--delta <reviewed-sha>] [--lane-classes <file>] [--add-class <c>]... [--base <b>] [--json]`

| Argument | Meaning |
| -------- | ------- |
| `<range>` | `a..b` or `a...b`. Default `<base>...HEAD`, the base being the first of main, master, develop. |
| `--landing` | The last review before the base moves: adds the Opus max lens, the auditor at Opus max (tier 1 and up) and a mutation plan for a code diff. |
| `--delta <sha>` | A fix round: only what changed since the reviewed sha. A sha that is no longer an ancestor (a rebased lane) lists only the lane commits whose patch the reviewed set does not hold. Callers of the changed functions (named on an added line or in the `@@` hunk header, so a fix inside a body counts) and the definitions the changed lines call (at most 20 `file:line` together) go in as required reading. |
| `--lane-classes <file>` | The `--json` of the previous round. Each file keeps the classes (and the plan kind) it had in the lane, so a small fix to a file that was concurrency code still gets the stress plan. |
| `--add-class <c>` | The lead raises the set: adds that class's reviews and plan. It never removes one. An unknown class is exit 2. |

Exit 0 printed, 1 git failed (not a repository, git error), 2 usage (bad range, unknown sha, base or class, bad flag).
Text output: `review-tier: tier <n> (<classes>), <files> files, <lines> changed lines, <range>`, then `why:` (one
`<class> <path>:<line>` per class), `run together:` (one line per review) and the command for the next fix round.
`--json` prints the whole report: `tier`, `classes`, `added`, `landing`, `range`, `files`,
`changedLines`, `hits`, `fileClasses`, `reviews` (each with `plan: {stress, race, mutation}` and `requiredReading`), `deltaOf`.
Line texts are matched in memory and never printed or logged. The log is `~/.claude/logs/review-tier.jsonl`
(`REVIEW_TIER_LOG` overrides; folder 0700, file 0600): `ts, repo, range, tier, classes, files, changedLines, landing, added`.

## Classes and sets

Highest tier wins; classes add up. Path tests are lower-case; line tests read the `+` and `-` lines of `git diff -U0` of
code files (not tests, docs or prose files); a "file also has" condition reads the whole new file.

| Class (tier) | Hit by | Reviews added |
| ------------ | ------ | ------------- |
| docs (0) | README, CHANGELOG, LICENSE, `docs/`, `.md .txt .png .jpg` that are not behaviour text | none mid-lane; at `--landing` the Sonnet lens |
| behaviour, tests, logic, ui, infra (1) | `CLAUDE.md`, `.claude/`, `home/{modes,rules,agents,skills,standards,workflows}/`; test paths; anything else; `.tsx .vue .css`...; Dockerfile, `.github/`, `.tf` | Sonnet high correctness lens (`reviewer`, rules `core` plus the domain); ui adds the `ui-quality-pass` skill line |
| security (2, risky) | path words (auth, session, token, secret, permission, guard, crypto ...), lockfiles; lines with exec, spawn, eval, innerHTML, password, secret, cookie, Authorization, `$queryRaw` ... | Opus max lens + auditor Opus max + mutation plan |
| data (2, risky) | migrations, prisma, `.sql`, `schema.`; ALTER/DROP/CREATE/DELETE FROM/TRUNCATE, `deleteMany`, `.delete({` ... | same |
| money (2, risky) | payment, invoice, billing, refund, checkout, stripe, wallet, ledger (path or line; `git checkout` excluded) | same |
| untrusted-input (2, risky) | `req.body`, `JSON.parse(`, `process.stdin`, `fetch(` and `path.join(` with a non-literal argument (`__dirname`, `process.cwd()`, `homedir()` count as literal) | same |
| audit (2) | a file under `hooks/` with no security hit | auditor Opus high mid-lane, Opus max at `--landing` |
| size (2) | more than 400 changed lines | Opus high lens |
| concurrency-lite (2) | `link(`, `Promise.all(`, timers, in a file that also writes | Opus high lens + stress or race plan |
| concurrency (3, risky) | a `lock` path or word, mutex, flock, `O_EXCL`, `'wx'`, transactions; `rename(`, `unlink(`, `rm(`, `rmdir(`, `mkdir(` without `recursive`; `existsSync(`/`stat(` in a file that also writes, renames, removes or opens | Opus max lens + the plan below |

Every `--landing` of tier 1 or more adds the Opus max lens and the auditor at Opus max (the last review before a push).

## The plan (checks to run, never fewer than the reviewer would choose)

- stress (a lock: lock words, `O_EXCL`, `'wx'`, a lock file name, `link(`): `{staleLock: true, killPct: 5, waiters: [8, 20], repeats: 3, count: ['double-holders', 'lost-updates']}`: seed a lock file with a dead pid aged past the code's stale limit, kill about 5 % of holders mid-turn, run at 8 and at 20 waiters.
- race (lock-free: rename, rm, unlink, mkdir, stat-then-act, `Promise.all`, timers): `{runs: 200}`: run the two actors concurrently that many times and assert the invariant, or the reviewer writes `not applicable: <reason>`. Stale-lock numbers mean nothing for these, so they get no stress plan (lead decision 2 of round 4).
- mutation `{maxMutants}`: any risky class, and every `--landing` of a code diff; at most one mutant per changed line and 7 per changed file.
- The correctness lens gets no plan; the risk lens and the auditor do. The auditor gets the stress or race plan only when concurrency and security hit the same file.

## Choices a reader may question

- `hooks/` is the `audit` class, not security (the spec lists it in both): a hooks file with a real security hit is security.
- Tests, docs and prose (`.md`) are not scanned by line, and docs carry no risky class by path, so a README that talks about passwords is still tier 0.
- A bare `exec(` counts only in a file that mentions `child_process` or `execa` (a regex `.exec(` is not a shell).
- A delta unions each file's earlier classes with its new ones (a file never drops a class inside a lane); the diff-level `size` class is computed from the delta's own lines.
- Hits are capped at 20 per class and file, so a generated file cannot make the JSON huge; the class still applies.

Files: `review-tier.mjs` (CLI), `tiers.mjs` (class rules), `lib/diff.mjs` (git reading, delta, required reading), `lib/reviews.mjs`
(sets, plans, briefs), `lib/report.mjs` (report, text, JSON), `lib/log.mjs`. Tests: `tests/review-tier.test.mjs`.
