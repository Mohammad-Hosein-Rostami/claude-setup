# road

A big job as a road of steps: every step is fixed at the start, holds 1-5 lanes that share no file, and is checked by a gate before the
next one starts. The road file holds the plan; the STATUS.md rows hold the state (no state file).

## The road file

`road-<id>.json` in the folder of the job's STATUS.md (never committed: add it to `.git/info/exclude` like STATUS.md). `<id>` matches
`^[a-z][a-z0-9-]{0,7}$`. The architect writes it with the spec and changes only steps not started yet; run `check` after every change.

Keys: `road`, `goal`, `repo` (absolute, a drive path allowed), `base`, `suite`, `spec` (default spec of every lane), `questions[]`
(`question`, `options[]`, `recommended`, `askAtStep?`), `steps[]` (`goal`, `measure?`, `appendOnly?`, `form?`: `"build"` (default) or
`"agents"` for a step the owner steers with plain agents, `lanes[]`). A lane is the `build` lane object (`files`, `acceptanceTests`,
`implementer`, `matrix?`, `principles?`, `checkpoints?`, `addClasses?`, `spec?`) plus `name` (`^[a-z0-9][a-z0-9-]{0,23}$`, unique, not
`check`, not ending `-land`), `item`, `size` S/M/L, `closeSize?` (default M), `branch` and `needs?` (lanes of earlier steps; omitted =
every earlier lane; `[]` = none).

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

A close row that landed inside the same fast-forward as another close row (so it cannot have a range of its own) is closed by a done
`<close row id>.landed` row whose evidence says `landed within <other close row id>`. The gate then gives that row no range, and
fails line 2 unless the named row is a close row (road entry or fix row) of the same road with a valid range of its own (its landed
line or its `.landed` correction). A row cannot name itself, and the named row cannot itself be a `within` row (no chains).

A sha in a row (`<to>`, `<from>`, `reviewed <sha> clean`) may be 7 to 40 hex characters. The gate resolves each one once to its full commit
sha (`git rev-parse --verify --quiet <sha>^{commit}`) and uses only full shas after that; a sha git does not know, or finds ambiguous, is a
FAIL line naming the row. A steered (`agents`) step needs `reviewed <sha> clean` on each lane row; a done cell never changes, so when the lane
row's own evidence has no such line the gate takes it from a done correction row `<lane row id>.reviewed` (looked up like `.landed`, ignoring
case). The lane row's own line wins; the correction row is not read for a step that is not steered.

## Commands

| command | does | exit |
|---|---|---|
| `road.mjs check <road.json>` | checks the file: at most 5 lanes per step, no file shared outside `appendOnly`, `needs` only to earlier steps, ids, patterns; warns when lanes of a step share an earlier lane or a contract file and no earlier lane lands an integration test | 0 ok, 1 refused |
| `road.mjs rows <road.json> [--base <sha>]` | adds every missing row of every step to the STATUS.md beside the road file (through `status.mjs add`); a second run adds 0; refuses a road id used with other items and a second open road. `--base` writes that sha as the road-start tip (a road started before the tool) | 0, 1 refused, 2 a `--base` that is not an ancestor of the tip or already holds a landed patch |
| `road.mjs rows <road.json> --fix <N> <name>` | adds the audit-fix rows of step N; refused once step N's check row is done | 0, 1 |
| `road.mjs next <road.json> --budget <1-5>` | JSON `{ road, step, of, state: build\|gate\|done, form, held, carried, lanes, writers, baseline, args? }`: the lowest step with an open check row, landed lanes skipped, held lanes named, carried lanes first, at most 5; `writers` = the smallest of lanes + test lanes, the budget and 5; `args` are the `build` args (add `scriptsDir`), with `resume: true` once a row of the step started | 0, 1 `baseline needed: <road>.s<N>` (a UI step with no `ui-proof` step-start record) or no rows yet, 2 no or bad `--budget` |
| `road.mjs gate <road.json> [--step <N>]` | one line per check (spec-stages section 5): 1 rows, 2 landing ranges, 3 `git-tidy check`, 4 `test-pass check <tip> --suite`, 5 `audit-log gate`, 6 UI proof, 7 the measure (INFO) | 0 PASS, 1 any FAIL |

Every subprocess runs without a shell and with its own timeout. The UI-file rule is the ui-proof tool's (`ui-proof changed`); without that
tool installed a markup and style file rule stands in, which counts more lanes as UI, never fewer.
