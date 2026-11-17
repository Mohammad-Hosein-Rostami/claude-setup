# wf-resume

Finds the workflow runs that did not finish (a killed process, a usage-limit stop, an account switch) and continues them.

- `wf-resume.mjs list | call <runId> | adopt <runId> --into <session folder>`: see the header of the file; exit 0 done, 1 refused, 2 usage.
- `lib/registry.mjs`: the per-session record file written by `home/hooks/workflow-register.mjs` (`~/.claude/state/workflow-runs/<session>.json`).
- `lib/run-state.mjs`: what a run left on disk (finished, ended early, lost, unfinished) from its run folder.
- `lib/notice.mjs`: the text of the SessionStart notice (`home/hooks/workflow-resume-notice.mjs`) and of `list`.
- `lib/owned-git.mjs`: the worktrees and branches a run owns, read with time-boxed read-only git.
- `lib/adopt.mjs`: copies one run's `journal.jsonl` into another session's folder, the only way a new session can resume it.

The folder layout read (`<session>/subagents/workflows/<runId>/journal.jsonl`) is undocumented in Claude Code 2.1.326; re-check it after an upgrade.
Why and how: `docs/daily-use.md` ("Resume after an exit or an account switch") and `home/workflows/README.md` ("Restart").
Tests: `node --test tests/wf-resume-*.test.mjs`; they build a temp HOME and never touch the real `~/.claude`.
