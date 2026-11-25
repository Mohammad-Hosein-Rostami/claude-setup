# settings

`base.json` holds the settings every machine gets. `macos.json`, `windows.json` and `linux.json` add to it for one OS, and
`local.json` (git-ignored) adds a machine's own. `scripts/install.sh` merges them, in that order, into `~/.claude/settings.json`;
a later file wins and `hooks` lists are appended per event. To change a setting, edit the file here and run `scripts/install.sh`
again. JSON holds no comments, so the reason for each key of `base.json` is in this table.

## Keys of `base.json`

| Key | Why |
| --- | --- |
| `env.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY` | `"1"`: removes survey prompts. |
| `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` | 400000 tokens. The models have a 1M window, and with no window set Claude Code compacts them at about 967K. This value compacts earlier than the default and keeps each turn's re-read smaller (owner choice, 2026-11-14). |
| `env.BASH_DEFAULT_TIMEOUT_MS` | `"300000"` ms (5 minutes; the CLI default is 120000). A Bash call that runs longer moves to the background, and the longest test suite takes about 4 minutes. A call's own `timeout` can ask for more, up to `BASH_MAX_TIMEOUT_MS` (600000 by default). |
| `env.CLAUDE_CODE_SUBAGENT_MODEL` | `claude-sonnet-5-5`: the model for agents that pin none. |
| `env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` | `"3"` (`road-cap`, 14e): today's depth 3 is read from the environment, then a remote flag, then the default 3, so unset it could change without a release; set, it cannot. |
| `env.CLAUDE_CODE_DISABLE_WORKFLOWS` | `"1"`: switches workflows off in the CLI (the second of the three ways, see `disableWorkflows`). |
| `env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` | `"100"` (subagents running at once): Claude Code's own cap of every subagent, helpers included (default 20; it cannot be switched off). It is set high so helpers are not capped; the limit of 3 main agents is an instruction in `home/CLAUDE.md`. JSON holds no comments, so the reason is here. |
| `disableWorkflows` | `true`: workflows are off by setting. The env `CLAUDE_CODE_DISABLE_WORKFLOWS` says the same, so one that fails to hold leaves the other (U8 of the plan "no workflows", probed live after the restart). |
| `permissions.allow` | WebSearch, WebFetch (`Workflow` is no longer allowed: workflows are off, see `disableWorkflows`). |
| `permissions.defaultMode` | `bypassPermissions`: agents have full access and no command asks for permission (owner decision of 2026-11-25, `docs/adr/0008-full-access-no-checks.md`). Claude Code ignores it in a project's settings, so it lives in the user settings the installer builds from this file. Bypass mode still asks before a dangerous `rm` unless `CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS=1` is in the environment Claude Code starts in: it ignores that variable in `env` here, so the installer writes it into the shell start-up files (`scripts/install/rm-waiver.mjs`). Claude Code also drops the waiver while any PermissionRequest hook exists or a deny or ask rule names Bash, Edit or Read, so this file has none. |
| `model` | `opus`: the default lead at effort high (RC1). A machine can set its own in its git-ignored `local.json`. The owner picks the lead with `claude --model <m> --effort <e>`; there are no setup modes. |
| `autoContinueAtUsageLimit` | `true`: a run continues past a usage limit. |
| `hooks` | Notification(needs-you and quota types), StopFailure(rate_limit) -> `notify.mjs`; SessionStart -> `git-tidy-gate.mjs` (startup, resume), `disk-clean-start.mjs` (startup), `project-merge.mjs` (startup, resume, clear, compact, fork); PostToolUse(Edit, Write, MultiEdit) -> `post-edit.mjs`. No hook blocks a call, and there is no PermissionRequest hook: one would turn off the dangerous-rm waiver (see `permissions.defaultMode`). |
| `askUserQuestionTimeout` | `"10m"`: a question left unanswered in the terminal auto-continues after 10 minutes, and Claude is told nobody answered; the rules (`home/skills/ask-owner/SKILL.md`) then take the recommended option. Claude Code 2.1.330 accepts only `60s`, `5m`, `10m` and `never`, so the 2 minutes the question popup used cannot be set here; when the timer runs is in `docs/daily-use.md`, "Long or unattended runs". A test keeps the value one of the four. |
| `statusLine` | `command`: `statusline.mjs`. `refreshInterval` is 5 (seconds): the agents row and a question's countdown move while the session waits on background agents (one render reads cache files only). |
| `enabledPlugins` | plugin id -> true/false (mirrors `plugins/plugins.json`; why each is on or off: `plugins/README.md`). |
| `modelSettings` | Effort per model: Opus 5.5 high, Sonnet 5.5 medium, Haiku 5.5 medium. |
| `pluginConfigs` | `cc-plugin-agents-md@builtin`, `options.instructionFiles` is `"claude-md-and-agents-md"`: a project's AGENTS.md loads beside its CLAUDE.md (the default `claude-md-or-agents-md` loads AGENTS.md only where no CLAUDE.md is). Claude Code reads it only from user, `--settings` and managed files (memory docs), and it needs Claude Code 2.1.277+. `project-merge.mjs` says per project how AGENTS.md loads. |
| `promptSuggestionEnabled` | `false`: no prompt suggestions (the suggested next prompt Claude Code offers after a reply); turned off as a performance choice (commit 18662b23). |
| `awaySummaryEnabled` | `false`: no session recap when you return after 5 or more minutes away (an internal key in the Claude Code 2.1.329 settings schema, not in the public docs); turned off with `promptSuggestionEnabled`. |
| `skillOverrides` | `"user-invocable-only"` for the built-in skills only the owner starts (`code-review`, `fewer-permission-prompts`, `init`, `keybindings-help`, `security-review`, `ship-local` (`/ship`), `steward`, `update-config`): hidden from the model in every session and agent, `/name` still works (about 1.2k tokens saved per session). Keys are skill names, not aliases; plugin skills ignore the key (Claude Code skills docs, 2026-11-25). |
| `worktree` | `baseRef` is `"head"`: agent worktrees (Agent `isolation: worktree`, `EnterWorktree`, `--worktree`) start from the local HEAD of the folder the session is in at that moment, not `origin/<default>`, with no `git fetch` (a `--worktree` pull-request checkout still fetches its ref), in every project on the machine that does not set the key itself; the CLI default is `fresh`. Start `build` and `bugfix` from a checkout on the base branch: a session inside a lane worktree or on a feature branch passes that branch's commits to every new agent worktree. This repo's local main often runs far ahead of `origin/main` (it is pushed only when the owner says so). |

`permissions.additionalDirectories` is not set in `base.json`: `{{CLAUDE_HOME}}/workflows` was removed with the workflows. It is a
union across the settings files, so a machine can still add folders.

## OS files and `local.json`

OS files: `settings/macos.json` (Notification hook plays a sound), `settings/windows.json` (Notification hook beeps),
`settings/linux.json` (empty).

`settings/local.json` (gitignored, per machine): see `local.json.example` (`skipDangerousModePermissionPrompt`); its `hooks`
are appended to the shared ones (e.g. the PC's Android incubator hook).
