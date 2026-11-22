# road

A big job as a road of steps: every step is fixed at the start, holds 1-5 lanes that share no file, and is checked by a gate before the
next one starts. The road file holds the plan; the STATUS.md rows hold the state (no state file).

## The road file

`road-<id>.json` in the folder of the job's STATUS.md (never committed: add it to `.git/info/exclude` like STATUS.md). `<id>` matches
`^[a-z][a-z0-9-]{0,7}$`. The architect writes it with the spec and changes only steps not started yet; run `check` after every change.

Keys: `road`, `goal`, `repo` (absolute, a drive path allowed), `base`, `suite`, `spec` (default spec of every lane), `threatModel`
(required, a text of 40+ characters: who can do what to this job; every gate input comes from the lead's own record or a tool's output
and is hash- or ref-checked), `questions[]`
(`question`, `options[]`, `recommended`, `askAtStep?`), `steps[]` (`goal`, `measure?`, `appendOnly?`, `form?`: `"build"` (default) or
`"agents"` for a step the owner steers with plain agents, `lanes[]`). A lane is the `build` lane object (`files`, `acceptanceTests`,
`implementer`, `matrix?`, `principles?`, `checkpoints?`, `addClasses?`, `spec?`) plus `name` (`^[a-z0-9][a-z0-9-]{0,23}$`, unique, not
`check`, not ending `-land`), `item`, `size` S/M/L, `closeSize?` (default M), `branch` and `needs?` (lanes of earlier steps; omitted =
every earlier lane; `[]` = none).

Contract fields of a lane (checked by `check`, judged by `join`):

| field | rule |
|---|---|
| `principles[]` | required: `{id, question}`, id `P<n>` or `F<n>` (unique in the lane), a question of 10+ characters, and at least one `F<n>` (a failure class: two runs, a crash, hostile names, an empty input, Windows paths) |
| `checkpoints[]` | `{id, run, exit 0-255, files[], kind}`; `kind` is `red-first` (fails at the base, passes at the head) or `keeps-working` (passes at both); `files` may be empty; ids are unique in the whole road; a checkpoint file is never a lane file or inside a lane folder (the lane never edits it); `run` is one command line |
| `keepGreen` | optional, one command line, run at the joined head; red is a finding |
| `matrix` | a lane with a UI file (the ui-proof definition) or a `ui-implementer` needs a coverage matrix path, or `none: <reason of 15+ characters>`; `check` refuses it otherwise |

Example (two steps):

```json
{ "road": "demo", "goal": "add a cache", "repo": "/Users/me/src/app", "base": "main", "suite": "npm test",
  "spec": "/Users/me/src/app/docs/cache-spec.md", "questions": [],
  "steps": [
    { "goal": "contract", "lanes": [
      { "name": "cache-api", "item": "cache interface + integration test", "size": "S", "branch": "lane/cache-api",
        "files": ["src/cache/api.ts", "test/cache-api.test.ts"], "acceptanceTests": true,
        "implementer": { "model": "sonnet", "effort": "high" },
        "checkpoints": [{ "id": "api", "run": "npm test -- cache-api", "exit": 0, "files": ["test/cache-api.test.ts"], "kind": "keeps-working" }] } ] },
    { "goal": "users of the cache", "appendOnly": ["docs/catalog.md"], "lanes": [
      { "name": "users", "item": "cache in users", "size": "M", "branch": "lane/users", "files": ["src/users/"], "acceptanceTests": true,
        "implementer": { "model": "sonnet", "effort": "high" } },
      { "name": "orders", "item": "cache in orders", "size": "M", "branch": "lane/orders", "files": ["src/orders/"], "acceptanceTests": true,
        "implementer": { "model": "sonnet", "effort": "high" } } ] } ] }
```

## Rows

Lane `<road>.s<N>.<name>` (item `build: <item>`), close `<road>.s<N>.<name>-land` (item `close: review and land <name>`), check
`<road>.s<N>.check` (item `close: step N checkpoint`; step 1's adds `, base <sha>`, the road-start tip, written once). Every close row's
evidence is `landed <to> on <base> from <from>` (the `land` workflow writes it). An audit fix gets `<road>.s<N>.fix-<name>` (item
`rework: <name>`) and its `-land` close row. Ids stay at most 40 characters.

A done cell is never changed, so a close row marked done without the landed line is corrected by a second done row `<close row id>.landed`
(e.g. `rd.s1.a-land.landed`) whose evidence holds the line; the gate reads it only when the close row is done and has no landed line of its
own, and checks it the same way (`<to>` and `<from>` are hex shas, one range per close row).
Ids stay at most 40 characters, so a close row id ending in `-land` may also be corrected under the id without that suffix (`rd.s1.fix-x-land`
under `rd.s1.fix-x.landed`). Both lookups ignore case; a correction row under both ids is a FAIL line naming both. The same two ids serve
the `landed within` row below.

A fix row that landed inside the same fast-forward as another close row (so it cannot have a range of its own) is closed by a done
`<close row id>.landed` row whose evidence says `landed within <other close row id>`, at the start of the evidence or after `; ` (so
`never landed within ...` is not read). The gate then gives that row no range of its own, and fails line 2 unless the named row is a
close row (road entry or fix row) of the same road with a valid range of its own (its landed line or its `.landed` correction). A row
cannot name itself, and the named row cannot itself be a `within` row (no chains). The text takes no `as <sha>`: a fix row has no one sha
for its work, and line 2 still fails any commit that lies in no range; an `as` part is a FAIL, never ignored. Only a fix row may use
`landed within`. A road lane (any entry of a step, steered or not) always has its own range (`landed <to> on <base> from <from>`, in its
own line or its `.landed` correction): lanes land one at a time, each in its own fast-forward, so a lane row or correction that says
`landed within` is a FAIL naming the row.

A sha in a row (`<to>`, `<from>`, `reviewed <sha> clean`) may be 7 to 40 hex characters. The gate resolves each one once to its full commit
sha (`git rev-parse --verify --quiet <sha>^{commit}`) and uses only full shas after that; a sha git does not know, finds ambiguous, or
answers with a commit that does not start with it (a branch or tag named like hex), is a FAIL line naming the row. A steered (`agents`) step needs `reviewed <sha> clean` on each lane row; a done cell never changes, so when the lane
row's own evidence has no such line the gate takes it from a done correction row `<lane row id>.reviewed` (looked up like `.landed`, ignoring
case). The lane row's own line wins; the correction row is not read for a step that is not steered.

## Commands

| command | does | exit |
|---|---|---|
| `road.mjs check <road.json>` | checks the file: at most 5 lanes per step, no file shared outside `appendOnly`, `needs` only to earlier steps, ids, patterns; warns when lanes of a step share an earlier lane or a contract file and no earlier lane lands an integration test | 0 ok, 1 refused |
| `road.mjs rows <road.json> [--base <sha>]` | adds every missing row of every step to the STATUS.md beside the road file (through `status.mjs add`); a second run adds 0; refuses a road id used with other items and a second open road. `--base` writes that sha as the road-start tip (a road started before the tool) | 0, 1 refused, 2 a `--base` that is not an ancestor of the tip or already holds a landed patch |
| `road.mjs rows <road.json> --fix <N> <name>` | adds the audit-fix rows of step N; refused once step N's check row is done | 0, 1 |
| `road.mjs next <road.json> --budget <1-5>` | JSON `{ road, step, of, state: build\|gate\|done, form, held, carried, lanes, writers, baseline, args? }`: the lowest step with an open check row, landed lanes skipped, held lanes named, carried lanes first, at most 5; `writers` = the smallest of lanes + test lanes, the budget and 5; `args` are the `build` args (add `scriptsDir`), with `resume: true` once a row of the step started | 0, 1 `baseline needed: <road>.s<N>` (a UI step with no `ui-proof` step-start record) or no rows yet, 2 no or bad `--budget` |
| `road.mjs join <road.json> --road-sha256 <hex> --lane <name> --worktree <abs> --base <40-hex> [--tests <abs worktree>] [--dispute] [--checks <cat,...>] [--json]` | judges one built lane (below): prints `joined <sha>`, `finding <id>: <text>`, `ui-files: <n>`, `checkpoint ...`, `vacuous <id>`, `waiver-at <sha>`, `checkpoints: none` or `checkpoints: not checked (test off)` | 0 joined clean, 3 joined with findings, 1 refused, 2 usage |
| `road.mjs gate <road.json> [--step <N>]` | one line per check (spec-stages section 5): 1 rows, 2 landing ranges, 3 `git-tidy check`, 4 `test-pass check <tip> --suite`, 5 `audit-log gate`, 6 UI proof, 7 the measure (INFO) | 0 PASS, 1 any FAIL |

Every subprocess runs without a shell and with its own timeout. The UI-file rule is the ui-proof tool's (`ui-proof changed`); without that
tool installed a markup and style file rule stands in, which counts more lanes as UI, never fewer.

## Join

`join` is the contract judging of one lane, after its writers stopped and before its review. The lead passes the sha256 of the road file
(from `sha256sum`, taken when the road was written); a file that hashes differently, an unknown lane or an unreadable road is refused
(exit 1), so every checkpoint command comes from the file the lead hashed. The lane tip is the worktree's HEAD, read with git.

1. With `--tests`, the `+` commits of `git cherry <lane tip> <tests HEAD>` are cherry-picked into the lane worktree, oldest first. A
   conflict runs `git cherry-pick --abort` and exits 1 `tests do not apply`.
2. When the lane's own commits (`<base>..<tip>`, without the test commits it already holds) touch a checkpoint file or a test-writer
   file, exit 1 `contractTouched` and nothing else is judged.
3. One finding per file of `<base>...<joined>` outside the lane `files`, the step's `appendOnly` and the test-writer's files. Paths are
   read from git with `-z` and compared after `\` becomes `/`; none goes to a shell.
4. `ui-files: <n>`: the UI files of the range, by the one definition of `ui-proof changed` (`ui-proof/lib/ui-files.mjs`). A lane with
   any goes to `visual-qa`.
5. Checkpoints, only with `test` on (the session's `/check` or `--checks test`; `--checks` only adds). Each runs as `sh -c` at the head in
   the lane worktree and at the base in its own detached temp worktree (`road-join-<pid>-*` under the temp folder) at `--base` with the
   checkpoint `files` checked out from the joined sha. Every run has a 600 s timeout and keeps its last 20 lines. `red-first` is met when
   the base exit differs from `exit` and the head exit equals it (a `red-first` that passes at the base prints `vacuous <id>`);
   `keeps-working` is met when both equal `exit`. `keepGreen` runs at the head. With `test` off the line is
   `checkpoints: not checked (test off)`; a lane with no checkpoints prints `checkpoints: none`.
6. `waiver-at <joined sha>` (the review may be waived at that sha) is printed only with `--tests`, a `red-first` checkpoint, the
   checkpoints run, no finding and no `--dispute`.

One join runs at a time per lane worktree: an atomic `road-join.lock` folder in the worktree's git dir holds the pid; a second join
exits 1 at once, and the lock of a process that is gone is removed. A worktree with a cherry-pick, merge, revert or rebase running, or
uncommitted changes to tracked files, is refused at the start, and a HEAD that is not the one the join made when it finishes is refused
too. The test commits are picked one at a time; when one conflicts it is aborted and the ones picked before it stay (a re-join skips them). The temp worktrees are removed in
`finally`; a join that was killed leaves its folder, and the next join removes the `road-join-<pid>-*` worktrees of a process that is
gone (never those of a live one). A base-side run is a fresh checkout: a checkpoint that needs installed packages or other untracked
files must not depend on them.

## Walking an `agents` step

The `agents` form (a step the owner steers) is walked with plain agents, no workflow:

1. `road.mjs next <road> --budget <n>` names the lanes (at most 5 launches at once) and `writers`.
2. Per lane: a worktree on the lane branch at the base tip; the test-writer (when `acceptanceTests`) in `<branch>--tests`; the implementer
   in the lane worktree. Both stop before step 3.
3. `road.mjs join <road> --road-sha256 <hex> --lane <name> --worktree <abs> --base <sha> [--tests <abs>]`. Exit 1 returns the lane to its
   writer or the owner; exit 3 gives the findings to the review as its first findings; exit 0 goes to review as is.
4. Review to clean (`reviewed <sha> clean` on the lane row), then land the lanes one at a time.
5. `road.mjs gate <road> --step <N>` when every lane landed.
