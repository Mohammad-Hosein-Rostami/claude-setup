# Catalog

Everything this setup ships, read from the files in `home/`, `settings/`, `plugins/` and `tools/`. Skill and agent
descriptions are quoted from their frontmatter; those descriptions are what make them trigger.

## Skills (`home/skills/<name>/SKILL.md`)

| Skill | Description (trigger) | Model |
| ----- | --------------------- | ----- |
| `accessibility-build` | Use while writing or changing UI code (.tsx/.jsx/.vue/.html; MUI components, dialogs, menus, icon buttons, forms) so it is accessible from the start - semantic HTML, keyboard, focus, labels, contrast, motion (WCAG 2.2 AA). | session model |
| `async-ui-states` | Use for any screen that loads or changes server data - loading, empty, error, offline, stale responses, pagination, search-as-you-type. | session model |
| `clean-code` | Use when writing or changing code, and again before finishing a coding step - naming, size, complexity, errors, comments, duplication, dead code, scope. | session model |
| `datetime-handling` | Use whenever code stores, parses, compares, shows or schedules dates and times, in the UI or the backend - time zones, DST, date-only values, formats. | session model |
| `e2e-browser-test` | Use when writing or fixing end-to-end or browser tests, or when verifying a UI in a real browser. | session model |
| `escalate` | Send a hard design, architecture or stubborn-bug question to Opus 5.5 in an isolated fork and get a short decision. Not for implementation. | claude-opus-5-5 |
| `figma-pixel-perfect` | Use whenever a task has a Figma link, frame or node id, or says match the design / pixel perfect - pull the baseline, build, compare with ui-check, fix until it passes, then check responsive. | session model |
| `forms-validation` | Use when building or changing a form or any user input flow - validation, errors, autofill, double submit, optimistic UI. | session model |
| `frontend-performance` | Use when a page is slow, heavy or janky, or when adding images, fonts, libraries or routes - Core Web Vitals, bundles, rendering. | session model |
| `frontend-security` | Use when rendering user content, handling tokens, loading third-party scripts, or touching cookies, CORS or CSP in a web app. | session model |
| `mode` | Switch this session's setup mode: normal (thrift), medium (default, balanced), high (full speed), extra-high (lead Opus 5.5 at max) or ultra-high (lead Fable 5.2 at high). (manual only: slash command) | session model |
| `handoff` | Write a compact handoff note so work can continue in a fresh session after /clear. Use at a phase change, before /clear, or when the user says handoff or continue later. (manual only: slash command) | inherit |
| `quick` | Run a simple lookup or mechanical task on Haiku 5.5 in an isolated fork - find, list, read and summarise (read-only, no commands). | haiku |
| `responsive-ui` | Use when building or changing any page, screen, step or component layout (.tsx/.jsx/.vue/.css/.scss, MUI sx/styled, Tailwind), even a small UI tweak - mobile-first, breakpoints, container queries, touch targets, overflow at 320px, reflow. | session model |
| `root-cause-debug` | Use for a bug, failing or flaky test, red CI or unexpected behaviour, before proposing any fix. | session model |
| `safe-refactor` | Use when restructuring code without changing behaviour, including renames, extractions and moves. | session model |
| `tdd-loop` | Use when implementing a feature or bug fix with testable behaviour, including any new logic or branch. | session model |
| `tech-research` | Use when a design decision depends on external facts you lack - service limits, versions, pricing, standards, known failure modes. Search the web and cite. For library API docs use context7. | session model |
| `token-audit` | Audit where tokens go in this project's Claude setup - instruction files, rules, skills, agents, MCP servers - and propose concrete cuts. Use periodically or when sessions feel expensive. (manual only: slash command) | sonnet |
| `tradeoff-analysis` | Use when a design choice has two or more credible options (datastore, queue, sync vs async, build vs buy) - compare them, pick one, record an ADR. | session model |
| `ui-quality-pass` | Use before saying any UI component, page, screen, step or dialog is done or fixed, including small tweaks and work a subagent did - tokens, semantics, keyboard, contrast, responsive, async states, copy. | session model |
| `verify-done` | Use before claiming a task is done, fixed, passing or ready for review, and when the owner says done, ship or merge. | session model |

## Agents (`home/agents/<name>.md`)

| Agent | Description (trigger) | Model |
| ----- | --------------------- | ----- |
| `architect` | Use for architecture, system/API design, trade-off decisions, ADRs and planning of non-trivial or cross-package work. Produces a compact spec for Sonnet to implement; never implements. Skip for small or obvious designs. | claude-opus-5-5 |
| `deep-debugger` | Use for hard bugs - when one honest fix attempt already failed, the failure is intermittent, spans packages, or the cause is unclear. Finds the root cause and proposes the minimal fix; does not rewrite code at length. | claude-opus-5-5 |
| `implementer` | Use to execute a clear spec or well-defined non-UI task - multi-file implementation, refactor, tests - when the main session should stay clean. For pages, components, layout or styling use `ui-implementer`. Takes a spec path or precise instructions and returns a short report. | sonnet |
| `ui-implementer` | Use instead of `implementer` for any UI work - pages, screens, steps, components, layout, styling, forms, dialogs (.tsx/.jsx/.vue/.css/.scss, MUI, Tailwind). Preloads the UI skills, implements the spec and runs the UI done-gate. Returns a short report. | sonnet |
| `reviewer` | Use after a change (including a DB migration) to review it for correctness, regressions, security and rule violations. Read-only; returns a prioritised, rule-id keyed findings list. | sonnet |
| `runner` | Use to run tests, lint, typecheck, build or any noisy command and get back only the verdict and failures. Keeps verbose output out of the main context. Does not edit files. | haiku |
| `scout` | Use for read-only lookups - find where something is defined or used, list files, read several files and summarise, check how a pattern is done. Cheap and fast; returns a short answer, never raw dumps. | haiku |
| `security-auditor` | Use to audit a diff or feature for security issues, especially auth, input handling, secrets, uploads and agent tools reading untrusted text. Read-only. | opus |
| `test-writer` | Use to write tests from a spec or acceptance criteria before or without reading the implementation, so tests do not confirm the code's own mistakes. | sonnet |
| `visual-qa` | Use to check a built UI against its Figma baseline and at several widths with ui-check (compare, responsive), optionally fixing failures. Returns a short verdict, never images. | sonnet |

Routing policy (which tier does what) is in `home/modes/_lead.md` (injected into the lead session by `mode.mjs`): the Opus session leads and delegates. `general-purpose` (no `model`) runs on Sonnet 5.5 via `env.CLAUDE_CODE_SUBAGENT_MODEL`; the built-in Explore agent gets `sonnet` and Plan (extra-high / ultra-high) `opus` from `agent-model-guard.mjs`, otherwise they run on the lead's model; precedence is the Agent call's `model`, then frontmatter, then that env var.
`architect`, `reviewer` and `security-auditor` have `memory: user` (notes in `~/.claude/agent-memory/<name>/`); `reviewer` and `security-auditor` stay read-only for project files through the `agent-memory-only.mjs` hook in their frontmatter.

## Rules (`home/rules/`, ids and checks)

| File | Applies to | Ids |
| ---- | ---------- | --- |
| `core.md` | always on | C1-C29 |
| `ui.md` | `**/*.css`, `**/*.scss`, `**/*.tsx`, `**/*.jsx`, `**/*.vue`, `**/*.html`, `**/styles/**`, `**/tokens/**` | U1-U12 |
| `frontend.md` | `**/*.tsx`, `**/components/**` | F1-F10 |
| `backend.md` | `**/server/**`, `**/api/**`, `**/*.service.ts`, `**/routes/**` | S1-S11, B1-B10 |
| `db.md` | `**/migrations/**`, `**/*.sql`, `**/schema.*`, `**/prisma/**` | D1-D7 |
| `infra.md` | `Dockerfile*`, `**/.github/**`, `**/*.tf`, `**/*.yml` | I1-I6 |
| `test.md` | `**/*.test.*`, `**/*.spec.*`, `**/e2e/**` | T1-T8 |

Rules are one line each (`id | rule | check`) and load when a matching file is in play.

## Standards (`home/standards/`, the longer reference the rules point to)

| File | Title (first line) |
| ---- | ------------------ |
| `backend.md` | Backend / API (B1-B10) |
| `db.md` | Database (D1-D7) |
| `docs.md` | Docs (X1-X4) |
| `figma.md` | Figma to code conversion (used by `figma-pixel-perfect`, checked by `ui-check`) |
| `frontend.md` | Frontend (F1-F10) |
| `infra.md` | Infra / DevOps (I1-I6) |
| `refactor.md` | Refactor (R1-R4) |
| `security.md` | Security (S1-S11) |
| `testing.md` | Testing (T1-T8) plus C11, C13 |
| `ui-a11y.md` | UI, UX, accessibility (U1-U12) |

## Hooks (`home/hooks/`, wired in `settings/base.json`)

| File | Event | What it does |
| ---- | ----- | ------------ |
| `pre-bash-guard.mjs` | PreToolUse(Bash) | Blocks nothing by itself: a rule hit (git `--no-verify`, force push incl. `+refspec`, `rm -rf` outside the project, disk wipes, hand-edited lockfiles, literal secrets, `git push`, `gh release`, `gh pr merge`, package publish, writes to production hosts from `~/.claude/private/prod-hosts`) opens a timed dialog: Allow by default, auto-allow after 180 s, Deny on click; no GUI falls back to the CLI prompt. Destructive hits say `DESTRUCTIVE:`. Logs decisions to `~/.claude/logs/guard.jsonl` and code files written through `sed -i`/heredocs for the typecheck gate. Anything it cannot parse is allowed. |
| `artifact-ask.mjs` | PreToolUse(Artifact) | Timed dialog (same rules) before an Artifact publish or delete. |
| `post-edit.mjs`, `typecheck-gate.mjs` | PostToolUse(Edit, Write, MultiEdit); Stop, SubagentStop (gate) | Runs the project's own format and lint scripts (only those present in the nearest `package.json`) on the edited file and logs the file for `typecheck-gate.mjs`. A script that targets the whole repo (`prettier --write .`, `eslint .`) is replaced by the tool's binary on the edited file. A lint failure about the file ends the run at once. Env `CLAUDE_TYPECHECK_AT=edit` also typechecks after every edit and turns the gate off; `CLAUDE_POST_EDIT_SKIP` (`all` or `format,lint,typecheck`) opts out per project. Silent on success; on failure prints at most 15 lines and exits 2. `typecheck-gate.mjs`: typechecks the files this agent edited once when it stops (the package's `typecheck` script; a plain `tsc` call runs incrementally with a shared tsbuildinfo). Errors in the edited files exit 2 so the agent fixes them; errors the user was already shown, a typecheck that cannot run (no diagnostic parses) and a timeout (140 s; names the unchecked files) only show a message to the user. |
| `skill-router.mjs` | UserPromptSubmit; PostToolUse(Edit, Write, MultiEdit) | Names the UI skills to invoke from prompt keywords (EN/FA; accessibility needs a UI phrase such as "keyboard navigation", "focus ring" or "aria-label", not a bare "keyboard"); on the first UI-file edit per session and agent (subagents too) reminds to load `responsive-ui`, `accessibility-build` and run `ui-quality-pass`. Ignores prompts that are harness events (`<task-notification`, `<system-reminder`); bare words such as "step", "style", "field", "fetch", "submit" or "page" do not fire a route (the UI route needs a UI noun such as "component", "button", "css" or "page layout"; the async route needs "loading state", "skeleton", "pagination" and the like). A session UI marker (set by a routed prompt or a UI-file edit, kept across compact) makes weak words ("style", "padding", "colors", "page header", FA "رنگ", "فونت") produce a one-line UI follow-up; no marker, no output. `ui-implementer` edits set the marker but get no reminder. Quiet with `CLAUDE_SKILL_ROUTER=off` or in a Gradle project without `package.json`. Never blocks. |
| `agent-memory-only.mjs` | PreToolUse(Write, Edit, MultiEdit, NotebookEdit), wired in the `reviewer` and `security-auditor` frontmatter | Allows writes only under `~/.claude/agent-memory/` and this session's scratchpad (`<tmp>/claude-<current uid>/<project>/<input session_id>/scratchpad/`, after realpath: `..`, symlinks out, other sessions and other uids are denied); denies everything else, including input it cannot read. |
| `agent-model-guard.mjs` | PreToolUse(Agent, Task) | In every mode, a call without `model` to general-purpose (or no `subagent_type`), `Explore` or another built-in that pins no model gets `sonnet`; in extra-high and ultra-high a `Plan` call without one gets `opus` (so none inherit the Opus / Fable lead). The per-call `model` outranks `CLAUDE_CODE_SUBAGENT_MODEL` unless `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` is set; returns `permissionDecision: allow` with the full `updatedInput`. Forks, the repo's own agents (they pin a model in frontmatter), plugin agents, an explicit model and unreadable input pass untouched. Never blocks. |
| `mode.mjs` | SessionStart; UserPromptExpansion (`/mode`); UserPromptSubmit | Setup modes (normal, medium, high, extra-high, ultra-high): injects `modes/_lead.md` and the active mode's playbook at start (plus a lead note when an extra-high / ultra-high session was not launched with `ccm <mode>` or its model does not match), records `/mode <m>` per session in `~/.claude/state/modes/` (pruned after 14 days); never writes settings files; one reminder line per prompt when the mode is not medium. Never blocks. |
| `agent-budget.mjs` | PostToolUse (all tools); SubagentStop | Enforces budgets the prompt only asked for. A subagent that reaches 100 tool calls gets "return a status now" (again every 10 calls). In the lead: one "15 Bash calls in a row: delegate the rest to runner/implementer" line after 15 Bash calls with no Agent/Task call between (an Agent/Task call resets the count), and a "use scout" warning when a Read result passes about 20k chars in ultra-high. On SubagentStop a final report over a cap the spawn prompt states (for example "report <= 250 words") is sent back once; no stated cap means no check. Fails open, prints only fixed text and numbers. |
| `final-reply-cap.mjs` | Stop | Blocks once when the lead's final reply is over the line or word cap named in the owner's last prompt ("final reply max 25 lines"; English and Persian). Only caps tied to the reply count, not rule quotes such as "files <=300 lines". Never blocks twice (`stop_hook_active`); any error exits 0. |
| `token-audit.mjs` | not a hook; run by the `token-audit` skill | Prints the approximate recurring token cost (bytes / 4) of the config visible from the current directory (`paths:` and `description:` read only from the leading frontmatter; folded `>`/`|` descriptions supported). |

`.githooks/pre-commit` (repo only): `gitleaks protect --staged --redact`; the installers set `core.hooksPath`.

## Modes (`home/modes/`, `home/bin/ccm`)

| Item | Purpose |
| ---- | ------- |
| `modes/_lead.md` | Lead-only rules (modes, model routing, delegation); printed by `mode.mjs` at SessionStart before the playbook |
| `modes/{normal,medium,high,extra-high,ultra-high}.md` | Playbooks injected by `mode.mjs` |
| `bin/ccm` | Launcher `ccm [mode] [claude args]`: sets `CLAUDE_MODE`, plus the lead flags for extra-high (`--model opus --effort max`) and ultra-high (`--model fable --effort high`); `CCM_LEAD_EFFORT=low|medium|high|xhigh|max` overrides the effort of those two; no settings; linked to `~/.local/bin/ccm` by `install.sh`; `CCM_DRY_RUN=1` prints the command |

See [modes.md](modes.md).

## Project notes (`home/project-notes/`)

Personal per-project layer, linked to `~/.claude/project-notes`. A project's git-ignored `CLAUDE.local.md` imports
`@~/.claude/project-notes/<project>.md`; the project's committed config never references it. Policy: "Project config
layers" in `home/CLAUDE.md`.

| Note | Project |
| ---- | ------- |
| `ice-web-app.md` | ice-web-app (Mac) |
| `bill-and-ben-platform.md` | bill-and-ben-platform (Mac) |
| `pejvak-frontend-nx-workspace.md` | pejvak-frontend-nx-workspace (PC) |
| `pejvak-frontend.md` | Pejvak_Frontend, SVN (PC) |

## Status line

`home/statusline.mjs`: model tier, effort, context size in tokens, cost, and 5h / 7d usage windows with reset times. The 5h estimate comes from `ccusage`, pinned to `ccusage@20.0.50` (`CCUSAGE_PACKAGE` in `statusline.mjs`) and refreshed in a detached process; a failed refresh never breaks the line.

## Tools (`home/tools/`)

| Tool | What it does |
| ---- | ------------ |
| `ui-check` | Node CLI: `figma-pull`, `compare`, `responsive`, `columns`. See `home/tools/ui-check/README.md` and `docs/figma-pixel-perfect.md`. Pages wait for network idle (max 5 s) and a 1.5 s settle before measuring. Dependencies: `odiff-bin`, `pngjs`; Playwright comes from the target project. |

System CLIs (`tools/Brewfile`, `tools/windows-tools.ps1`): jq, ripgrep, gitleaks, gh, volta.

## Plugins (`plugins/plugins.json`)

Enabled: `frontend-design@anthropic-plugin-directory`, `code-review-anthropics@anthropic-plugin-directory`, `context7@anthropic-plugin-directory`, `skill-creator@anthropic-plugin-directory`, `code-simplifier@anthropic-plugin-directory`, `playwright@anthropic-plugin-directory`, `claude-md-management@anthropic-plugin-directory`, `typescript-lsp@claude-plugins-official`, `claude-code-setup@anthropic-plugin-directory`, `figma@claude-plugins-official`, `chrome-devtools-mcp@claude-plugins-official`. Off globally, enabled per project in `.claude/settings.local.json` (`enabledPlugins`): `superdesign@anthropic-plugin-directory`, `miro@claude-plugins-official`.

Installed but disabled: `gitkraken-hooks@gitkraken` (its hooks add ~45 ms to every tool call; the GitKraken app works without it), `superpowers@anthropic-plugin-directory` (its "1% chance" skill rule fights the routing rules; ~2k tokens per turn), `github@anthropic-plugin-directory` (its MCP fails every start with 400; use the `gh` CLI), `kotlin-lsp@claude-plugins-official`, `code-modernization@anthropic-plugin-directory`, `swift-lsp@claude-plugins-official`, `clangd-lsp@claude-plugins-official`.

Marketplaces: `anthropic-plugin-directory`, `claude-plugins-official`, `gitkraken`.

## Settings keys (`settings/base.json`)

| Key | Value / purpose |
| --- | --------------- |
| `env.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY` | 1; removes survey prompts |
| `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` | 200000; auto-compacts there so long runs keep going without a costly context |
| `env.CLAUDE_CODE_SUBAGENT_MODEL` | `claude-sonnet-5-5`; model for agents that pin none |
| `permissions.allow` | WebSearch, WebFetch |
| `permissions.deny` | credentials files, `~/.ssh/**`, `~/.aws/**`, `*.pem`, `.npmrc` (Read and Bash patterns) |
| `autoContinueAtUsageLimit` | true; a run continues past a usage limit |
| `model` | `opus` (the session leads at effort high; see `home/modes/_lead.md`) |
| `hooks` | PreToolUse(Bash) -> `pre-bash-guard.mjs`; PreToolUse(Agent, Task) -> `agent-model-guard.mjs`; PreToolUse(Artifact) -> `artifact-ask.mjs`; UserPromptSubmit -> `skill-router.mjs`, `mode.mjs`; SessionStart -> `mode.mjs` (+ `skill-router.mjs` on "compact"); UserPromptExpansion -> `mode.mjs`; PostToolUse(Edit, Write, MultiEdit) -> `post-edit.mjs`, `skill-router.mjs`; PostToolUse(all) -> `agent-budget.mjs`; Stop -> `typecheck-gate.mjs`, `ask-gate.mjs`, `final-reply-cap.mjs`; SubagentStop -> `typecheck-gate.mjs`, `agent-budget.mjs` |
| `statusLine` | command: `statusline.mjs` |
| `enabledPlugins` | plugin id -> true/false (mirrors `plugins/plugins.json`) |
| `modelSettings` | effort per model: Opus 5.5 high, Sonnet 5.5 medium, Haiku 5.5 low |

OS files: `settings/macos.json` (Notification hook plays a sound), `settings/windows.json` (Notification hook beeps), `settings/linux.json` (empty).
`settings/local.json` (gitignored, per machine): see `local.json.example` (`skipDangerousModePermissionPrompt`); its `hooks`
are appended to the shared ones (e.g. the PC's Android incubator hook).

## Scripts (`scripts/`)

| Script | Purpose |
| ------ | ------- |
| `install.sh` / `install.ps1` | Link `home/*` into `~/.claude`, build `settings.json`, install ui-check dependencies, set the git hook path, install plugins. Flags: `--dry-run`, `--no-plugins`, `--no-tools`. |
| `merge-settings.jq` | The shared jq merge (deep merge, `hooks` appended per event) used by `install.sh` and `doctor.sh`; `install.ps1` mirrors it. |
| `doctor.sh` | Read-only report: links, settings drift, plugins, CLI tools, ui-check dependencies and Chromium. |
