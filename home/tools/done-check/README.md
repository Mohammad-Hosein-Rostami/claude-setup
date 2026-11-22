# done-check

The always-on code check: the project's own typecheck, lint of the changed lines and the tests related to the changed files, plus a scan
for weakened tests. Every failure is compared with the base commit, so only failures the change caused block. It costs no model tokens
when green. Design: road `newchk`, `design.md` sections 3 and 6.

## Command line

```text
node done-check.mjs run --worktree <abs> [--base <40-hex>] [--where land|manual] [--json]
node done-check.mjs last [--worktree <abs>] [--json]
node done-check.mjs stats [--days <n>] [--json] [--doctor]
node done-check.mjs label <run-id> --as false-alarm|real|missed --check <kind> [--note <up to 200 chars>]
```

| Command | What it does | Exit |
|---|---|---|
| `run` | checks every code file changed between `--base` (default: the worktree's HEAD, so uncommitted work) and the worktree; prints the `checks:` line, then the reason when it blocks (`--json`: the Verdict) | 0 ok, reused or nothing to check; 1 new failures or weakened tests; 2 usage; 3 internal error |
| `last` | prints the line of the newest recorded run of the repository of `--worktree` (any repository without it) | 0 |
| `stats` | per check kind: runs, blocks, acted on, false-alarm rate, median and p90 time, why it did not run; under it a `labelled:` line (false-alarm, real and missed labels, and the runs a false-alarm label let through) and an `ignored:` line (blocks stopped again with the same change and no label), so neither reads as the other; then `by model and effort:` one line per model and effort of the agent that stopped (runs, blocks, left open, median run time; `--json`: `byModel`); `--doctor` adds one `WARN` line per kind over 10% false alarms after 10 blocks, and one when the ledger is full | 0 |
| `label` | records the owner's verdict on one check of one run; a `false-alarm` label lets the same failures through on later runs (below); a `real` label takes an ignored block out of the false-alarm rate and takes back an earlier `false-alarm` | 0, 2 for an unknown run id or a bad flag |

Usage errors (an unknown flag, a relative `--worktree`, a `--base` that is not 40 hex, a folder that is not a git worktree) exit 2 before
anything runs. `DONE_CHECK_SKIP=all` skips every check (one ledger row); a comma list of `types`, `lint`, `tests` skips those kinds.

## The line

`checks: types ok · lint ok · tests ok, 1 old fail · 12.3 s · review: needed (security)`

- `old fail`: the base has the same failure; listed, never blocking. `FAIL n new`: blocks.
- `n flaky`: a new test failure that passed when its test file ran once more at head (that file only, inside the base-side time budget). Listed, never blocking. A rerun that fails again, or cannot finish, leaves the failure new.
- `not run (why)`: the check could not run (`time`, `error`, `no-command`, ...). It never blocks and is never shown as ok. When a kind
  has several packages the line also names each one that did not run.
- `tests none related (n files)`: no test relates to the change. `base: none`: no git base, so failures block once, worded "may be older".
- `n unknown`: with no git base, a test failure in a file the change does not hold (another agent's work or an older failure cannot be
  told apart). Its kind shows `FAIL 0 new, n unknown` and the run is `left open` (never `ok`, never reused as green); it does not block.
  A failure in a file the change holds stays `new`. A stop always has a base (below), so only a Scope built by a caller can show it.
- `review: needed (classes)`: the change is in a risky class (`risk-rules.json`); the lead runs the reviewer. Security words match a whole word of a folder or file name in any case style (`src/auth/`, `useSession.ts`, `session-store.ts`, `JWTService.ts`), never part of a word (`tokenizer.ts`, `author.ts`). A test by its own name (`*.test.ts`, `*.spec.js`) and plain docs (`.md`, `.txt`) put a change in no class and do not count for `large`; a test folder does not hide code, `.mdx` is code, and the texts that steer every run (agent files, `SKILL.md`, `home/CLAUDE.md`, `home/lead*.md`, `home/rules/`, `settings/*.json`) are `gate`. A file whose changed lines are only comments or blank lines is left out; any doubt (no base, a deleted file, a Vue file) keeps the class.
- `reused (same change) ok`: the same change key was already checked green; no command ran. A run a label let through is never reused.
- `n labelled`: new failures that an owner's `false-alarm` label already names. Shown, never blocking (next section).

## False-alarm labels

When the owner says a block is wrong (an approved test removal, say), `done-check.mjs label <run-id> --as false-alarm --check <kind>`
(the id from `done-check.mjs last --json`) makes it stick: each run row stores a short hash of every new failure (kind, id and text;
never a file name), and a later run of the same repository with the same base commit does not block on a failure whose hash a
false-alarm label names. Any other new failure still blocks: one more deleted case or skip in the same file changes the text, so it
is new. The newest label of a (run, check) wins, so a later `real` takes it back. Only a label row can do this, and a label row holds
no hashes, so neither a note nor a failure text can widen what passes. A label is the owner's verdict: an agent does not label its own
block.

A test file deleted together with the module it imports (a relative import at the base, of a file that is not itself a test file)
is removed with its code and is not a weakening at all; a test deleted alone, or with only a fixture, still blocks.

## What counts as a change

Only the stopper's own change in a git worktree. A folder that is not git is never checked (no base, nothing to judge: a lead started
in `~` gets no line for its notes there). Beside its own worktree every stopper is checked in each worktree holding files it edited
itself (one per worktree, also two lane worktrees of one repo), and only on those files: the lead is never handed an agent's lane
worktree it did not edit in. The base is the HEAD the stopper had at its first tool call in that worktree; where none was recorded (a
lead in `~`, an agent started in a folder that is not git, a base commit that is gone) it is the worktree's HEAD, so a test the
uncommitted edit breaks that passes at HEAD is new and blocks.

Code files (`ts tsx js jsx mjs cjs mts cts vue`) and the scripts in a `.githooks/` folder, plus the wide files (`package.json`, lockfiles, tsconfig, test and lint config). A changed text file (markdown, json, ...) counts too when a test file names it (the file name appears in a test-looking file's text): the related-test search then picks the tests that write its path, and no typecheck or lint runs for it. A text file no test names stays `checks: no code change`. In a `node --test` script part only the e2e or live globs are dropped (and named `e2e-or-live`); the other globs still pick related tests. `tests-weakened` also fails when always-true matchers (`toBeDefined`, `toBeTruthy`, `toBeFalsy`) are added while value-checking matchers go down.

## Files

| File | Job |
|---|---|
| `done-check.mjs` | the command line (importing it runs nothing) |
| `lib/check-change.mjs` | orchestration: plan, reuse, run, verdict, ledger row; the hook imports this only |
| `lib/base-compare.mjs` | reruns failed typechecks and failing test files at the base (caches the answers); reruns new test failures once at head (flaky) |
| `lib/verdict-text.mjs` | the line and the block reason |
| `lib/code-lines.mjs` | which lines of a JS or TS text hold code (risk classes skip comment-only edits) |
| `lib/false-alarms.mjs` | the hashed ids of new failures and which of them a false-alarm label lets through |
| `lib/*.mjs` (others), `risk-rules.json` | scope, detect, run, parse, base tree, ledger, weakened-test scan, risk classes |

The ledger is `~/.claude/state/done-check/ledger.jsonl` (counts only, no file names). Tests: `node --test tests/done-check-*.test.mjs`.

## Model and effort on a row

A stop row records the `model` and `effort` of the agent that stopped, so a model or effort choice can be judged by its numbers
(`stats`, trial T7). Both come from Claude Code's own records, never from the agent's report:

- `effort`: the hook input's `effort.level` (Claude Code 2.1.329 sends it on Stop and SubagentStop for a model that supports effort);
  when the input has none, the `effort` Claude Code wrote on the agent's newest reply in its transcript.
- `model`: the hook input has no model field, so it is the `message.model` of the agent's newest reply in its transcript
  (`agent_transcript_path` for a subagent, `transcript_path` for the lead; only the last 512 KB are read).

The model is stored only when it is a model id (`MODEL_PATTERN` in `lib/contract.mjs`: a `claude-` id, its Bedrock or Vertex form, or
`opus`, `sonnet`, `haiku`, `fable`, with an optional `[1m]`-style suffix); any other value is stored as `other`, so a key or token can
never land in the ledger. The effort is one short token (`EFFORT_PATTERN`) or `null`. Land and manual runs store `null` (no agent
stopped). Rows written before the fields existed have neither; `stats` shows both kinds as `unknown`.
