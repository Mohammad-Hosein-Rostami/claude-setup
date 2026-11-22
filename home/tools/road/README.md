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
`check`, not ending `-land`), `item`, `size` S/M/L, `closeSize?` (default M), `branch` and `needs?` (lanes of earlier steps; omitted =
every earlier lane; `[]` = none).

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

Lane `<road>.s<N>.<name>` (item `build: <item>`), close `<road>.s<N>.<name>-land` (item `close: review and land <name>`), check
`<road>.s<N>.check` (item `close: step N checkpoint`; step 1's adds `, base <sha>`, the road-start tip, written once). Every close row's
evidence is `landed <to> on <base> from <from>` (the lead writes it when `land-lane` has landed the lane). An audit fix gets `<road>.s<N>.fix-<name>` (item
`rework: <name>`) and its `-land` close row. Ids stay at most 40 characters. The item wording (`close: review and land ...`, `... checkpoint`) is kept as it was so that rows written by an
earlier road still match (`rows` refuses a row id that exists with another item); a close row's work no longer includes a review.

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

A sha in a row (`<to>`, `<from>`) may be 7 to 40 hex characters. The gate resolves each one once to its full commit
sha (`git rev-parse --verify --quiet <sha>^{commit}`) and uses only full shas after that; a sha git does not know, finds ambiguous, or
answers with a commit that does not start with it (a branch or tag named like hex), is a FAIL line naming the row. The gate reads no
review, test or audit record: a `reviewed <sha> clean` line or a `.reviewed` row in a STATUS.md is ignored.

## Commands

| command | does | exit |
|---|---|---|
| `road.mjs check <road.json>` | checks the file: at most 5 lanes per step, no file shared outside `appendOnly`, `needs` only to earlier steps, ids, patterns; a lane with a UI file needs a `matrix`; warns on the retired `form: "build"` | 0 ok, 1 refused |
| `road.mjs rows <road.json> [--base <sha>]` | adds every missing row of every step to the STATUS.md beside the road file (through `status.mjs add`); a second run adds 0; refuses a road id used with other items and a second open road. `--base` writes that sha as the road-start tip (a road started before the tool) | 0, 1 refused, 2 a `--base` that is not an ancestor of the tip or already holds a landed patch |
| `road.mjs rows <road.json> --fix <N> <name>` | adds the audit-fix rows of step N; refused once step N's check row is done | 0, 1 |
| `road.mjs next <road.json> --budget <1-5>` | JSON `{ road, step, of, state: build\|gate\|done, form, held, carried, lanes, writers, baseline }`: the lowest step with an open check row, landed lanes skipped, held lanes named, carried lanes first, at most 5; `writers` = the smaller of the lane count and the budget, at most 5 | 0, 1 `baseline needed: <road>.s<N>` (a UI step with no `ui-proof` step-start record) or no rows yet, 2 no or bad `--budget` |
| `road.mjs join <road.json> --road-sha256 <hex> --lane <name> --worktree <abs> --base <40-hex> [--json]` | judges the scope of one built lane (below): prints `joined <sha>`, `finding <id>: <text>`, `ui-files: <n>` and its `ui-file` lines | 0 joined clean, 3 joined with findings, 1 refused, 2 usage |
| `road.mjs gate <road.json> [--step <N>]` | one line per check (spec-stages section 5): 1 rows (every lane of the step landed), 2 landing ranges, 3 `git-tidy check`, 4 UI proof (always runs, when a UI file changed or a lane has a matrix), 5 the measure (INFO). No line runs or asks for a test, a review or an audit | 0 PASS, 1 any FAIL |

Every subprocess runs without a shell and with its own timeout. The UI-file rule is the ui-proof tool's (`ui-proof changed`); without that
tool installed a markup and style file rule stands in, which counts more lanes as UI, never fewer.

## Join

`join` is the scope judging of one lane, after its writers stopped. The lead passes the sha256 of the road file (from `shasum -a 256`, taken
when the road was written); a file that hashes differently, an unknown lane or an unreadable road is refused (exit 1). The lane tip is the
worktree's HEAD, read with git; `--base` must be its ancestor.

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

## Walking an `agents` step

Every step is walked with plain agents:

1. `road.mjs next <road> --budget <n>` names the lanes (at most 5 launches at once) and `writers`.
2. Per lane: a worktree on the lane branch at the base tip; the implementer works in it and stops before step 3.
3. `road.mjs join <road> --road-sha256 <hex> --lane <name> --worktree <abs> --base <sha>`. Exit 1 returns the lane to its writer or the
   owner; exit 3 gives the findings back to the writer; exit 0 goes on.
4. Land the lanes one at a time (`land-lane`), and write each close row's `landed <to> on <base> from <from>` evidence.
5. `road.mjs gate <road> --step <N>` when every lane landed.
