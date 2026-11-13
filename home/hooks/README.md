# home/hooks

Claude Code hooks installed to `~/.claude/hooks` (a symlink to this folder). All are Node 22 scripts with no dependencies.

- `mode.mjs` - SessionStart, UserPromptExpansion, UserPromptSubmit: tracks the per-session mode and prints its playbook.
- `skill-router.mjs` - UserPromptSubmit, PostToolUse(Edit|Write|MultiEdit): names the skills to invoke for the prompt or UI file. Never blocks.
- `pre-bash-guard.mjs` - PreToolUse(Bash): denies --no-verify, force push, rm -r outside the project, `.env` reads, lockfile edits.
- `agent-memory-only.mjs` - PreToolUse(Write|Edit|MultiEdit): keeps `reviewer` and `security-auditor` read-only except their memory notes.
- `test-files-only.mjs` - PreToolUse(Write|Edit|MultiEdit): limits `test-writer` to writing test files.
- `post-edit.mjs` - PostToolUse(Edit|Write|MultiEdit): runs the project's own format/lint scripts on the edited file and logs the file for the typecheck gate. `CLAUDE_TYPECHECK_AT=edit` also typechecks after every edit and turns the gate off.
- `typecheck-gate.mjs` - Stop, SubagentStop: typechecks the files the agent edited once, when it stops (incremental `tsc` when the script is a plain `tsc` call). A failure exits 2 so the agent fixes it; an unchanged failure after a retry only tells the user; a timeout never fails. Skipped by `CLAUDE_POST_EDIT_SKIP=typecheck|all`.
- `token-audit.mjs` - manual CLI (not a hook event): prints the approximate recurring token cost of the visible config.

## lib/

Helpers: `diagnostics.mjs` (check output to `file:line RULE-ID message`) and `edit-log.mjs` (per-agent log of edited files in the temp dir) serve `post-edit.mjs` and `typecheck-gate.mjs`. Pure helpers for `pre-bash-guard.mjs`, no I/O:

- `shell-words.mjs` - command text to segments of unquoted words; heredoc stripping, output-redirect stripping, option parsing.
- `env-files.mjs` - `.env` detection and the reader denylist (which commands read which arguments).

## Tests

```sh
node --test tests/*.test.mjs
```
