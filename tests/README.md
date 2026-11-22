# tests

The test suite of this repo. Plain Node `node:test` files, no test library to install. Each `*.test.mjs` file tests code
in `home/` or `scripts/`; the other `.mjs` files are shared helpers and are not run as tests.

## Run

    node --test tests/*.test.mjs

Never run a bare `node --test`. Nothing runs the suite for you: the pre-commit hook (`.githooks/pre-commit`) only runs gitleaks and
`node --check` on staged hook files, and landing runs no tests. One area: `node --test tests/watch*.test.mjs`. One file: `node --test tests/estimate.test.mjs`.
The `ui-check` tool has its own tests: `pnpm --dir home/tools/ui-check test`.

## Areas (by file name prefix)

- `pre-bash-guard*`, `secrets-*`, `allowed-literals`, `remembered-ask`, `timed-ask`: the Bash guard hook and its helpers (`home/hooks/lib`).
- `ask-gate`, `artifact-ask`, `permission-timed-allow`, `agent-*`, `post-edit*`: the other hooks.
- `ask-queue*`: the `ask` tool's decision queue.
- `mode*`, `skill-router*`, `statusline`: the session-notes hook (lead rules, compaction notes), the skill router and the status line.
- `install-order`, `lane-new`, `merge-settings`, `doctor-*`: the install scripts, the new-lane script, settings merge and health check.
- `env-names*`, `estimate*`, `readable*`, `recall-*`, `ui-coverage*`, `watch-*`: one group per tool in `home/tools/`.

## Shared helpers (not tests)

`hook-env.mjs`, `pin-home.mjs`, `warm-exec.mjs`, `env-names-fixtures.mjs`, `estimate-tables.mjs`, `readable-helpers.mjs`, `recall-helpers.mjs`,
`recall-fakes.mjs`, `timing.mjs`, `pre-bash-guard-final-cases.mjs`, `worker-tests.mjs`. Each starts with a comment saying what it gives you.

## Watch out for

- Tests that start a hook use `hook-env.mjs`, so no real dialog opens on your screen and no log goes to `~/.claude/logs`.
- Import `pin-home.mjs` first in a guard test; the guard reads `HOME` when its modules load.
- Run the suite from a plain shell, not from inside a git hook: a hook sets `GIT_*` variables, and a test that runs `git` in a temp folder would then write into this repo.
- A speed target ("decides in under 500 ms") is measured as the fastest of 3 runs (`fastestMs` in `timing.mjs`), never one run: the suite runs files in parallel and one run can be slowed by the machine. Keep the threshold; do not raise it.
- A file of slow synchronous tests (each runs a tool through spawnSync) can run them side by side with `worker-tests.mjs`: each body runs in a worker thread, and the file must end with `await runNamedBody();` (a test whose body never ran fails; `worker-tests.test.mjs` checks that).
- Fake executables (`claude`, `llama-server`) are warmed with `warm-exec.mjs`: the first run of a new script can take seconds on macOS.
