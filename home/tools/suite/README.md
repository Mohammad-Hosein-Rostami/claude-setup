# suite

Runs a test suite through one queue for the whole machine, remembers a pass, and picks the tests a change can affect. Parallel
lanes then neither overload the machine (a suite already uses every core) nor run the same suite on the same tree twice.
Node 22, git, no dependencies.

```sh
node ~/.claude/tools/suite/suite.mjs run [--repo <dir>] [--slots <n>] [--fresh] [--log <file>] -- <command> [args...]
node ~/.claude/tools/suite/suite.mjs related [--repo <dir>] --base <ref> [--tip <ref>]
node ~/.claude/tools/suite/suite.mjs status
```

## run

Runs `<command>` in `--repo` (default: the current folder) once a slot is free, with its output in a log file.

```text
PASS node --test tests/a.test.mjs
ℹ tests 12
ℹ pass 12
ℹ fail 0
ℹ duration_ms 840.1
log: ~/.claude/state/suite/logs/2026-11-24T21-03-05-118Z-4242.log
```

- Output: `PASS <command>` or `FAIL (exit <n>) <command>`, the node:test summary lines found at the end of the log, on a failure
  the last 40 lines of the log, and always the log path. Only the last 256 KB of the log is read, so a huge log costs nothing.
- Exit: the command's own exit code; 128 + the signal number when a signal ended it; 127 when it cannot be started; 2 for a
  usage error or a bad `config.json`.
- The command is passed as argv, never through a shell (so `;`, `$()` or quotes in an argument stay text). On Windows that means
  a `.cmd` such as `npm` needs `cmd /c npm ...`.
- It runs in its own process group. SIGINT, SIGTERM and SIGHUP to `suite run` end it with 128 + the signal number, kill that
  group (every test process the command started; on Windows `taskkill /T`) and free the slot.
- `--log <file>`: write the log there instead of `state/suite/logs/` (logs there are removed after 14 days).

### Pass cache

- A cache hit prints `cached PASS <first 12 of the tree sha> <ISO time of the pass> <command>` and the log of that pass, runs
  nothing and exits 0. It is never shown as a bare `PASS`.
- A pass is stored only when the worktree is clean (`git status --porcelain --untracked-files=all` prints nothing) before the
  run, and still clean on the same tree after it. A failure is never stored, so it always runs again.
- The key is the sha256 of the tree sha (`git rev-parse HEAD^{tree}`, so a worktree uses its own), the command as given, the Node
  version and the platform. Two worktrees on the same tree share a pass; anything else is a miss. Entries are kept 14 days.
- `--fresh` skips the lookup and always runs (a flaky-test hunt, a suspected environment problem); a pass still updates the cache.
- What the key cannot see: files git ignores (such as `node_modules`) and anything outside the repo. If a cached pass is ever
  contradicted by a fresh run, set `"cache": false` in `config.json` and find out why.

### Queue

- At most `slots` suites run at once on this machine; the others wait in arrival order and check again every 2 s inside the tool
  (the caller does not poll).
- Slots: `--slots <n>`, else `slots` in `state/suite/config.json`, else 1 (measured, see below). A run with `--slots n` uses the
  slot folders 0 to n-1, so give every caller the same number (leave it to the config).
- A slot whose holder's process is gone, or that is older than 2 h 10 min (past the 2 h command timeout agents use), is removed
  by the next waiter, so a crash never blocks the queue. A waiter's ticket that was not refreshed for 30 s is removed too.
- A `suite run` killed with SIGKILL cannot stop its command: the slot is freed (its pid is gone) while the command may still run.

## related

Prints the test files a change can affect, one per line; or the single line `full` (the reason on stderr) when the full suite is
needed; or `none` when no test is related. `none` means nothing ran, so it is never a pass. Exit 0; exit 2 for a bad ref or a
folder that is not a repository.

The change is `git diff --name-only <base>...<tip>`; without `--tip`, the base against the worktree (uncommitted and untracked
files too); with `--tip`, the worktree's own uncommitted and untracked files are added as well. Rules, per changed file:

| Changed file | Selects |
| ------------ | ------- |
| `package.json`, `settings/*`, `.githooks/*` | `full` |
| a test file (`*.test.mjs`, `*.test.js`) | itself (a deleted one: nothing) |
| a `.mjs` / `.js` file | every test that imports it, directly or through other files, and every test that names the basename of the file or of a file that imports it (tests spawn tools and hooks by path) |
| any other file | the tests that name its basename |
| a file no test reaches | `full`, unless it is a plain doc: a `.md` outside `home/agents` and `home/skills` that is not a `CLAUDE.md` |

More than 40% of all test files selected is `full` too. A test that reads a whole folder (such as `home/agents/`) without naming
the file is not found: the full suite before landing still runs it.

## status

```text
slots: 1 (state ~/.claude/state/suite)
slot 0: pid 4242 since 2026-11-24T21:03:05.118Z repo /path/to/lane command node --test tests/a.test.mjs
waiting: pid 4300 since 2026-11-24T21:03:09.002Z repo /path/to/other command node --test tests/b.test.mjs
```

A slot marked `(stale: ...)` is removed by the next waiter. Exit 0.

## State

`$CLAUDE_CONFIG_DIR/state/suite/` (else `~/.claude/state/suite/`), one folder for every session and worktree on the machine:

| Path | What |
| ---- | ---- |
| `config.json` | optional: `{ "slots": 1, "cache": true }` (slots 1 to 64; `cache: false` turns the pass cache off) |
| `slots/<i>/holder.json` | one folder per running suite: `{pid, startedAt, repo, command, token}` |
| `tickets/<ms>-<pid>` | one file per waiter: `{pid, since, repo, command}` |
| `cache/<key>.json` | one stored pass: `{at, tree, command, repo, log}` |
| `logs/` | run logs, removed after 14 days |

It holds only locks, the cache and logs: delete it at any time (no suite running) to start clean.

## How many suites at once

Measured on the MacBook (14 cores, Node 26.5.0), `node --test tests/*.test.mjs` (204 files, before this lane) started 1, 2 and 3 times together,
3 batches each, through `with-run-tmp.mjs`. Wall time is the time until the last suite of the batch ended.

| Suites together | Wall time per batch | Per suite (wall / suites) | Result |
| --------------- | ------------------- | ------------------------- | ------ |
| 1 | 122.8 s, 126.1 s, 123.5 s | 124 s | all passed |
| 2 | 244.7 s, 236.2 s, 274.3 s | 118 to 137 s | one suite of the third batch failed (exit 1) |
| 3 | stopped after 14 min in the first batch | - | `long-run-control` and `long-run-tell` tests hung (0 % CPU, waiting on their fake `claude`) |

The machine was not idle: other sessions ran agents (load average 7 to 20 at the start); before each batch the script waited
until no other suite ran. Chosen default: **1 slot**. Two suites at once finish no more suites per hour than one after the other
(about 2 min of wall time per suite either way, since one suite already keeps every core busy), each of them takes twice as
long, and the load made tests fail or hang. With 1 slot the first caller has its verdict in about 2 min instead of 4, and the
second one at the same time as before. Measure again (and change `config.json`) on a machine with other numbers.

## Files

- `suite.mjs`: the CLI (arguments, config, the run and its report, `related`, `status`).
- `lib/queue.mjs`: `acquireSlot({ stateDir, slots, label })`, `queueState(stateDir)`: slots, tickets, stale holders.
- `lib/cache.mjs`: `cacheKey`, `lookup`, `recordPass`, `removeOlderThan`.
- `lib/related.mjs`: `relatedTests({ repo, changedFiles })`.

Git runs through `../git-tidy/lib/git.mjs` (no shell, no repository chosen by the environment); the changed files come from
`../risk/lib/range.mjs`. Tests: `tests/suite.test.mjs`. Not verified on Windows (signals, `taskkill`).
