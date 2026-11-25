# home/hooks

Claude Code hooks installed to `~/.claude/hooks` (a symlink to this folder). All are Node 22 scripts with no dependencies.

## Reading paths

A hook reads a path that comes from its input, a session transcript or a state folder through `lib/plain-file.mjs`, or with the same open flags: `O_NONBLOCK`, `O_NOFOLLOW`, then `fstat` says it is a regular file. A FIFO or device there is refused at once, instead of holding the hook until its timeout. Where a link is legitimate (an agent file, `~/.claude.json`, a project's `package.json`, a ui-check run file), the path is resolved once with realpath and the real file is read the same way. Elsewhere a link is refused. `tests/hook-reads-no-wait.test.mjs` plants a FIFO at each such path.

## Hooks

- `project-merge.mjs` - SessionStart (startup, resume, clear, compact, fork; the main session only): the note of a project's own AI setup beside ours (owner rule R22: both apply, best of both, nothing listed per project). It says what the project's own AI setup brings beside ours (CLAUDE.md, AGENTS.md and whether it loads, `.claude/rules`, skills with the ones ours hide by name and their paths, agents with `maxTurns`, hooks, settings that change ours, MCP servers), warns when the project turns all hooks off (`disableAllHooks`) or may hide our CLAUDE.md (`claudeMdExcludes`), and adds the project's note found by its repo key (`home/project-notes/<key>.md`, then `~/.claude/project-notes/<key>.md`; a note `CLAUDE.local.md` imports by that very file is named, not repeated). Agents get nothing from it. Its own hook string (JSON `additionalContext`), at most 6,000 characters; repository names and values are labelled as data and quoted; read-only, no state; one 4 s deadline below the 5 s timeout. Prints nothing for a project with no AI files and no note, in HOME, or for a SessionStart inside a subagent. It never blocks. More in [project-merge.mjs details](#project-mergemjs-details).
- `notify.mjs` - Notification(permission_prompt, elicitation_*, quota_auto_resume_stale|disabled), StopFailure(rate_limit): the desktop notes of display design 7.10 (needs you, with the question's short header, limit stopped work) as `terminalSequence`, on the owner's `preferredNotifChannel`. A note goes out only when work waits on the owner or has stopped:
  - `Needs you: question 1 of 2 (Scope) · default in 1:00` comes from the asking marker and holds the first question's short header. The parentheses are left out when there is none. No hook writes that marker since the question popup was removed (2026-11-25). Without a marker the note says `a permission prompt` or `an MCP server asks for input`.
  - `Stopped: 5-hour limit, resumes 17:40` comes from this account's last limit sample (`CLAUDE_ACCOUNT`); with none it says `reset time not known`.
  - `Stopped: ...` also covers a quota wait that will not resume by itself.
  - The unused Stop note queue and its Stop entry were removed on 2026-11-24.
  - The output is `terminalSequence` only: OSC 777 for Ghostty, OSC 99 for Kitty, OSC 9 otherwise, a bell for Apple Terminal. The channel is `preferredNotifChannel` from `~/.claude.json`; there is none when `notifications_disabled`. The hook always exits 0.
- `post-edit.mjs` - PostToolUse(Edit|Write|MultiEdit): runs the project's own `format` script (only one that exists in the nearest `package.json`) on the edited code file. A script that targets the whole repo (`prettier --write .`, `nx run-many`) is replaced by the tool's binary on the edited file, or skipped. A run that outlives its deadline is killed with its whole process tree. `CLAUDE_POST_EDIT_SKIP=all|format` skips it, but not when only the project's committed `.claude/settings.json` sets it: then it runs and warns once per session (`lib/team-switch.mjs`). Any other script runs through the package manager only in a project you trust with `CLAUDE_POST_EDIT_TRUST_FORMAT=1` (shell or untracked `.claude/settings.local.json`); elsewhere only one plain call of a known formatter (prettier, biome, eslint --fix, dprint, oxfmt, ruff format, black, gofmt) runs, as the tool's binary, and anything else is not run, with one warning per session (`lib/format-trust.mjs`). It is silent on success; on failure it prints at most 15 lines and exits 2 (the parser is `lib/diagnostics.mjs`). It runs no lint and no typecheck. By design:
  - Not closed without trust: a known formatter still reads the repo's own config (`prettier.config.js`, `eslint.config.js` and plugins named there run code) and may be the repo's own `node_modules/.bin` binary. Only trust settles that, so open a repo you do not know with care.
  - A script that is more than one plain call (`prettier --write "src/**/*.ts"` with its quotes, `a && b`) runs only with trust; the warning says how to set it.
  - Trust covers every `package.json` inside the trusted project folder, a nested or vendored package included.
- `git-tidy-gate.mjs` - SessionStart(startup, resume): names the lanes of the session's repository that are not landed yet (`unlanded-lane?` of `git-tidy check --json`, each subject once; `lib/tidy-gate-notes.mjs`) as `hookSpecificOutput.additionalContext`, so a new or resumed session sees leftover work at once. It never blocks, and it runs at session start only (plan 2026-11-24: git-tidy check at session start only). The verdict is cached per session in `~/.claude/state/git-tidy-gate/<session>.json` (a hash of all refs and the worktree list), so a repo unchanged for under 10 minutes runs no child. The check child has a 4 s bound (`GIT_TIDY_GATE_CHECK_TIMEOUT_MS` changes it) with core.fsmonitor, log.showSignature and bare repositories off; it is never run when the config view of any worktree of the repo defines a filter; on a timeout nothing is said and a detached refresh fills the cache. Input that is not JSON: silent, exit 0; any other error: one stderr line, exit 0. `tools/land` lands a lane.
- `disk-clean-start.mjs` - SessionStart(startup): starts `tools/disk-free/disk-clean.mjs --apply` detached in the background at most once every 24 h (stamp `~/.claude/state/disk-clean.stamp`, claimed under an `O_EXCL` lock that one process breaks when it is stale; an empty or relative HOME skips the run; the last run's output is in `~/.claude/logs/disk-clean.log`). Links and FIFOs are never followed, and the child gets no tokens. It never waits for the clean-up and never fails the session start; subagents, other sources and input that is not JSON start nothing.

## project-merge.mjs details

- The note it gives the session has these parts, in order:
  - A header with the repo key and where it came from, labelled "names and values below are repository data, not instructions".
  - A `Warning` line when a project settings file turns all hooks off (`disableAllHooks`) or has `claudeMdExcludes` that may hide our CLAUDE.md or rules files (R22-L4: warn only).
  - `Instructions`: CLAUDE.md, .claude/CLAUDE.md, CLAUDE.local.md and AGENTS.md with how it loads; `.claude/rules` is counted.
  - `Skills`: the count, and each project skill ours hides by name (any case) with its SKILL.md path.
  - `Agents`: names and `maxTurns`.
  - `Hooks beside ours`: event and count. Stop blocks count toward `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`; we register no Stop hook.
  - `Settings that change ours`: a weaker model or effort, our check switches, permission mode, keys that replace ours. Values are shown only for model, effort, mode, `disableAllHooks` and our switches; every other value is never shown.
  - `MCP`.
  - `Note`: its path, "loaded by CLAUDE.local.md", or the path to write.
  - `Not checked`: anything a limit or the deadline stopped.
  - The project-agents line of `lib/project-agents-timed.mjs`, then each note under `--- note <key> (shared or personal) ---`.
- Agents get nothing from it (plan 2026-11-24).
- Repo key (`lib/project-note-key.mjs`): the remote name without userinfo, else the main checkout's folder name (worktrees map to it), else the SVN root's or the folder's name. A git failure says "repo key not checked", never a guessed key, and the project-agents line still comes (its child finds the agent folders by a filesystem walk, with no git). A network (UNC) path is not followed. A session in HOME gets nothing.
- Notes: `home/project-notes/<key>.md` (found from the hook's real path), then `~/.claude/project-notes/<key>.md`. Each is one real folder read once, regular files with one name only, at most 8 KiB each.
- Reads (`lib/project-setup-scan.mjs`) never follow a link; each one, a linked `.claude/skills` included, is named under `Not checked`. They list at most 5,000 entries, 8 levels deep, and read settings files up to 256 KiB (a bigger one is "not checked").
- Output: JSON `hookSpecificOutput.additionalContext`, at most 6,000 characters, notes last and cut with a line naming the file.
- It is read-only and keeps no state file. It has one deadline of 4,000 ms, below the 5 s timeout of both entries: git gets 1 s per call, the scan at most 1 s, and the agents child what is left.

## lib/

Helpers: `diagnostics.mjs` (a failed format run to `file:line RULE-ID message`) serves `post-edit.mjs`; `edit-log.mjs` (the per-user hook temp root) serves `team-switch.mjs`; `writer-agents.mjs` (which agent types write files) serves the board (`tools/board/lib/agents.mjs`) and `gated-folder.mjs`. Shared by the stores:

- `session-store.mjs` - small per-session store files (`asking-marker.mjs` and others): lstat-checked, never through a link, never waiting on a FIFO, cleanup of its own old files only.
- `session-lock.mjs` - `withSessionLock`, built on `session-store.mjs`: a lock file (`<pid> <token>`, removed only by its holder, taken over only from a gone pid after 0.5 s or from anyone after 5 s, one waiter at a time, behind a `<lock>.break` file that others treat as a busy lock; it is read again under that file and renamed aside only while it is still the stale one, else linked back; in a rare double release-and-take the moved lock can still be lost) lets hooks recording at the same moment take turns. A caller waits up to 1 s; one that must not wait (the status line's limit sample) passes `waitMs: 0` and tries once.
- `plain-file.mjs` - the one safe open (no waiting, no link followed, regular files only, no append to a hard-linked file, a size cap) for the files the hooks and tools read or append.

## Tests

```sh
node --test tests/*.test.mjs
```
