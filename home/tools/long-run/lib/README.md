# long-run/lib

The modules of `long-run.mjs`. The tool's own README has the commands, the job file and the state layout.

| File | What it holds |
|---|---|
| `job.mjs` | the job file: zod schema, defaults, prompt files, `~/` folders, the frozen copy a run keeps, the reload rule |
| `run-store.mjs` | the state folder: paths, atomic JSON, the driver lock and heartbeat, folder locks, journals |
| `run-account.mjs` | the account a run spends (selected at start, recorded, reused) and its token, read in process |
| `graph.mjs` | the LangGraph: a node per step, fan / item / join per parallel group (`Send`), hold nodes (`interrupt`), rerun points |
| `driver.mjs` | the driver of one run: lock, heartbeat, keep-awake, control polling, invoke and resume, the end of a run |
| `step.mjs` | one step or item from its first start to its outcome: journal, outcome table, waits, retries, worktree claim |
| `step-start.mjs` | one `claude` start: fresh or resume, the prompt (wrapper, follow-ups, a told message), the step check, usage row |
| `claude-run.mjs` | the child process: arguments, environment, scrubbed log, graceful end, result classification, orphan end |
| `limit-time.mjs` | when a usage limit resets, from the printed text or the limit samples |
| `control.mjs` | the control files (pause, stop, takeover, tell), the open-session check, the takeover lines per shell |
| `events.mjs` | the per-run and global event lines, rotation, `events --follow` / `--wait-next`, `driver-lost` |
| `view.mjs` | the run status word, `status` lines and `--json`, `summary.md` |
| `watch.mjs` | readable log lines: `log --tail` and `watch` |
| `notify.mjs` | desktop notes and the ntfy phone push |
| `awake.mjs` | keep the machine from idle sleep while a driver lives |
| `os-schedule.mjs` | launchd agents and scheduled tasks: autostart after login, timed starts |
| `cli-common.mjs` | what the commands share: error kinds (one per exit code), opening a run, folder claims, starting the driver |
| `cli-run.mjs` | `check`, `start`, `resume`, `rerun` |
| `cli-control.mjs` | `pause`, `stop`, `takeover`, `tell` |
