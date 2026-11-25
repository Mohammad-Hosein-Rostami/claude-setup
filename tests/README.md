# tests

The test suite of this repo. Plain Node `node:test` files, no test library to install. Each `*.test.mjs` file tests code
in `home/` or `scripts/`; the other `.mjs` files are shared helpers and are not run as tests.

## Run

    node --test tests/*.test.mjs

Never run a bare `node --test`. Nothing runs the whole suite for you: a commit runs no test, and landing (`home/tools/land`) runs one only
with `--test`. One area: `node --test tests/git-tidy*.test.mjs`.
One file: `node --test tests/land.test.mjs`. The `ui-check` tool has its own tests: `pnpm --dir home/tools/ui-check test`.

## Areas (by file name prefix)

- `hook-*`, `notify-*`, `post-edit*`, `project-*`, `git-tidy-gate*`: the hooks (`home/hooks`) and their libraries.
- `modes-consistency`, `rules-text`, `principles`: the always-loaded rule texts.
- `statusline*`, `board-*`: the status line and its board engine.
- `install-*`, `lane-new`, `merge-settings`: the install scripts, the new-lane script and the settings merge.
- `account-*`, `claude-call`, `disk-*`, `env-names*`, `git-tidy-*`, `land`, `refs-*`, `ui-*`: one group per tool in `home/tools/`.

## Shared helpers (not tests)

`pin-home.mjs`, `warm-exec.mjs`, `env-names-fixtures.mjs`, `claude-fakes.mjs`, `account-helpers.mjs`, `timing.mjs`,
`worker-tests.mjs` and the other `*-helpers.mjs` files. Each starts with a comment saying what it gives you.

## Watch out for

- A test that starts a hook must write nothing to `~/.claude`: import `pin-home.mjs` first, because the hook libraries read `HOME`
  when their modules load. `clean-env.mjs` puts inert desktop-note and dialog tools first on `PATH`, so no test shows a real one.
- Run the suite from a plain shell, not from inside a git hook: a hook sets `GIT_*` variables, and a test that runs `git` in a temp folder would then write into this repo.
- A speed target ("decides in under 500 ms") is measured as the fastest of 3 runs (`timing.mjs`: `fastestCpuMs` for work inside the test process, `fastestMs` only when a child process is timed), never one run: the suite runs files in parallel and one run can be slowed by the machine. Keep the threshold; do not raise it.
- A file of slow synchronous tests (each runs a tool through spawnSync) can run them side by side with `worker-tests.mjs`: each body runs in a worker thread, and the file must end with `await runNamedBody();` (a test whose body never ran fails; `worker-tests.test.mjs` checks that).
- Fake executables (`claude`, `llama-server`) are warmed with `warm-exec.mjs`: the first run of a new script can take seconds on macOS.
