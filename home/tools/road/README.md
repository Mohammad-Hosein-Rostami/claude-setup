# road

A big job as a road of steps: every step is fixed at the start, holds 1-5 lanes that share no file, and is checked by a gate before the
next one starts. The road file holds the plan; the STATUS.md rows hold the state (no state file).

## The road file

`road-<id>.json` in the folder of the job's STATUS.md (never committed: add it to `.git/info/exclude` like STATUS.md). `<id>` matches
`^[a-z][a-z0-9-]{0,7}$`. The architect writes it with the spec and changes only steps not started yet; run `check` after every change.

Keys: `road`, `goal`, `repo` (absolute, a drive path allowed), `base`, `spec` (default spec of every lane), `suite?` and `threatModel?`
(plain notes, optional: the suite command and who can do what to this job; nothing runs or judges them), `questions[]`
(`question`, `options[]`, `recommended`, `askAtStep?`), `steps[]` (`goal`, `measure?`, `appendOnly?`, `form?`: `"agents"` (the
only form and the default; `"build"` is retired: it still reads, as `agents`, with the WARN `step <N>: build form retired: runs as agents`),
`lanes[]`). A lane is an object (`files`, `implementer`, `acceptanceTests?`, `matrix?`, `principles?`, `checkpoints`, `keepGreen?`, `spec?`) plus `name` (`^[a-z0-9][a-z0-9-]{0,23}$`, unique, not
`check`, not ending `-land`), `item`, `size` S/M/L, `closeSize?` (read only for roads with old-form rows), `branch` and `needs?` (lanes of earlier steps; omitted =
every earlier lane; `[]` = none). `needs` lists exactly the lanes whose files or interfaces a lane uses: a lane whose needs have all
landed can start early, before its step (below), while a lane without a `needs` list always waits for its step.
`needs: []` means "may start early": the architect lists every real dependency, since a missing one lets a lane start before the work it
uses has landed (owner FR2: fill to 5 agents, fewer when the next lanes depend on the open ones).

A lane's `checkpoints` are its Done means and are required. The other guidance fields of a lane (owner decision CR7) are optional,
read for their shape only, never run or judged. An old road file that carries them (and `suite`, `threatModel`, `acceptanceTests`)
still reads.

| field | rule |
|---|---|
| `principles[]` | `{id, question}`, id `P<n>` (a design principle) or `F<n>` (a failure class to think about: two runs, a crash, hostile names, an empty input, Windows paths), unique in the lane, a question of 10+ characters |
| `checkpoints[]` | required, non-empty: the lane's Done means, the commands the lead runs itself before accepting the lane, each with the exit it must return (a text such as `node --test tests/x.test.mjs: exit 0`, or the object shape `{id, run, exit}`); `check` refuses a lane without them; no tool runs them |
| `keepGreen` | optional text, a note; nothing runs it |
| `matrix` | a lane with a UI file (the ui-proof definition) or a `ui-implementer` needs a coverage matrix path, or `none: <reason of 15+ characters>`; `check` refuses it otherwise |

Example (two steps):

```json
{ "road": "demo", "goal": "add a cache", "repo": "/Users/me/src/app", "base": "main",
  "spec": "/Users/me/src/app/docs/cache-spec.md", "questions": [],
  "steps": [
    { "goal": "contract", "lanes": [
      { "name": "cache-api", "item": "cache interface + integration test", "size": "S", "branch": "lane/cache-api",
        "files": ["src/cache/api.ts", "test/cache-api.test.ts"],
        "implementer": { "model": "sonnet", "effort": "high" },
        "principles": [{ "id": "F1", "question": "what happens on a second run with the cache already filled?" }],
        "checkpoints": ["npm test -- test/cache-api.test.ts: exit 0"] } ] },
    { "goal": "users of the cache", "appendOnly": ["docs/catalog.md"], "lanes": [
      { "name": "users", "item": "cache in users", "size": "M", "branch": "lane/users", "files": ["src/users/"],
        "implementer": { "model": "sonnet", "effort": "high" }, "checkpoints": ["npm test -- test/users: exit 0"] },
      { "name": "orders", "item": "cache in orders", "size": "M", "branch": "lane/orders", "files": ["src/orders/"],
        "implementer": { "model": "sonnet", "effort": "high" }, "checkpoints": ["npm test -- test/orders: exit 0"] } ] } ] }
```

## Rows

One row per lane: lane `<road>.s<N>.<name>` (item `build: <item>`, the lane's size), and per step a check row `<road>.s<N>.check` (item
`close: step N checkpoint`; step 1's adds `, base <sha>`, the road-start tip, written once). The lane row is the lane's landing row:
start it when its writer starts, and `land-lane --close-row <road>.s<N>.<name>` marks it done with the evidence
`landed <to> on <base> from <from>`, so the row's time runs from the start of the work to the landing (one real duration per lane for
the estimate). A lane has landed only when its row is done and holds that line (or its `.landed` correction row does): a done cell alone,
set when the build ended, is not a landing for `next`, the gate or the board, and land-lane then exits 13 naming the correction row to
record. An audit fix gets one row `<road>.s<N>.fix-<name>` (item `rework: <name>`), landed the same way; a fix id that would end in `-land`
(`--fix 1 land` next to a lane `fix`, any name ending `-land`) or equal a lane's row is refused, and a `rework:` row never lands a lane
whatever its id. Ids stay at most 40 characters; the old-form close id (below) must fit too. The item wording is kept as it was so that
rows written by an earlier road still match (`rows` refuses a row id that exists with another item).

Old form: roads whose rows were written before one row per lane have a second row per lane, the close row `<road>.s<N>.<name>-land`
(item `close: review and land <name>`), and a fix has `fix-<name>-land` too. A road is old form when its STATUS.md holds any such close
row (not a `rework:` row) and keeps reading exactly as before: every lane's close row decides whether it landed (done, as before) and holds
its landed line; the lane row's own done cell and evidence are never read for the landing, and a lane whose close row is missing has not
landed (`lib/road-state.mjs` `isOldFormRoad`, `landingRowId` and `laneLanded`, the one rule of `next`, the gate and the board). `rows` on
such a road keeps its form: it adds a missing close row after its lane row and a fix as the old pair. A rolled-back tool reading a
new-form road finds no close row and never sees a lane landed (line 1 FAIL), so it fails closed. The gate's lines still say "close rows"
for every landing row, so old output stays the same.

A done cell is never changed, so a landing row marked done without the landed line is corrected by a second done row `<row id>.landed`
(e.g. `rd.s1.a.landed`) whose evidence holds the line; the gate reads it only when the landing row is done and has no landed line of its
own, and checks it the same way (`<to>` and `<from>` are hex shas, one range per landing row). An old-form close row `<lane row>-land` is
corrected under `<lane row>-land.landed` or, since ids stay at most 40 characters, `<lane row>.landed`. A new-form row owns only
`<row id>.landed`: `<row id>-land.landed` alone may be another row's (the fix `fix-land` of a lane `fix`) and is not read, and next to the
own one it makes the pair ambiguous. Lookups ignore case; a correction row under both ids is a FAIL line naming both. The same ids serve
the `landed within` row below.

A fix row that landed inside the same fast-forward as another landing row (so it cannot have a range of its own) is closed by a done
`.landed` correction row whose evidence says `landed within <other landing row id>`, at the start of the evidence or after `; ` (so
`never landed within ...` is not read). The gate then gives that row no range of its own, and fails line 2 unless the named row is a
landing row (road lane or fix row) of the same road with a valid range of its own (its landed line or its `.landed` correction). A row
cannot name itself, and the named row cannot itself be a `within` row (no chains). The text takes no `as <sha>`: a fix row has no one sha
for its work, and line 2 still fails any commit that lies in no range; an `as` part is a FAIL, never ignored. Only a fix row may use
`landed within`. A road lane (any entry of a step, steered or not) always has its own range (`landed <to> on <base> from <from>`, in its
own line or its `.landed` correction): lanes land one at a time, each in its own fast-forward, so a lane's correction that says
`landed within` is a FAIL naming the row.

A sha in a row (`<to>`, `<from>`) may be 7 to 40 hex characters. The gate resolves each one once to its full commit
sha (`git rev-parse --verify --quiet <sha>^{commit}`) and uses only full shas after that; a sha git does not know, finds ambiguous, or
answers with a commit that does not start with it (a branch or tag named like hex), is a FAIL line naming the row. The gate reads no
review, test or audit record: a `reviewed <sha> clean` line or a `.reviewed` row in a STATUS.md is ignored.

## Commands

| command | does | exit |
|---|---|---|
| `road.mjs check <road.json>` | checks the file: at most 5 lanes per step, no file shared outside `appendOnly` (the overlap rule of early lanes: case, `//`, `./` and `\` spellings of one path share), `needs` only to earlier steps, ids, patterns; a lane with a UI file needs a `matrix`; warns on the retired `form: "build"` | 0 ok, 1 refused |
| `road.mjs rows <road.json> [--base <sha>]` | adds every missing row of every step (one per lane, one check row per step) to the STATUS.md beside the road file in one all-or-none `status.mjs add` call, under its own lock `.STATUS.road-rows-lock` (read, open-road check and add; status.mjs's lock inside it); a second run, also one at the same time, adds 0 and exits 0 (exit 1 `busy` only when the lock is held past its 1 s wait); refuses a road id used with other items and a second open road. `--base` writes that sha as the road-start tip (a road started before the tool) | 0, 1 refused, 2 a `--base` that is not an ancestor of the tip or already holds a landed patch |
| `road.mjs rows <road.json> --fix <N> <name>` | adds the audit-fix row `<road>.s<N>.fix-<name>` of step N (an old-form road: with its `-land` row); refused once step N's check row is done | 0, 1, 2 a fix id that would end in `-land` or equal a lane's row |
| `road.mjs next <road.json> --budget <1-5>` | JSON `{ road, step, of, state: build\|gate\|done, form, held, carried, lanes, early, waiting, writers, baseline }`: the lowest step with an open check row, landed lanes skipped, held lanes named, carried lanes first, at most 5; `early` the later-step lanes that can start now (below), `waiting` `{ name, why }` for every other later lane not landed; `writers` = the smallest of lanes plus early, the budget and 5. It writes nothing and takes no lock | 0, 1 `baseline needed: <road>.s<N>` (a UI step with no `ui-proof` step-start record) or no rows yet, 2 no or bad `--budget` |
| `road.mjs join <road.json> --road-sha256 <hex> --lane <name> --worktree <abs> --base <40-hex> [--json]` | judges the scope of one built lane (below): prints `joined <sha>`, `finding <id>: <text>`, `ui-files: <n>` and its `ui-file` lines; first refuses a lane whose needed lanes (its `needs`, omitted = every earlier lane) have not landed on the base in git | 0 joined clean, 3 joined with findings, 1 refused, 2 usage |
| `road.mjs gate <road.json> [--step <N>]` | one line per check (spec-stages section 5): 1 rows (every lane of the step landed), 2 landing ranges, 3 `git-tidy check` (a finding about the branch or worktree of a lane in flight, a started row not landed of this road or of another road file `road-*.json` beside STATUS.md, is INFO; any other finding, a leftover of a landed lane of this step included, FAILs), 4 UI proof (always runs, when a UI file changed or a lane has a matrix), 5 the measure (INFO). No line runs or asks for a test, a review or an audit | 0 PASS, 1 any FAIL |

Every subprocess runs without a shell and with its own timeout. The UI-file rule is the ui-proof tool's (`ui-proof changed`); without that
tool installed a markup and style file rule stands in, which counts more lanes as UI, never fewer.

## Join

`join` is the scope judging of one lane, after its writers stopped. The lead passes the sha256 of the road file (from `shasum -a 256`, taken
when the road was written); a file that hashes differently, an unknown lane or an unreadable road is refused (exit 1). The lane tip is the
worktree's HEAD, read with git; `--base` must be its ancestor. A lane one of whose needed lanes has not landed on the base in git is
refused too (exit 1): the landed `<to>` its row records must be a known commit and an ancestor of the base tip (`needsNotOnBase`).
land-lane knows no road, so this is the road's needs check before a landing: an early lane goes through join like every lane.

1. One finding per file of `<base>...<tip>` outside the lane `files` and the step's `appendOnly`. Paths are read from git with `-z` and
   compared after `\` becomes `/`; none goes to a shell.
2. `ui-files: <n>`: the UI files of the range, by the one definition of `ui-proof changed` (`ui-proof/lib/ui-files.mjs`). A lane with
   any goes to `visual-qa`.

Nothing else is judged: join does not run a lane's `checkpoints` (its Done means: the lead runs those commands itself and checks each
exit before accepting the lane), `keepGreen` or `principles`. The old flags `--tests`,
`--dispute` and `--checks` are gone (an unknown flag is a usage error, exit 2).

One join runs at a time per lane worktree: an atomic `road-join.lock` folder in the worktree's git dir holds the pid; a second join
exits 1 at once, and the lock of a process that is gone is removed. A worktree with a cherry-pick, merge, revert or rebase running, or
uncommitted changes to tracked files, is refused at the start, and a HEAD that is not the one the join read when it finishes is refused too.

## Early lanes (fill to 5)

The owner's rule (FR2): always try to run 5 agents. When the current step needs fewer, `next` lists in `early` lanes of later steps
that can start now, so the free slots work on the next steps; when the later lanes depend on the open ones, `early` is empty and fewer
agents run. A lane is early when all of these hold (`lib/road-state.mjs` `earlyLanes`; anything unreadable or missing makes it wait):

- its step is after the current one, it has not landed, and its lane row is in STATUS.md;
- it is no UI lane (a `matrix` or a UI file): a UI lane waits for its step and its step-start record, so an early lane never causes
  `baseline needed`;
- it has a `needs` list (omitted = every earlier lane: it waits), naming only lanes of earlier steps, and every one of them has landed:
  by its row and on the base in git (the row's landed `<to>` is a known commit and an ancestor of the base tip; a row alone is never
  trusted);
- none of its files overlaps a file or folder of a not-landed lane of a lower step (carried lanes included), of a started lane, or of
  an early lane already chosen. Paths are compared after `\` becomes `/`, `//` and `./` parts and a trailing `/` are dropped and case is
  ignored; a path that leaves the repo or names its root overlaps everything. A step's `appendOnly` exempts a file only between lanes
  of that same step, never against a lower step.

Order: lanes already started (their row has a start time) come first and are never dropped, also when the budget shrinks; the other
lanes fill `min(budget, 5) - lanes - started early lanes` slots in step and lane order. Started early lanes hold their slots against
the current step too: `lanes` lists at most `5 - started early lanes`, so lanes plus early stay within 5. Each later lane that is not early is in
`waiting` with its reason (`needs c landed first`, `shares src/x.mjs with open lane a (step 1, not landed)`, `no free slot: ...`).
Lane files and needs are read from the road file only; a row a writer added or started never skips a check.

Gates keep their meaning: a step's gate line 1 judges only that step's own lanes (a lane that landed early counts when its step's gate
runs, and a step whose lanes all landed early goes straight to `gate` once it is current); line 2 covers every landing row of the road.
An early lane landed before its step's start record: line 4 accepts its range when it ended at or before the record, its lane is no
UI lane and it changed no UI file (its work is in what the record shows); every other range of the step still needs the record at or
before its `from`, so a UI file the early lane changed outside its listed files fails line 4. Line 3 shows git-tidy findings about the
branches and worktrees of lanes still in flight (early lanes, carried lanes, another road's lanes) as INFO, not FAIL. A started early lane makes its step started: the architect changes only steps none of
whose lanes started.

## Walking an `agents` step

Every step is walked with plain agents:

1. `road.mjs next <road> --budget <free slots>` names the lanes and the early lanes (at most 5 launches at once) and `writers`;
   start `lanes`, then `early`.
2. Per lane: a worktree on the lane branch at the base tip; the implementer works in it and stops before step 3.
3. `road.mjs join <road> --road-sha256 <hex> --lane <name> --worktree <abs> --base <sha>`. Exit 1 returns the lane to its writer or the
   owner; exit 3 gives the findings back to the writer; exit 0 goes on.
4. Land the lanes one at a time: `land-lane --close-row <road>.s<N>.<name>` writes the lane row's `landed <to> on <base> from <from>`
   evidence (an old-form road: its `-land` row).
5. `road.mjs gate <road> --step <N>` when every lane landed.
