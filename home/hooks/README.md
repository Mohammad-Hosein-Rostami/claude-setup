# home/hooks

Claude Code hooks installed to `~/.claude/hooks` (a symlink to this folder). All are Node 22 scripts with no dependencies.

- `mode.mjs` - SessionStart, UserPromptExpansion, UserPromptSubmit: tracks the per-session mode and prints its playbook.
- `skill-router.mjs` - UserPromptSubmit, PostToolUse(Edit|Write|MultiEdit): names the skills to invoke for the prompt or UI file; a bug/fix intent names `root-cause-debug`, a done/ship intent `verify-done` (each once per session; off with `CLAUDE_SKILL_ROUTER=off`). Never blocks.
- `pre-bash-guard.mjs` - PreToolUse(Bash): never hard-blocks. Rules (--no-verify, force push, rm -r outside the project, disk wipes, lockfile edits, literal secrets, push, gh release/pr merge, publish, prod-host writes) open a timed dialog: Allow by default, no answer in 180 s (max 190) goes ahead, Deny on click, native ask when there is no GUI or the dialog failed. Allow and timeout print no decision, so the normal permission flow and deny rules still apply. Logs decisions and `sed -i`/heredoc code writes (for the typecheck gate).
- `artifact-ask.mjs` - PreToolUse(Artifact): the same timed dialog before an Artifact publish or delete.
- `agent-model-guard.mjs` - PreToolUse(Agent|Task): in every mode sets `model: sonnet` on a general-purpose / Explore / built-in call that has none (it would inherit the lead model); Plan gets `opus` in extra-high / ultra-high. Forks and the repo's own agents are untouched.
- `agent-memory-only.mjs` - PreToolUse(Write|Edit|MultiEdit): keeps `reviewer` and `security-auditor` read-only except their memory notes and this session's scratchpad.
- `test-files-only.mjs` - PreToolUse(Write|Edit|MultiEdit): limits `test-writer` to writing test files.
- `post-edit.mjs` - PostToolUse(Edit|Write|MultiEdit): runs the project's own format/lint scripts on the edited file and logs the file for the typecheck gate. `CLAUDE_TYPECHECK_AT=edit` also typechecks after every edit and turns the gate off.
- `typecheck-gate.mjs` - Stop, SubagentStop: typechecks the files the agent edited once, when it stops (incremental `tsc` when the script is a plain `tsc` call). Real diagnostics in the edited files exit 2 so the agent fixes them; a failure the user was already shown, a typecheck that cannot run, and a timeout (which names the unchecked files) only send a message to the user. Skipped by `CLAUDE_POST_EDIT_SKIP=typecheck|all`.
- `ask-gate.mjs` - Stop: blocks once when the lead ends with a request for the owner's decision (narrow phrases or a heading, a `D1:`/`D2:`/`D3:` list; negated, quoted and code text never match) and has not called AskUserQuestion since the last real prompt. Never blocks twice in a row (`stop_hook_active`); any error exits 0. `ASK_GATE_LOG=<file>` appends one JSON line per run.
- `agent-budget.mjs` - PostToolUse (all tools), SubagentStop: a subagent that passes 100 tool calls gets "return a status now" (again every 10 calls); a Read over ~20k chars in the lead's ultra-high session gets a "use scout" warning; the lead gets one "delegate the rest" line after 15 Bash calls with no Agent/Task call between (an Agent/Task call resets it); a subagent whose final report is over a cap its spawn prompt states is sent back once (no stated cap, no check). Fails open.
- `final-reply-cap.mjs` - Stop: blocks once when the final reply is over the line or word cap named in the owner's last prompt ("final reply max 25 lines"). Never blocks twice (`stop_hook_active`); any error exits 0.
- `checkpoint.mjs` - PostToolUse, PreCompact: when a main session's transcript grew by about 40k tokens (bytes / 3.5) since the last checkpoint, and on every compaction, starts a detached job (`tools/recall/checkpoint-job.mjs`) that has Haiku write structured notes of the new tail into the recall DB. Returns at once; one job per session (lock file); subagents (`agent_id`) are skipped; never blocks or prints.
- `recall-digest.mjs` - SessionStart(compact): prints this session's checkpoint notes (owner instructions, open items, decisions, key numbers, files; newest first, at most 6000 chars) and the `recall "<query>" --session current` pointer; waits briefly for a running checkpoint. Separate from `mode.mjs` so the mode output keeps its own cap.
- `token-audit.mjs` - manual CLI (not a hook event): prints the approximate recurring token cost of the visible config.

## lib/

Helpers: `diagnostics.mjs` (check output to `file:line RULE-ID message`) and `edit-log.mjs` (per-agent log of edited files in the temp dir) serve `post-edit.mjs` and `typecheck-gate.mjs`. Pure helpers for `pre-bash-guard.mjs`, no I/O:

- `reply-cap.mjs` - parses a reply-size cap from a prompt and measures a reply (used by `agent-budget.mjs` and `final-reply-cap.mjs`).
- `shell-words.mjs` - command text to segments of unquoted words; heredoc stripping, output-redirect stripping, option parsing.
- `ansi-c.mjs` - decoder for `$'...'` quoting (`\xNN`, octal, `\uNNNN`).
- `command-of.mjs` - segment to the real command (and its word index), looking through keywords, `VAR=x` and wrappers.
- `command-checks.mjs` - git, disk-wipe, lockfile and hidden-`rm` rules for one command; `verdict.mjs` - the `DESTRUCTIVE:` prefix.
- `dangerous-scan.mjs` - finds a dangerous command behind an unknown wrapper; `eval-check.mjs` - `eval` of a variable or substitution.
- `rm-paths.mjs` - `rm -r` target rules and the ordered variable tracking.
- `secrets.mjs` - literal secret detection (returns a kind, never the value) and `maskSecrets`.
- `outward.mjs` - push, gh release, gh pr merge and publish asks.
- `timed-ask.mjs` - the timed native dialog (osascript / PowerShell popup / zenity), `CLAUDE_ASK_TIMEOUT_S`, fallback to the native ask.
- `guard-log.mjs` - masked JSON-line decision log (`~/.claude/logs/guard.jsonl`, `CLAUDE_GUARD_LOG`; file 0600, directory 0700).
- `remote.mjs` - production-host list and the ssh/scp/rsync/psql/mysql write classifier; `sql.mjs` - statement-level read-only SQL check and host detection.
- `code-writes.mjs` - code files a Bash command may rewrite.

## Tests

```sh
node --test tests/*.test.mjs
```
