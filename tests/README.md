# tests

The test suite of this repo. Plain Node `node:test` files, no test library to install. Each `*.test.mjs` file tests code
in `home/` or `scripts/`; the other `.mjs` files are shared helpers and are not run as tests.

## Run

    node --test tests/*.test.mjs

Never run a bare `node --test`. The pre-commit hook (`.githooks/pre-commit`) runs the same
command after gitleaks. One area: `node --test tests/watch*.test.mjs`. One file: `node --test tests/estimate.test.mjs`.
The `ui-check` tool has its own tests: `pnpm --dir home/tools/ui-check test`.

## Areas (by file name prefix)

- `pre-bash-guard*`, `secrets-*`, `allowed-literals`, `remembered-ask`, `timed-ask`: the Bash guard hook and its helpers (`home/hooks/lib`).
- `ask-gate`, `artifact-ask`, `permission-timed-allow`, `agent-*`, `test-files-only`, `post-edit*`, `typecheck-gate*`: the other hooks.
- `ask-queue*`: the `ask` tool's decision queue.
- `mode*`, `ccm`, `skill-router*`, `statusline`: modes, the launcher, the skill router and the status line.
- `install-order`, `lane-new`, `merge-settings`, `doctor-*`: the install scripts, the new-lane script, settings merge and health check.
- `env-names*`, `estimate*`, `readable*`, `recall-*`, `ui-coverage*`, `watch-*`: one group per tool in `home/tools/`.

## Shared helpers (not tests)

`hook-env.mjs`, `pin-home.mjs`, `warm-exec.mjs`, `env-names-fixtures.mjs`, `estimate-tables.mjs`, `readable-helpers.mjs`, `recall-helpers.mjs`,
`recall-fakes.mjs`, `timing.mjs`, `pre-bash-guard-final-cases.mjs`. Each starts with a comment saying what it gives you.

## Watch out for

- Tests that start a hook use `hook-env.mjs`, so no real dialog opens on your screen and no log goes to `~/.claude/logs`.
- Import `pin-home.mjs` first in a guard test; the guard reads `HOME` when its modules load.
- The pre-commit hook clears the `GIT_*` variables before running tests. A test that runs `git` in a temp folder would otherwise write into this repo.
- A speed target ("decides in under 500 ms") is measured as the fastest of 3 runs (`fastestMs` in `timing.mjs`), never one run: the suite runs files in parallel and one run can be slowed by the machine. Keep the threshold; do not raise it.
- Fake executables (`claude`, `llama-server`) are warmed with `warm-exec.mjs`: the first run of a new script can take seconds on macOS.
