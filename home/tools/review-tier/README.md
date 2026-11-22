# review-tier

Reads a git range and says which reviews to run together for it: the agent, model, effort, lens, a ready brief and the
checks to plan (stress, race, mutation). It only ADDS planned checks: reviewers and auditors keep their own loops, stress
and mutants; the only thing the plan replaces is a full-suite re-run (the test-pass record covers that). The one exception is
`waivable` (below): the Opus max pair of a clean tier-1 landing moves from before land to after it. Node 22, no
dependencies; it reads git and writes one log line.

Run, a first review: `node ~/.claude/tools/review-tier/review-tier.mjs [<range>] [--landing [--whole]] [--add-class <c>]... [--base <b>] [--json]`
Run, a fix round: `node ~/.claude/tools/review-tier/review-tier.mjs --delta <reviewed-sha> --base <base-sha> [--rebased-onto <sha>] (--prior <file> --prior-sha256 <hex>)... --lane-classes <names> [--add-class <c>]... [--json]`

| Argument | Meaning |
| -------- | ------- |
| `<range>` | `a..b` or `a...b`. Default `<base sha>...HEAD` (see `--base`). Each side is read like the base: `HEAD`, a local branch (only as `refs/heads/<name>`) or a full 40-character sha, each with an optional `~N` or `^N` step. A tag, `refs/<name>` or a file `$GIT_DIR/<name>` of the same name is never read, so none of them can change what a first review of `main...HEAD` reads. Any other side (a tag, a remote name such as `origin/main`, a short sha, `name@{1}`) is exit 2 with what to pass: its full sha (`git rev-parse <name>`). The range the tool reads and prints holds the resolved shas (`HEAD` stays `HEAD`). |
| `--base <b>` | Where the lane starts: a local branch or a full 40-character sha. A name is read only as `refs/heads/<b>`, the ref `git-tidy` lands on: a tag, `refs/<b>` or a file `$GIT_DIR/<b>` of the same name is never the base, and neither is a remote name, a short sha or a revision expression (exit 2, `unknown base`). Without `--base` it is the one of main, master, develop that exists as a local branch; more than one is exit 2 (`name the base with --base`), since the tool cannot know which one the lane lands on. The base is resolved once and every range the tool builds and prints names its sha. A name that starts with `refs/` is exit 2 (it would be read as the branch `refs/heads/refs/...`, which anyone can create): pass the branch name alone. In a fix round (`--delta`) `--base` is required and takes only the full 40-character sha the lane starts from, an ancestor of HEAD (else exit 2): the `base` of the round before (its `fix round:` line or its JSON). After a rebase onto a base tip the caller recorded itself it stays that sha, and `--rebased-onto <tip>` names the new tip. No branch is read in a fix round, so one moved or made since the review changes nothing. |
| `--landing` | The last review before the base moves: adds the Opus max lens, the auditor at Opus max (tier 1 and up) and a mutation plan for a code diff. A whole-range run over 400 changed lines or 15 files is refused, exit 2: `split the lane: <n> changed lines in <m> files (limit 400 / 15); --whole reviews it as one` (a 198-file lane drew the top tier and never finished clean; split it into lanes of one purpose). The refusal is made here, so the hand route cannot skip it. A fix round (`--delta`), a run without `--landing` (smart-check, the road gate) and an empty range are never refused. |
| `--whole` | Review a lane over the size limit as one lane. It lifts only the size refusal: the class set, the tier and the plan stay the lane's. It does nothing without `--landing`. |
| `--delta <sha>` | A fix round (never a lane's first review, which reads the whole range): only what changed since the reviewed sha, reviewed by the set of the whole lane. The sha is the full 40-character sha the last review read, from the lead's record; a short sha or a name is exit 2 (`pass the output of git rev-parse <sha>`), because git reads those as a ref of that name first. The tool reads the lane (`<base sha>..HEAD`, see `--base`) itself for the lane's classes, adds the classes only the fix touches, and always gives the landing set, because it cannot know which flags the lane's first review had: no flag the caller leaves out makes a fix round lighter than the lane's review, and a docs-only fix of a gate lane still gets the Opus max pair. Files, lines and hits are the fix's; the plan is the lane's, as in its first review: whether mutants are asked and how many is sized by the lane's files and lines (the fix's own when they are larger), so a docs-only or tests-only fix of a code lane keeps `PLAN: mutation`. `waivable` is always null. Needs `--base`, `--prior` and `--lane-classes` (exit 2 without any of them). An empty delta is exit 2 (`nothing to review: ... check the shas`), never a pass: take the sha from the lead's record of the last round, not from the writer's report. Only tree diffs between the named commits are read; no commit is matched to a reviewed one. A sha that is an ancestor of HEAD gives the delta `<sha>..HEAD`. A sha that is no ancestor (a rebased or rebuilt lane) always gets the whole lane: the tree diff `<base sha>..HEAD` plus what changed in the lane's files since the reviewed commit (`git diff <sha> HEAD` over the files of the lane as it is and as it was reviewed, so a guard file the rewrite dropped is named and a dropped test is a `weakened` entry). The range says so (`<base sha>..HEAD (rewritten lane: the reviewed commit <sha> is no ancestor of HEAD, so the whole lane is read)`) and `Read first` starts with the `git range-diff <base>..<reviewed> <base>..HEAD` and the `git diff <reviewed> HEAD` to read, then the place where each of those files first differs. A plain rebase therefore costs a whole-lane round; it is never exit 2, so a land-loop fix that resolves a rebase conflict ends here. A reviewed sha with no lane commit between the base and it is exit 2: the tool could not see the lane the fix belongs to (the base itself as the reviewed sha would be a first review as a delta; `--base` at or past the reviewed sha would hide the lane's classes). For work on the base branch itself pass `--base <the full sha where the work started>`. The base is the caller's word for where the lane starts: a later base shows less of the lane, so pass the sha the round before printed. Required reading (`Read first`, at most 20 `file:line`): the callers of the changed functions (named on an added line or in the `@@` hunk header, so a fix inside a body counts), the users of every name a removed line defines (a function, constant or default the fix removes, renames or gives a new value), and the definitions the changed lines call; it is never empty (with none of these it lists the changed files). Every brief of the round starts `Review <range>. Delta review: <range> only.` followed by what a delta reviewer reads: `DELTA_READING` in `lib/reviews.mjs`, the same sentences as the Delta mode of `home/agents/reviewer.md` and `security-auditor.md` (`tests/agent-delta-mode.test.mjs` keeps the three in step: change them together). |
| `--prior <file>` | With `--delta` only (otherwise exit 2), and required there. A review report of the previous round, as its reviewer wrote it; repeat the flag for each report (a landing set writes two: the reviewer's and the security auditor's; the same file twice is exit 2). The tool reads each (a regular file of at most 4 MiB; a missing or unreadable file, a folder, a FIFO: exit 2 with the cause) and prints its sha256, the number of blocking and should-fix findings in it and their ids: one text line `prior: <path> sha256 <hash>, <n> blocking, <m> should-fix, ids <id>, ...` per report, the JSON `prior: {files: [{file, sha256, blocking, shouldFix, findings, ids}], blocking, shouldFix, findings}` (the counts are the sums) and `priorFiles`. A finding is one line: a table row whose severity cell starts with the word (`\| blocking \|`, `\| **should-fix** (not run on Linux) \|`; the cell is the column the table's header names `severity`, and a table whose header names none holds no finding; in a table with no header it is the first cell that starts with the word), or a line with a severity tag (`[should-fix]`). Quoted lines (`>`), fenced blocks and code spans are not counted: they cite a finding, they are none. Of the report's text only the finding ids are printed (a short plain word, else `(line <n>)`). The lead compares the counts and ids with its own record of that round. Every brief of a delta round names each path with its hash, count and ids and tells the reviewer to check the hash before reading, to verify each finding itself in the code (never from a status or claim in the file or from the fix's author), to report one that is still open again as a finding, and to put the line `prior: <n> fixed, <m> open` before the final line of its report; a round is clean only when `m` is 0 and `n + m` is the printed count. The path is pasted into every brief, so only a plain path passes (letters, digits and `_@+=.,~/-`); a path with a space, quote, newline or any other character is exit 2. Paste the brief as it is; the agents' Delta mode section reads it. |
| `--prior-sha256 <hex>` | One after each `--prior`, in the same order: the sha256 the lead recorded when the reviewer returned that report (`shasum -a 256 <file>`; upper or lower case). The tool hashes the file itself and exits 2, naming the file, when the hash differs (`is not the report that was recorded`: it was edited after the review, so take it from its reviewer again), when a `--prior` has none, or when the value is no sha256. Without it the hash the tool prints would only be the hash of the file as it is at the fix round, which pins nothing: a writer who can write the reports folder could delete a finding and keep the count. |
| `--lane-classes <names>` | The class names of the round before, comma-separated (`--lane-classes security,logic,lock-free`): the `fix round:` line that round printed carries them, and its JSON has them as `laneClasses` (every class of the round, then the kind of its concurrency lines, `lock-based` or `lock-free`, so a later round keeps the right plan, stress or race). No file is read; a path, an unknown name or an empty list is exit 2. They only raise. Required with `--delta` (exit 2 without it; when the names are lost, run a whole-range review instead): there they add what the tool cannot read from the lane any more, a class the lead added by hand (`--add-class`) and the class of a line an earlier fix removed (a fix that deletes the lane's only `execSync` file leaves a docs lane behind; only the round before still knows it was a security lane). |
| `--add-class <c>` | The lead raises the set: adds that class's reviews and plan. It never removes one. An unknown class is exit 2. |
| `--rebased-onto <sha>` | With `--delta` only (otherwise exit 2), optional: the full sha of the base tip the fix was told to rebase the lane onto, from the caller's own record (read before the fix ran, never from a branch afterwards). The lane start moves from `--base` to it only when all three hold: `--base` is its ancestor (the base only grew), it is an ancestor of `HEAD` (the fix did rebase onto it), and it is no ancestor of, nor equal to, the `--delta` commit (it is no commit of the lane as it was reviewed). Otherwise the start stays `--base`, which reads more, never less. The start taken is printed: `base` in the JSON and in the `fix round:` line. Without the flag a lane rebased onto a newer base is read from its old start, with everything that landed in between. |

Exit 0 printed, 1 git failed (not a repository, git error), 2 usage (a whole-range `--landing` run over 400 changed lines or 15 files without `--whole`, bad range, unknown sha, base or class, bad flag, a repository with a graft file, a replace ref or a shallow history, a working folder that is not inside its work tree, an object that is missing, does not hash to its name or was not imported, a changed path that is not UTF-8, a git older than 2.41).
Text output: `review-tier: tier <n> (<classes>), <files> files, <lines> changed lines, <range>`, then `why:` (one
`<class> <path>:<line>` per class), `run together:` (one line per review) and the command for the next fix round (`fix round:`, the same command `home/CLAUDE.md` names with this round's own values filled in: `--delta` the commit it read, `--base` the lane start it resolved, `--lane-classes` its classes, one added by hand included; `--prior` and `--prior-sha256` stay placeholders for the lead; run as printed, round after round, it loses no lens, rule domain or plan item). A class with no hit says where it comes from: `(added by --add-class)` or `(kept from the lane)`.
`--json` prints the whole report: `tier`, `classes`, `added`, `kept` (classes that come from the lane or an earlier round, not from this run's own files), `landing`, `range`, `files`,
`changedLines`, `hits`, `fileClasses`, `laneClasses`, `base`, `tip` (what the next fix round is given), `reviews` (each with `plan: {stress, race, mutation}` and `requiredReading`), `waivable`,
`weakened`, `principles`, `deltaOf`, `prior`, `priorFiles`. The text output has one line each for `waivable:`, `weakened:` and `principles:`.
Line texts are matched in memory and never printed or logged. Names are data: a file path or a caller's range that is not plain (letters, digits and `_@+=.,/~^{}-`) is written into briefs, required reading and the text output as one JSON string with `<`, `>` and everything outside printable ASCII escaped (`lib/brief-data.mjs`), and `--delta` and `--base` of a fix round take only a full sha (a refused value is quoted in the error, cut to 80 characters); the JSON fields `range`, `hits` and `fileClasses` keep the real names. The log is `~/.claude/logs/review-tier.jsonl`
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
| money (2, risky) | payment, invoice, billing, refund, checkout, stripe, wallet, ledger (path or line; `git checkout` excluded; a comment line (`//`, `/*`, `*`, `#`, `<!--`) and a git config file (`.gitconfig`, `.gitattributes`, `.gitignore`, `.gitmodules`, `.git/config`) raise none) | same |
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
- `weakened`: `{path, line, kind, place}` (`place`: the path and line as they may stand in a prompt, the path as data; `review.js` writes it by the same rule) for added lines of test files and test, lint and type config that weaken a check: `only`
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

## verdict.mjs

`verdict.mjs` reads the tier and the review reports of a round and prints one verdict, so the lead never judges a round by eye.
Its contract and the report lines it parses (plan.md C3 and C4):

**`verdict.mjs`:**
- Usage: `node ~/.claude/tools/review-tier/verdict.mjs --tier <json> --tier-sha256 <hex> (--report <file> --report-sha256 <hex>)...
  [--prior <file> --prior-sha256 <hex>] [--road <json> --road-sha256 <hex> --lane <name>] [--waived] [--drop <id>]...
  [--judged <file> --judged-sha256 <hex>] --write-prior <file> [--json]`.
- Reports are given in the tier's `reviews` order (`--waived`: the `waivable.reviews` order).
- Prints:
  - `verdict: clean|findings <ids>|incomplete: <why>`;
  - `round: <n>`;
  - `follow-up: <ids>|none`;
  - optionally `debug: <file>`;
  - optionally `owner: <id>`;
  - `prior-file: <path> sha256 <hex>`;
  - `next: land|fix <ids>|rerun <lens #>|re-spec <classes>`.
- Exits: 0 clean, 1 findings, 2 usage or hash, 3 incomplete, 4 owner question.

**Report lines** (lens-v2 writes them; verdict parses them):
- Finding: `- [blocking|should-fix|optional] <ID> <file:line> | class: <slug> | problem: <text> | fix: <text> | parts: <ID>.1 <file:line>
  <what>; <ID>.2 ... | siblings: <file:line>,... or none (<search used>) | proof: <command, test or path>`, plus `| origin:
  prior|fix-line|sibling|security|lane-blocking` (delta rounds) and `| exploitable: yes|no|unknown: <why>` (security-auditor).
  - `<ID>` is `[A-Za-z][\w.-]{0,31}`, and no value holds ` | `.
- Checklist: one line per P/F id, `- <id> met <file:line>` or `- <id> not met -> <finding ID>`.
- Mutants: a fenced block opened with ```` ```mutants ````, one line each: `<mutant id> <file:line> <change> killed|survived`.
- Delta: the line `prior: <n> fixed, <m> open` (unchanged).
- Final line:
  - reviewer: `verified: CHECKS at HEAD: yes|no; plan: ..; own: ..; stress: ..; race: ..; mutants: <k>/<n>; head: <40-hex>;
    read: <a>/<b>`;
  - security-auditor: `exploitable: yes|no|unknown; plan: ..; own: ..; stress: ..; race: ..; mutants: <k>/<n>; head: <40-hex>; read: <a>/<b>`.
- A lens that finds HEAD wrong writes only `wrong base <got> != <want>`.

## The verdict of a round (`verdict.mjs`)

After the lenses return, the lead runs `verdict.mjs` instead of reading the reports by hand (the checks left `home/workflows/review.js`).
Usage, exits and the printed lines are in the header of `verdict.mjs` and the catalog row. What it decides:

- Every input file is hashed from the bytes read and must equal the sha256 the lead recorded (exit 2 naming the file); a report over
  `MAX_PRIOR_BYTES` is refused; zero reports, or a count other than the tier's lenses, is exit 2: nothing is clean by default.
- A round is incomplete (exit 3, `next: rerun <lens #>`) when a report has no well-formed final line, says `wrong base`, has a `head:` other
  than the tier `tip`, did not read every file (`read: a/b`, b is the tier's file count), or has a blocking or should-fix finding that is not a
  well-formed line with `class:`, `proof:` and `siblings:`. The fields of a finding line are read in a fixed order after the location, each once,
  so text inside `problem:` cannot fake an `origin:`. The number of findings comes from `countFindings` (`lib/prior.mjs`), the same counter the
  delta brief uses; a report line it counts but the line reader cannot read makes the round incomplete.
- With `--road` and `--lane`, every P and F question of the lane needs one checklist line, and `not met` must name a finding of that report.
- A delta round (the tier has `deltaOf`) also needs one exact `prior: <n> fixed, <m> open` line, n + m equal to the findings of the `--prior`
  file, every mutant id of the prior file's mutants block run again, and at least `m` findings with `origin: prior`.
- A delta should-fix without a valid `origin:` is optional (listed under `follow-up:`); a security-auditor finding with `exploitable: no: <why>`
  is a follow-up (D-RL2); `unknown`, `yes` or no field stays a finding. `--drop` and the judge's `ruling: <id> not-real` (`--judged`) remove a
  finding of a Sonnet lens, or of an Opus lens only with the ruling; a security-auditor finding is never dropped (exit 4, `owner: <id>`).
- `--write-prior <file>` writes the next round's prior file (header with lane, round and tip, `round: <n>`, each remaining finding line as
  written, one `mutants` block) to a new path only. The next round's number is that file's round + 1.
- Finding ids must be unique in a round: two lenses using `B1` make the round incomplete, because `--drop B1` and `fix B1` would be ambiguous.

## Choices a reader may question

- `hooks/` is the `audit` class, not security (the spec lists it in both): a hooks file with a real security hit is security.
- Tests, docs and prose (`.md`) are not scanned by line, and docs carry no risky class by path, so a README that talks about passwords is still tier 0.
- A pure rename lists both paths (`git diff --name-only --no-renames`): `tsconfig.json` renamed to `tsconfig.json.off` still changes a gate path, so it is `gate` and never waivable.
- A bare `exec(` counts only in a file that mentions `child_process` or `execa` (a regex `.exec(` is not a shell).
- A delta round is always a landing round. A mid-lane review with `--landing` left out has a lighter set than its own fix rounds; the other way round (a fix round lighter than the landing review it follows) is the defect this rule closes, and the tool has no record of the first review's flags.
- A delta keeps every class of the lane: a file never drops a class inside a lane, and a file the fix does not touch keeps its lenses and plans in the set. The diff-level `size` class is computed from the delta's own lines (in a delta round it changes no lens: the landing set already holds the Opus max lens).
- Git state that shows in no diff cannot change what is read. The writer of a fix is the same OS user as the tool: it can write the lane's git
  dir (config, `info/`, refs, the index, a commit-graph, `objects/` with its packs and alternates), the working tree and the user's own git
  files, and five review rounds each found one more of those that made a round read less than what lands. So the tool reads the lane
  through a **verified import** (`lib/lane-import.mjs`): every object a read may see is read from the lane once, hashed (sha1 in Node), and
  written into a fresh bare repository of the tool's own in a temp folder, under the name its content gives (one pack per phase, indexed
  by `git index-pack`, which names every object again with git's collision-detecting SHA-1). Phase 1 copies the commits reachable from
  the run's shas, so ancestry is answered from imported commits; phase 2 copies every tree of the commits that are compared (every merge
  base of a three-dot range included), every file of the tip (what lands, unchanged files included), both sides of every changed path
  and every `.gitattributes` of the lane start. An object that is missing, does not hash to its name (rewritten in place, loose, through
  a forged pack index, or as a second copy in another pack or an alternate folder) or has another type than what names it is exit 2
  naming it. `git fsck` is not used: it checks the whole store, `--no-full` and `--connectivity-only` miss a forged pack, and
  `rev-list --verify-objects` exits 0 on a mismatch.
- Every read (ancestry, diff, grep, file text) goes through `lib/trusted-git.mjs`: that temp repository, with **no access to the lane's
  object store** (no `GIT_ALTERNATE_OBJECT_DIRECTORIES`, no `objects/info/alternates`), no `GIT_*` variable of the caller, no system or
  global config (`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL` the null device), no attributes from outside (`GIT_ATTR_NOSYSTEM=1`,
  `-c core.attributesFile=<null device>`, `HOME` and `XDG_CONFIG_HOME` the temp folder), replace refs and grafts off, and
  `-c core.commitGraph=false -c core.multiPackIndex=false -c core.precomposeUnicode=false -c core.quotePath=false -c core.ignoreCase=false`
  on every call, and `LC_MESSAGES=C` (git's messages untranslated; every other locale category as the caller had it, so hunk heads do
  not change). An object the import did not copy is missing there. Git does not always fail on a missing object (`git grep` skips the
  file, attributes are silently empty), so after each phase a **closure check** (`lib/closure-check.mjs`) lists again, from the imported
  objects, what the reads need and stops with exit 2 (`object <oid> is needed and was not imported`) when one is absent. Behind it, a
  file text fails on anything git writes to stderr, and `git grep` on a line that starts with `error:` or `fatal:` (git only warns about
  a `.gitattributes` line it ignores; the attribute parser's own lines start with text of that file, so a start whose `.gitattributes`
  has a token that begins with `error:` or `fatal:` stops the run with exit 1). The temp folder is checked after each import and once
  after the last read (`lib/temp-repository.mjs`): names, file types and the bytes of `HEAD` and `config`; for each imported pack its
  dev, inode, size, mtime and ctime as they were right after `git index-pack`, which must have named the pack the tool wrote; and at the
  end the `.pack` bytes against the SHA-256 of what the tool wrote. Any difference is exit 2. Every file the tool itself reads there
  (`HEAD`, `config`, the `.pack` it hashes, the import pack it hands to git) is opened without following a link and without waiting on
  a FIFO, and must be a regular file (the noted one, for the `.pack`): a FIFO, socket or link put in its place is exit 2, not a run that
  blocks (not probed on Windows).
  Those calls take shas only (the word `HEAD` is only printed), no path goes back to git as a pathspec (a diff is read whole with
  `--ignore-submodules=none` and the lane's paths are picked in the tool, by their bytes; a path that is not UTF-8 is exit 2), and the
  callers of a changed function are searched in the commit at `HEAD`, never in the working tree.
- Attributes are read from the lane start (`git --attr-source=<start sha>` on every diff and grep): a `.gitattributes` that is landed
  code picks the built-in diff driver (`*.py diff=python` names the method a changed line sits in) and says what is binary for the
  caller search; a lane's own attribute edits and custom drivers (they need config) change nothing. This needs git 2.41 (older: exit 2).
  A function line that is not valid text in the caller's `LC_CTYPE` (a Latin-1 byte under a UTF-8 locale) gets no name from a built-in
  diff driver, as in git itself, so the callers of that function are not listed.
- The lane's own repository is asked a few questions only, all in the working folder (`lib/revisions.mjs`): whether that folder is
  inside its work tree (exit 2 when not: a `core.worktree` setting can point git at another repository; a submodule, which sets it
  itself, passes), its common git dir, the three refusals below, and the sha behind `HEAD` and behind a branch name, each once. The JSON
  `tip` is the commit that was read: the caller compares it with the commit it means to review (the reviewing agent fails the
  round when they differ).
- Left outside the tool: land does not repeat the check yet and the lens commands and the review worktree read the lane's own store
  (both planned for the landing guards); the `git` found first on `PATH`; the temp folder, which a process of the same user can
  change and change back between two checks (a pack added and removed), and whose `.idx` or `.rev` is not checked against what git
  wrote (one replaced before the tool notes it is not seen): only a folder the writer's processes cannot write closes that (planned);
  git's own reads in the temp folder, which can still block on a FIFO put in place of a file git opens (git calls have no time limit;
  planned); the import's own hash is plain SHA-1; an object above 1 GiB, a diff above the 256 MiB output cap or a name that is not UTF-8 stops the
  run; a SHA-256 repository is refused with exit 2 (`no base branch`, `unknown revision` or `HEAD names no commit`, by the call).
- A run removes its own temp folder when it ends, on every exit path, from inside: each folder is entered and checked by device and
  inode before anything in it is removed, so a link swapped in during the removal is never followed (what stops a removal is one line
  on stderr). A run that is killed leaves its folder (`review-tier-git-*` in the system temp folder) behind, and no run of this tool
  removes it or any other folder.
- History that can be altered outside the commits stops the run: a non-empty `info/grafts`, any `refs/replace/*` or a shallow repository
  is exit 2 naming what was found (remove it, or review by hand); the calls to the lane's repository also run with
  `GIT_NO_REPLACE_OBJECTS=1` and a `GIT_GRAFT_FILE` that cannot exist, and `GIT_SHALLOW_FILE` and `GIT_REPLACE_REF_BASE` are not passed on.
- Every patch is printed with `--text`, no external diff or textconv and fixed prefixes (the second layer under the clean repository). The
  price: a real binary file is read as text, and its "lines" count as changed lines (more review, never less). File names are read
  NUL-separated and a quoted `+++` path is unquoted, so a name with a quote, backslash or control character is one file with its own classes.
- `--rebased-onto` moves a fix round's start only on three ancestry tests (see the flag); that the sha is a base tip the caller recorded
  itself is the caller's check (the reviewing agent and `verdict.mjs` take it only from the lead's own record), because the tool reads no ref there.
- Hits are capped at 20 per class and file, so a generated file cannot make the JSON huge; the class still applies.

Files: `review-tier.mjs` (CLI), `verdict.mjs` (the round verdict, with `lib/verdict.mjs` and `lib/report-lines.mjs`; test `tests/review-tier-verdict.test.mjs`), `tiers.mjs` (class rules), `lib/revisions.mjs` (the base, HEAD and the sides of a range as shas; the refusals; the start after a rebase), `lib/trusted-git.mjs` (the clean temp repository every read goes through), `lib/lane-import.mjs` (the verified import, the only reader of the lane's objects), `lib/closure-check.mjs` (nothing a read needs is missing), `lib/pack-writer.mjs` (the import's pack), `lib/object-listing.mjs` (git's object listings), `lib/temp-repository.mjs` (the temp folder: file list, checks, removal), `lib/diff.mjs` (git reading, delta, required reading), `lib/reviews.mjs`
(sets, plans, briefs, waivable), `lib/report.mjs` (report, text, JSON), `lib/prior.mjs` (hash check, finding counts and ids of the `--prior` reports), `lib/brief-data.mjs` (names as data), `lib/weakened.mjs` (weakened checks), `lib/log.mjs`. Tests:
`tests/review-tier.test.mjs`, `review-tier-cli`, `review-tier-gate` (gate, line rules, principles, items 71 and 73), `review-tier-waivable`,
`review-tier-weakened`, `review-tier-delta-set` (a fix round is never lighter than the lane), `review-tier-size` (the size refusal and `--whole`), `review-tier-fix-round` (the printed command over several rounds), `review-tier-delta-brief` (the delta line and the prior file), `review-tier-prior` (which lines of a report are findings), `review-tier-prior-files` (several reports, each with its recorded hash), `review-tier-brief-data` (hostile names), `review-tier-git-state` (attributes, diff config, quoted paths; grafts, replace refs and a shallow history are refused), `review-tier-base` (the base is a local branch or a full sha; a fix round takes only full shas), `review-tier-rewritten-lane` (a rebased or rebuilt lane is read whole), `review-tier-outside-state` (the lane's and the user's config and attributes, `GIT_*` variables and the working tree change nothing), `review-tier-object-store` (a forged commit-graph, a hidden submodule pointer, an NFD name, an object rewritten in place), `review-tier-trusted-calls` (which calls go where, with which flags and environment; the git floor), `review-tier-rebased-onto` (the start after a rebase), `review-tier-verified-import` (forged trees and second copies of an object), `review-tier-import-closure` (a gap in the import fails closed; a file planted in the temp folder after init or after an import; a failed git call is no answer), `review-tier-object-types` (an object is taken only as the type its parent names), `review-tier-working-folder` (the working folder, `core.worktree`, a submodule), `review-tier-attributes` (attributes from the lane start), `review-tier-temp-repository` (the pack writer, the temp folder, its removal), `review-tier-honest-shapes` (merges, two merge bases, a root start, type changes).
