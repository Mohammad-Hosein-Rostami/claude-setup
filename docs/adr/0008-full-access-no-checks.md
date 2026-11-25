# 0008: Full access, no checks: the rules stay as instructions

- Status: accepted. Date: 2026-11-25 (the owner's decision). Supersedes 0001; supersedes in part 0002 (the main-agent cap, the
  model floor, the suite queue), 0003 (the click-only dialog) and 0006 (the deny list of Claude starts).

## Context

The setup enforced its rules with hooks: a Bash guard that asked, sent a command back once or denied it; a route and cap for
the agents the boss starts; gates on agent briefs and models; a timed permission allow; and a question before an Artifact
publish. It also had commit hooks (gitleaks and the private-word check), a doctor report, a suite queue, and a `land` that
refused to land without a test when both sides changed the same files.

The owner wants agents to have full access on their own machines and every rule kept as an instruction, not as a check. The
owner's later words: remove the suite queue, the doctor checks and land's forced test; keep land's refusal to land unsaved
work and the rule that pruning keeps a folder that may hold the only copy of work.

## Drivers

1. Every command an agent needs runs without a stop.
2. The rules stay readable as plain instructions.
3. Nothing is half removed: a hook that settings still name but that is missing blocks every call.
4. Both machines end in the same state through `scripts/sync-machines.mjs`.

## Options

| Option | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| A. Keep the hooks and add an allow-all switch (`CLAUDE_GUARD_ASK=allow` already exists) | no: denies and bounces stay | ok | ok | ok |
| B. Remove the hooks, keep the doctor report and the suite queue | yes | yes | yes | yes, but it ignores the owner's later words |
| C. Remove every enforcing hook, the commit hooks, the doctor report, the suite queue and land's forced test; set full access in user settings; keep the rules as instructions | yes | yes | yes, by unwiring before deleting | yes |

## Decision

C.

- `permissions.defaultMode` is `bypassPermissions` in `settings/base.json`, so it applies to everyone who installs this setup.
  There are no ask rules, no deny rules and no hook that blocks a call. The only permission rule left is the allow list
  (`WebSearch`, `WebFetch`), and workflows stay off (`disableWorkflows`).
- The hooks that never block stay: the question popup (an unanswered question takes the recommended option after 2 minutes),
  the post-edit formatter, the git-tidy session note, `project-merge`, `notify` and `disk-clean-start`. So do land's unsaved-work
  refusal and the folders that `land` and `git-tidy prune` keep.
- The checks became instructions in `home/CLAUDE.md`, the agent files and `CLAUDE.md`: only the boss starts lex, dev, tess and
  max; at most 3 of each run at once; agents leave `model` and `effort` out and never pass a lower value; never Fable; never
  push unless asked; `max` prepares outward steps and runs one only on an `owner-command:` line; run the full suite on the
  rebased tip (`land --test`) when both sides changed the same files; check the staged changes and the commit message by hand
  before each commit.
- The unwiring comes first: settings stop naming a hook before its file is deleted.
- Update 2026-11-25 (owner): the question popup went too. Bypass mode still asked before a dangerous `rm`; only
  `CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS=1` in the launch environment waives that, and Claude Code turns the waiver
  off while any PermissionRequest hook exists. The installer now writes the variable into the shell start-up files, and an
  unanswered question takes the recommended option when the terminal question auto-continues (`askUserQuestionTimeout`).

A loses on driver 1. B ignores the owner's later words about the suite queue and the doctor report.

## Consequences

- Good: no stops, less code (about 60 libraries and 110 test files), simpler briefs.
- Bad, what the owner loses:
  - No command is checked before it runs: a mistaken `rm -r`, `git push`, deploy or production write runs at once.
  - No dialog or click is needed for outward steps, also while `max` runs; only the instruction stops them.
  - An agent other than the boss can start lex, dev, tess or max, and the boss can start helpers; nothing caps a 4th agent.
  - A Fable or `inherit` model in an Agent call is no longer refused.
  - A built-in Explore or Plan call that names no model runs on the lead model, and a call can run an agent below the model and
    effort of its file.
  - Brief mistakes (several worktrees, no `MATRIX:` line, copying a lane branch) are no longer sent back.
  - A secret or a private word can be committed if the check by hand is skipped.
  - Anyone who installs this shared setup gets full access too.
  - Agents can read `~/.ssh`, `~/.aws`, `*.pem`, `.npmrc` and other credential files.
  - No doctor report: drift between machines or a broken install shows only when something fails or `tess` checks.
  - No suite queue: two full runs at once share the CPU and can slow or time out each other.
  - `land` no longer forces a test when both sides changed the same files.
  - The board no longer knows a writer's launch folder before its first edit.
- Reversal signal: a destructive mistake by an agent that a removed check would have stopped. Then revert this record's
  commits.

## Sources

- Claude Code docs, read 2026-11-25: https://code.claude.com/docs/en/permission-modes, /permissions, /hooks, /settings and
  /sub-agents.
- claudekit.io update notes for Claude Code 2.1.257 and 2.1.295; `claude --help` of 2.1.330.
