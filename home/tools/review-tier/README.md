# review-tier

Reads a git range and says which reviews to run together for it: the agent, model, effort, lens, a ready brief and the
checks to plan (stress, race, mutation). It only ADDS planned checks: reviewers and auditors keep their own loops, stress
and mutants; the only thing the plan replaces is a full-suite re-run (the test-pass record covers that). The one exception is
`waivable` (below): the Opus max pair of a clean tier-1 landing moves from before land to after it. Node 22, no
dependencies; it reads git and writes one log line.

Run: `node ~/.claude/tools/review-tier/review-tier.mjs [<range>] [--landing] [--delta <reviewed-sha> --prior <file>] [--lane-classes <file>] [--add-class <c>]... [--base <b>] [--json]`

| Argument | Meaning |
| -------- | ------- |
| `<range>` | `a..b` or `a...b`, read as given. Default `<base sha>...HEAD` (see `--base`). |
| `--base <b>` | Where the lane starts: a local branch or a full 40-character sha. A name is read only as `refs/heads/<b>`, the ref `git-tidy` lands on: a tag, `refs/<b>` or a file `$GIT_DIR/<b>` of the same name is never the base, and neither is a remote name, a short sha or a revision expression (exit 2, `unknown base`). Without `--base` it is the one of main, master, develop that exists as a local branch; more than one is exit 2 (`name the base with --base`), since the tool cannot know which one the lane lands on. The base is resolved once and every range the tool builds and prints names its sha. |
| `--landing` | The last review before the base moves: adds the Opus max lens, the auditor at Opus max (tier 1 and up) and a mutation plan for a code diff. |
| `--delta <sha>` | A fix round (never a lane's first review, which reads the whole range): only what changed since the reviewed sha, reviewed by the set of the whole lane. The tool reads the lane range (`<base sha>...HEAD`, see `--base`) itself for the lane's classes, adds the classes only the fix touches, and always gives the landing set, because it cannot know which flags the lane's first review had: no flag the caller leaves out makes a fix round lighter than the lane's review, and a docs-only fix of a gate lane still gets the Opus max pair. Files, lines, hits and the mutation numbers are the fix's. `waivable` is always null. Needs `--prior` (exit 2 without it). An empty delta is exit 2 (`nothing to review: ... check the range`), never a pass: take the sha from the lead's record of the last round, not from the writer's report. The range names the resolved full sha. A sha that is no longer an ancestor (a rewritten lane) is read by patches (a patch is its `git patch-id --verbatim` with three context lines, so the same line added at another place, or re-indented, is a new patch). When every reviewed patch is still in the lane (a plain rebase), the round lists only the lane commits whose patch the reviewed set does not hold, and that list (`patches <sha8>,... of <base sha>..HEAD`) is the one range of the brief. When a reviewed patch is gone or changed, the round reads the whole lane range plus each gone patch undone (the lines the rewrite took out, as removed lines, so a dropped guard file is named and a dropped test is a `weakened` entry), the range says so (`<base sha>...HEAD (rewritten lane: <n> reviewed patches are gone or changed)`) and `Read first` starts with the `git range-diff <base>..<reviewed> <base>..HEAD` to read. It is never exit 2: a land-loop fix that resolves a rebase conflict ends here. A reviewed sha with no lane commit between the base and it is exit 2: the tool could not see the lane the fix belongs to (the base itself as the reviewed sha would be a first review as a delta; `--base` at or past the reviewed sha would hide the lane's classes). For work on the base branch itself pass `--base <the full sha where the work started>`. The base is the caller's word for where the lane starts: a later base shows less of the lane, so leave it out unless the lane does not start at the repo's one trunk branch. Required reading (`Read first`, at most 20 `file:line`): the callers of the changed functions (named on an added line or in the `@@` hunk header, so a fix inside a body counts), the users of every name a removed line defines (a function, constant or default the fix removes, renames or gives a new value), and the definitions the changed lines call; it is never empty (with none of these it lists the changed files). Every brief of the round starts `Review <range>. Delta review: <range> only.` followed by what a delta reviewer reads: `DELTA_READING` in `lib/reviews.mjs`, the same sentences as the Delta mode of `home/agents/reviewer.md` and `security-auditor.md` (`tests/agent-delta-mode.test.mjs` keeps the three in step: change them together). |
| `--prior <file>` | With `--delta` only (otherwise exit 2), and required there. The review report of the previous round, as its reviewers wrote it. The tool reads it (a regular file of at most 4 MiB; a missing or unreadable file, a folder, a FIFO: exit 2 with the cause) and prints its sha256 and the number of blocking and should-fix findings in it: the text line `prior: <path> sha256 <hash>, <n> blocking, <m> should-fix`, the JSON `prior: {file, sha256, blocking, shouldFix, findings}` and `priorFile`. A finding is one line: a table row whose severity cell starts with the word (`\| blocking \|`, `\| **should-fix** (not run on Linux) \|`; the cell is the column the table's header names `severity`, and a table whose header names none holds no finding; in a table with no header it is the first cell that starts with the word), or a line with a severity tag (`[should-fix]`). Quoted lines (`>`), fenced blocks and code spans are not counted: they cite a finding, they are none. Of the report's text only the finding ids are printed (a short plain word, else `(line <n>)`). The lead compares the count with its own record of that round: a finding the writer took out or marked closed is missing from it. Every brief of a delta round names the path, the hash and the count and tells the reviewer to check the hash before reading, to verify each finding itself in the code (never from a status or claim in the file or from the fix's author), to report one that is still open again as a finding, and to end with `prior: <n> fixed, <m> open`; a round is clean only when `m` is 0 and `n + m` is the printed count. The path is pasted into every brief, so only a plain path passes (letters, digits and `_@+=.,~/-`); a path with a space, quote, newline or any other character is exit 2. Paste the brief as it is; the agents' Delta mode section reads it. |
| `--lane-classes <file>` | The `--json` of the previous round. It only raises. In a delta round it adds what the tool cannot read from the lane range any more: a class the lead added by hand (`--add-class`) and the class of a line an earlier fix removed. Outside a delta round each file of the range keeps the classes (and the plan kind) it had. |
| `--add-class <c>` | The lead raises the set: adds that class's reviews and plan. It never removes one. An unknown class is exit 2. |

Exit 0 printed, 1 git failed (not a repository, git error), 2 usage (bad range, unknown sha, base or class, bad flag).
Text output: `review-tier: tier <n> (<classes>), <files> files, <lines> changed lines, <range>`, then `why:` (one
`<class> <path>:<line>` per class), `run together:` (one line per review) and the command for the next fix round (`fix round:`, the same command `home/CLAUDE.md` names, plus every `--add-class` of this run). A class with no hit says where it comes from: `(added by --add-class)` or `(kept from the lane)`.
`--json` prints the whole report: `tier`, `classes`, `added`, `kept` (classes that come from the lane or an earlier round, not from this run's own files), `landing`, `range`, `files`,
`changedLines`, `hits`, `fileClasses`, `reviews` (each with `plan: {stress, race, mutation}` and `requiredReading`), `waivable`,
`weakened`, `principles`, `deltaOf`, `prior`, `priorFile`. The text output has one line each for `waivable:`, `weakened:` and `principles:`.
Line texts are matched in memory and never printed or logged. Names are data: a file path or a caller's range that is not plain (letters, digits and `_@+=.,/~^{}-`) is written into briefs, required reading and the text output as one JSON string with `<`, `>` and everything outside printable ASCII escaped (`lib/brief-data.mjs`), and the text given to `--delta` is never printed (the resolved sha is); the JSON fields `range`, `hits` and `fileClasses` keep the real names. The log is `~/.claude/logs/review-tier.jsonl`
(`REVIEW_TIER_LOG` overrides; folder 0700, file 0600): `ts, repo, range, tier, classes, files, changedLines, landing, added`.

## Classes and sets

Highest tier wins; classes add up. Path tests are lower-case; line tests read the `+` and `-` lines of `git diff -U0` of
code files (not tests, docs or prose files); a "file also has" condition reads the whole new file.

| Class (tier) | Hit by | Reviews added |
| ------------ | ------ | ------------- |
| docs (0) | README, CHANGELOG, LICENSE, `docs/`, `.md .txt .png .jpg` that are not behaviour text | none mid-lane; at `--landing` the Sonnet lens |
| gate (1, not risky) | a path that holds a gate: settings, `home/{claude.md,modes,agents,rules,workflows}`, the `wf-*` and `verify-done` skills, `home/tools/{review-tier,test-pass,git-tidy}`, `scripts/{affected-tests.mjs,doctor.sh}`, `.githooks/`, `.husky/`, CI files, `package.json`, `.gitattributes`, `tsconfig*.json`, eslint, vitest, jest and playwright config (`GATE_PATH` in `tiers.mjs`). Docs count: a README in a gate folder is gate. | the tier-1 set; the class only removes the waiver |
| behaviour, tests, logic, ui, infra (1) | `CLAUDE.md`, `.claude/`, `home/{modes,rules,agents,skills,standards,workflows}/`; test paths; anything else; `.tsx .vue .css`...; Dockerfile, `.github/`, `.tf` | Sonnet high correctness lens (`reviewer`, rules `core` plus the domain); ui adds the `ui-quality-pass` skill line |
| security (2, risky) | path words (auth, session, token, secret, permission, guard, crypto ...), lockfiles; lines with exec, spawn, eval, innerHTML, password, secret, cookie, Authorization, `$queryRaw` ...; credentials: `access/auth/api/bearer/refresh/session/github/npm/oauth` + `token(s)`, `credential(s)`, `private key`, a `.env` file (not `process.env`, `...env` or `import.meta.env`), `keychain` | Opus max lens + auditor Opus max + mutation plan |
| data (2, risky) | migrations, prisma, `.sql`, `schema.`; ALTER/DROP/CREATE/DELETE FROM/TRUNCATE, `deleteMany`, `.delete({` ...; a write call (`writeFile`, `appendFile`, `createWriteStream`, `copyFile`, `cp`, `rename`, `symlink`, `mkdir`, with or without `Sync`) whose first argument is not a literal, so its target cannot be shown to be in the repo; `state-dir` / `stateDir` (the store override of principle P8); a delete (`rm`, `unlink`, `rmdir`, `rm -r`/`-f`, `git branch -D`, `git worktree remove`, `git reset --hard`, `git clean -f`, `git push` with `--force` or `-f`) | same |
| money (2, risky) | payment, invoice, billing, refund, checkout, stripe, wallet, ledger (path or line; `git checkout` excluded) | same |
| untrusted-input (2, risky) | `req.body`, `JSON.parse(`, `process.stdin`, `fetch(` and `path.join(` with a non-literal argument (`__dirname`, `process.cwd()`, `homedir()` count as literal); a read call (`readFile(Sync)`, `createReadStream`, `readSync`, `readdir(Sync)`, `opendir(Sync)`, `readlink(Sync)`) whose first argument is not a literal or such a root | same |
| audit (2) | a file under `hooks/` with no security hit | auditor Opus high mid-lane, Opus max at `--landing` |
| size (2) | more than 400 changed lines | Opus high lens |
| concurrency-lite (2) | `link(`, `Promise.all(`, timers, in a file that also writes | Opus high lens + stress or race plan |
| concurrency (3, risky) | a `lock` path or word, mutex, flock, `O_EXCL`, `'wx'`, transactions; `rename(`, `unlink(`, `rm(`, `rmdir(`, `mkdir(` without `recursive`; `existsSync(`/`stat(` in a file that also writes, renames, removes or opens | Opus max lens + the plan below |

Every `--landing` of tier 1 or more adds the Opus max lens and the auditor at Opus max (the last review before a push).

## Waivable, weakened and principles

- `waivable` (with `--landing`): `null`, or `{reviews, audit}` only when the landing is tier 1 and no file is `gate`. `reviews` run before
  land: the Sonnet high correctness lens (carrying the mutation plan when the diff has code, since the risk lens is not run) and the
  `ui-quality-pass` line for ui. `audit` is the Opus max `risk: landing` lens and the auditor `audit: landing`, run after land and before
  any sync or push (the caller decides when, see `audit-log`). Both name the report's `range`.
- I1 (the rule behind it): review-tier only adds checks; the one exception is `waivable`: a tier-1, non-gate landing whose contract passed
  (`waiverAt`) runs `waivable.reviews` before land and `waivable.audit` after land, before any sync or push, as `audit-log` decides.
- `weakened`: `{path, line, kind}` for added lines of test files and test, lint and type config that weaken a check: `only`
  (`.only(`, `only: true`), `skip` (`.skip(`, `skip: <not false>`), `todo`, `ignore` (`ts-ignore`, `ts-nocheck`, `eslint-disable`),
  `bound` (a removed and an added line equal once digits are masked, the numbers differ), `removed-test` and `removed-assert`
  (removed `test(`/`it(`/`describe(` or `assert`/`expect(` lines beyond the added ones). A caller must not waive while it is non-empty.
  A platform skip such as `{ skip: process.platform === 'win32' }` counts too: it is a skip, and the full set is the safe answer.
- `principles`: the ids (`P<n>`, sorted by number) that the hits ask the brief to carry, from `PRINCIPLES_BY_TRIGGER` in `tiers.mjs`:
  read rule P1 P5; write rule P7 P8; delete rule P2 P8; a security hit on a line with `git` P2; gate P3; a `hooks/` path P1 P9;
  untrusted-input P5 P12; `setTimeout`/`setInterval` P9.

## Waiver population (measured)

How many of the replay's fix commits (`evidence-defect-replay.md`, round 5) a waiver would have covered. One scripted run of
`review-tier <sha>^..<sha> --landing --json` at each of the 25 commits the replay names (22 items; items without a named commit are
not measured), with the classifier of this version. Found by: A auditor, R reviewer, `-` not recorded.

| Result | Items (commits) | Found by |
| ------ | --------------- | -------- |
| tier 1, no gate: waivable | 67 (9307a36, b1d165f, e725471), 74 (c403eec), 75 (a4cafec), 76 (137cd18) | R, R, `-`, `-` |
| tier 2 or 3, no gate | 61, 62, 63, 64, 69 (2 commits), 70, 71, 72, 73, 80, 81, 82, 83, 84 | A, except 72 (`-`) |
| tier 2 or 3 and gate | 77, 78, 79, 85 | A |

4 of 22 items (6 of 25 commits) stay waivable, 18 % of the items; none of the 17 auditor-found items is among them. Items 71 and 73 are
tier 2 (acceptance of lane R1). `weakened` was non-empty on 5 commits (70, 77, 78, 82, 85), each a platform `skip:` or `t.skip(`
in a test, all of them already tier 2 or more. The population is small and each item's class is one reader's judgement: it is a
measurement, not a miss-rate bound.

## The plan (checks to run, never fewer than the reviewer would choose)

- stress (a lock: lock words, `O_EXCL`, `'wx'`, a lock file name, `link(`): `{staleLock: true, killPct: 5, waiters: [8, 20], repeats: 3, count: ['double-holders', 'lost-updates']}`: seed a lock file with a dead pid aged past the code's stale limit, kill about 5 % of holders mid-turn, run at 8 and at 20 waiters.
- race (lock-free: rename, rm, unlink, mkdir, stat-then-act, `Promise.all`, timers): `{runs: 200}`: run the two actors concurrently that many times and assert the invariant, or the reviewer writes `not applicable: <reason>`. Stale-lock numbers mean nothing for these, so they get no stress plan (lead decision 2 of round 4).
- mutation `{maxMutants}`: any risky class, and every `--landing` of a code diff; at most one mutant per changed line and 7 per changed file.
- The correctness lens gets no plan; the risk lens and the auditor do. The auditor gets the stress or race plan only when concurrency and security hit the same file.

## Choices a reader may question

- `hooks/` is the `audit` class, not security (the spec lists it in both): a hooks file with a real security hit is security.
- Tests, docs and prose (`.md`) are not scanned by line, and docs carry no risky class by path, so a README that talks about passwords is still tier 0.
- A pure rename lists both paths (`git diff --name-only --no-renames`): `tsconfig.json` renamed to `tsconfig.json.off` still changes a gate path, so it is `gate` and never waivable.
- A bare `exec(` counts only in a file that mentions `child_process` or `execa` (a regex `.exec(` is not a shell).
- A delta round is always a landing round. A mid-lane review with `--landing` left out has a lighter set than its own fix rounds; the other way round (a fix round lighter than the landing review it follows) is the defect this rule closes, and the tool has no record of the first review's flags.
- A delta keeps every class of the lane: a file never drops a class inside a lane, and a file the fix does not touch keeps its lenses and plans in the set. The diff-level `size` class is computed from the delta's own lines (in a delta round it changes no lens: the landing set already holds the Opus max lens).
- Git state that shows in no diff cannot change what is read: every patch is printed with `--text`, no external diff or textconv and fixed
  prefixes, so `.git/info/attributes` (`* -diff`, `binary`) and the repo's diff config hide no line; a patch key is made with three context
  lines whatever `diff.context` says; every git call runs with `GIT_NO_REPLACE_OBJECTS=1`, so a replace ref swaps no commit. The price: a real
  binary file is read as text, and its "lines" count as changed lines (more review, never less). File names are read NUL-separated and a quoted
  `+++` path is unquoted, so a name with a quote, backslash or control character is one file with its own classes.
- Hits are capped at 20 per class and file, so a generated file cannot make the JSON huge; the class still applies.

Files: `review-tier.mjs` (CLI), `tiers.mjs` (class rules), `lib/diff.mjs` (git reading, delta, required reading), `lib/reviews.mjs`
(sets, plans, briefs, waivable), `lib/report.mjs` (report, text, JSON), `lib/prior.mjs` (hash and finding counts of the `--prior` report), `lib/brief-data.mjs` (names as data), `lib/weakened.mjs` (weakened checks), `lib/log.mjs`. Tests:
`tests/review-tier.test.mjs`, `review-tier-cli`, `review-tier-gate` (gate, line rules, principles, items 71 and 73), `review-tier-waivable`,
`review-tier-weakened`, `review-tier-delta-set` (a fix round is never lighter than the lane), `review-tier-delta-brief` (the delta line and the prior file), `review-tier-prior` (which lines of a report are findings), `review-tier-brief-data` (hostile names), `review-tier-git-state` (attributes, diff config, replace refs, quoted paths), `review-tier-base` (the base is a local branch or a full sha), `review-tier-rewritten-lane` (a lane that dropped or changed a reviewed patch).
