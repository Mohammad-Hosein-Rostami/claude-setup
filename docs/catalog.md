# Catalog

Everything this setup ships, read from the files in `home/`, `settings/`, `plugins/` and `tools/`. Skill and agent
descriptions are quoted from their frontmatter; those descriptions are what make them trigger.

## Skills (`home/skills/<name>/SKILL.md`)

| Skill | Description (trigger) | Model |
| ----- | --------------------- | ----- |
| `accessibility-build` | Use while writing or changing UI code (.tsx/.jsx/.vue/.html; MUI components, dialogs, menus, icon buttons, forms) so it is accessible from the start - semantic HTML, keyboard, focus, labels, contrast, motion (WCAG 2.2 AA). | session model |
| `ask-owner` | Use when a decision is the owner's (scope, money, irreversible or outward-facing actions, credentials, real trade-offs), or when an ASK line arrives from the decision queue - how to word the question and run the queue loop. | session model |
| `async-ui-states` | Use for any screen that loads or changes server data, or whose first screen depends on sign-in, role or saved progress - loading, empty, error, offline, stale responses, pagination, search-as-you-type, no wrong screen before a redirect. | session model |
| `clean-code` | Use when writing or changing code, and again before finishing a coding step - naming, size, complexity, errors, comments, duplication, dead code, scope. | session model |
| `datetime-handling` | Use whenever code stores, parses, compares, shows or schedules dates and times, in the UI or the backend - time zones, DST, date-only values, formats. | session model |
| `e2e-browser-test` | Use when writing or fixing end-to-end or browser tests, or when verifying a UI in a real browser. | session model |
| `escalate` | Send a hard design, architecture or stubborn-bug question to Opus 5.5 in an isolated fork and get a short decision. Not for implementation. | claude-opus-5-5 |
| `figma-pixel-perfect` | Use whenever a task has a Figma link, frame or node id, or says match the design / pixel perfect - pull the baseline, build, compare with ui-check, fix until it passes, then check responsive. | session model |
| `forms-validation` | Use when building or changing a form or any user input flow - validation, errors, autofill, double submit, optimistic UI. | session model |
| `frontend-performance` | Use when a page is slow, heavy or janky, or when adding images, fonts, libraries or routes - Core Web Vitals, bundles, rendering. | session model |
| `frontend-security` | Use when rendering user content, handling tokens, loading third-party scripts, or touching cookies, CORS or CSP in a web app. | session model |
| `mode` | Switch this session's setup mode: normal (fewest agents), medium (default, balanced), high (full speed), extra-high (lead Opus 5.5 at max) or ultra-high (lead Fable 5.2 at high). (manual only: slash command) | session model |
| `handoff` | Write a compact handoff note so work can continue in a fresh session after /clear. Use at a phase change, before /clear, or when the user says handoff or continue later. (manual only: slash command) | inherit |
| `quick` | Run a simple lookup or mechanical task on Haiku 5.5 in an isolated fork - find, list, read and summarise (read-only, no commands). | haiku |
| `git-linear-history` | Use before integrating a branch, pulling, or landing parallel lanes, and whenever the owner asks to clean up git - merge commits, tangled or leftover branches, old worktrees, a messy graph. History is one straight line - rebase, never merge. | session model |
| `repo-restructure` | Use when restructuring a whole repository - removing a build tool or layer (Nx, module federation, a monorepo tool), merging or moving apps and packages, deleting dead folders, scripts, plans or old configs, or rebuilding CI, Docker and deploy for a new layout. | session model |
| `responsive-ui` | Use when building or changing any page, screen, step or component layout (.tsx/.jsx/.vue/.css/.scss, MUI sx/styled, Tailwind), even a small UI tweak - mobile-first, breakpoints, container queries, touch targets, overflow at 320px, reflow. | session model |
| `root-cause-debug` | Use for a bug, failing or flaky test, red CI or unexpected behaviour, before proposing any fix. | session model |
| `safe-refactor` | Use when restructuring code without changing behaviour, including renames, extractions and moves. | session model |
| `tdd-loop` | Use when implementing a feature or bug fix with testable behaviour, including any new logic or branch. | session model |
| `tech-research` | Use when a design decision depends on external facts you lack - service limits, versions, pricing, standards, known failure modes. Search the web and cite. For library API docs use context7. | session model |
| `token-audit` | Audit where tokens go in this project's Claude setup - instruction files, rules, skills, agents, MCP servers - and propose concrete cuts. Use periodically or when sessions feel expensive. (manual only: slash command) | sonnet |
| `tradeoff-analysis` | Use when a design choice has two or more credible options (datastore, queue, sync vs async, build vs buy) - compare them, pick one, record an ADR. | session model |
| `ui-quality-pass` | Use before saying any UI component, page, screen, step or dialog is done or fixed, including small tweaks and work a subagent did - tokens, semantics, keyboard, contrast, responsive, async states, copy. | session model |
| `ui-coverage` | Use for any UI task with more than one component and for Figma or pixel-perfect work - build a coverage matrix (surfaces including backend-rendered UI, control reuse, states, locales and direction, reference behaviour, live review page) and gate done on `ui-coverage check`. The matrix is made before the first UI lane and every `ui-implementer` / `visual-qa` brief names it in a `MATRIX: <path>` line (`agent-model-guard.mjs` sends a brief without one back once); a Figma difference is kept only with the owner's own decision as its reference. | session model |
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

Routing policy (which tier does what) is in `home/modes/_lead.md` (injected into the lead session by `mode.mjs`): the Opus session leads and delegates. `general-purpose` (no `model`) runs on Sonnet 5.5 via `env.CLAUDE_CODE_SUBAGENT_MODEL`; the built-in Explore agent gets `sonnet` and Plan (every mode) `opus` from `agent-model-guard.mjs`, otherwise they run on the lead's model; precedence is the Agent call's `model`, then frontmatter, then that env var.
`architect`, `reviewer` and `security-auditor` have `memory: user` (notes in `~/.claude/agent-memory/<name>/`); `reviewer` and `security-auditor` stay read-only for project files through the `agent-memory-only.mjs` hook in their frontmatter.

## Rules (`home/rules/`, ids and checks)

| File | Applies to | Ids |
| ---- | ---------- | --- |
| `core.md` | always on | C1-C37 (C37: linear git history, rebase and `--ff-only`, checked by `git-tidy`) |
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
| `readability.md` | Readability for humans (C31-C36) |
| `refactor.md` | Refactor (R1-R4) |
| `security.md` | Security (S1-S11) |
| `testing.md` | Testing (T1-T8) plus C11, C13 |
| `ui-a11y.md` | UI, UX, accessibility (U1-U12) |

## Hooks (`home/hooks/`, wired in `settings/base.json`)

| File | Event | What it does |
| ---- | ----- | ------------ |
| `pre-bash-guard.mjs` | PreToolUse(Bash) | Blocks nothing for good. A command with a hit that a rewrite fixes (a variable command word, a risky word inside shell expansion, a literal secret) is first bounced back once with the fix (a deny the agent reads, outcome `bounce`); the bounce also names every other reason that will still ask after the rewrite, and the identical command sent again gets the dialog. Otherwise a rule hit (git `--no-verify`, force push incl. `+refspec`, `rm -rf` outside the project, disk wipes, literal secrets, `git push`, `gh release`, `gh pr merge`, package publish, writes to production hosts from `~/.claude/private/prod-hosts`) opens a timed dialog: Allow by default, no answer in 180 s (max 190) goes ahead, Deny on click; Allow and timeout print no decision (normal permission flow and deny rules still apply); no GUI or a failed dialog falls back to the CLI prompt. Quality rules (a hand-edited lockfile, a `git merge` or `git pull` that can create a merge commit) get advice instead: denied once with the fix, the identical command sent again runs, no dialog. Every git global option is read, so none can hide a guarded subcommand. Commands git itself runs (`lib/git-runs.mjs`: `rebase -x`, `bisect run`, `submodule foreach`, `-c core.pager=`, clone's `-c`, `git config` writes, `alias.*`, `GIT_SSH_COMMAND` and the other variables git runs, `ext::` and `git remote-ext`) get the same rules as a `bash -c` body; what git runs that the guard cannot read asks "git runs a command this guard cannot read" (a `--config-env` variable not set in the line, `ext::` switched on, and, next to a dangerous word, config files or values set through `printf -v` or other variables). Git's own programs (`git-push`, `<exec path>/git-rebase`) count as `git <sub>`, `git config` values after `--` are read, and the value of a variable git runs is checked wherever the line assigns it (`lib/git-run-values.mjs`; one it cannot read, such as `$(...)`, asks the same unless it is one reference like `"$EDITOR"`). Command names ignore case on macOS and Windows, as their file systems do; a variable assigned from a backtick is unknown, as after `$(...)`. Destructive hits say `DESTRUCTIVE:`. Logs decisions to `~/.claude/logs/guard.jsonl` and code files written through `sed -i`/heredocs for the typecheck gate. Scans every word of a command for these rules (so `ionice -c3 rm -rf /x` and `$'\x72m'` are caught); `eval` of a variable or substitution asks. A second character-level parser (`lib/shell-lexer.mjs`) is a raw-text backstop, and a fail-to-ask rule (`lib/raw-risk.mjs`) asks whenever a hidden-execution construct (`$(`, backtick, `<<`, `<(`, `eval`, `trap`, `case`) meets a dangerous word anywhere in the raw text (known false positive: a commit message `"$(cat <<'EOF' ... git push ... EOF)"`); a command over 32 KB asks "command too long to check"; `| bash`, `bash <<EOF`, a variable command word, `env -S`, `su -c`, `git -c alias.*`, `gh api` writes and `diskutil erase` ask. Anything it cannot parse is allowed. |
| `artifact-ask.mjs` | PreToolUse(Artifact) | Timed dialog (same rules) before an Artifact publish or delete. |
| `post-edit.mjs`, `typecheck-gate.mjs` | PostToolUse(Edit, Write, MultiEdit); Stop, SubagentStop (gate) | Runs the project's own format and lint scripts (only those present in the nearest `package.json`) on the edited file and logs the file for `typecheck-gate.mjs`. A script that targets the whole repo (`prettier --write .`, `eslint .`) is replaced by the tool's binary on the edited file. A lint failure about the file ends the run at once. Env `CLAUDE_TYPECHECK_AT=edit` also typechecks after every edit and turns the gate off; `CLAUDE_POST_EDIT_SKIP` (`all` or `format,lint,typecheck`) opts out per project. Silent on success; on failure prints at most 15 lines and exits 2. `typecheck-gate.mjs`: typechecks the files this agent edited once when it stops (the package's `typecheck` script; a plain `tsc` call runs incrementally with a shared tsbuildinfo). Errors in the edited files exit 2 so the agent fixes them; errors the user was already shown, a typecheck that cannot run (no diagnostic parses) and a timeout (140 s; names the unchecked files) only show a message to the user. |
| `skill-router.mjs` | UserPromptSubmit; PostToolUse(Edit, Write, MultiEdit) | Names the UI skills to invoke from prompt keywords (EN/FA; accessibility needs a UI phrase such as "keyboard navigation", "focus ring" or "aria-label", not a bare "keyboard"); on the first UI-file edit per session and agent (subagents too) reminds to load `responsive-ui`, `accessibility-build` and run `ui-quality-pass`. Routes only the owner's own words: `<cross-session-message>`, `<task-notification>` and `<system-reminder>` blocks are cut out first (an unclosed one runs to the end of the prompt), and an `<agent-message` or SYSTEM NOTIFICATION prompt routes nothing; bare words such as "step", "style", "field", "fetch", "submit" or "page" do not fire a route (the UI route needs a UI noun such as "component", "button", "css" or "page layout"; the async route needs "loading state", "skeleton", "pagination" and the like). A session UI marker (set by a routed prompt or a UI-file edit, kept across compact) makes weak words ("style", "padding", "colors", "page header", FA "رنگ", "فونت") produce a one-line UI follow-up; no marker, no output. `ui-implementer` edits set the marker but get no reminder. Quiet with `CLAUDE_SKILL_ROUTER=off` or in a Gradle project without `package.json`. Gate lines (once per session, again after a compact): a bug names `root-cause-debug`, done or ship names `verify-done`, a repository-level restructure ("remove Nx", "migrate away from turborepo", "merge the apps into one project", FA "تغییر ساختار پروژه"; not "restructure this function") names `repo-restructure`, git history or branch work ("clean up the git tree", "rebase", "delete the merged branches", "merge everything to master", FA "تاریخچه گیت"; not "merge conflicts", "merge sort" or "branch coverage") names `git-linear-history`. One more gate line names no skill and shows on every match, not once per session: a repeated report ("still wrong", "still not fixed", "same problem again", "i told you before", "this is the third time", FA "هنوز درست نشده") says the last fix did not hold, reproduce the symptom first; not "run it again", "is it still running" or "a still image". Never blocks. |
| `agent-memory-only.mjs` | PreToolUse(Write, Edit, MultiEdit, NotebookEdit), wired in the `reviewer` and `security-auditor` frontmatter | Allows writes only under `~/.claude/agent-memory/` and this session's scratchpad (`<tmp>/claude-<current uid>/<project>/<input session_id>/scratchpad/`, after realpath: `..`, symlinks out, other sessions and other uids are denied); denies everything else, including input it cannot read. |
| `agent-model-guard.mjs` | PreToolUse(Agent, Task) | In every mode, a call without `model` to general-purpose (or no `subagent_type`), `Explore` or another built-in that pins no model gets `sonnet`; in every mode a `Plan` call without one gets `opus` (so none inherit the Opus / Fable lead). The per-call `model` outranks `CLAUDE_CODE_SUBAGENT_MODEL` unless `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` is set; returns `permissionDecision: allow` with the full `updatedInput`. Forks, the repo's own agents (they pin a model in frontmatter), plugin agents, an explicit model and unreadable input pass untouched; the routing never blocks. UI brief gate: a `ui-implementer` or `visual-qa` call is denied once with the `ui-coverage init` advice unless its prompt has a line starting with `MATRIX: <path>` (a JSON object with a `surfaces` array; relative to the call's cwd, `~` expanded; read only as a regular file up to 16 MB, never a UNC or device path) or `MATRIX: none: <reason>` (15+ characters); the identical call sent again runs (`lib/bounce-once.mjs` adviceOnce, logged `advice`, `advice-retry` or `advice-unrecorded`); never the owner, and any failure lets the call run. |
| `mode.mjs` | SessionStart; UserPromptExpansion (`/mode`); UserPromptSubmit | Setup modes (normal, medium, high, extra-high, ultra-high): injects `modes/_lead.md` and the active mode's playbook at start (plus a lead note when an extra-high / ultra-high session was not launched with `ccm <mode>` or its model does not match), records `/mode <m>` per session in `~/.claude/state/modes/` (pruned after 14 days); never writes settings files; one reminder line per prompt when the mode is not medium. Never blocks. |
| `agent-budget.mjs` | PostToolUse (all tools); SubagentStop | Enforces budgets the prompt only asked for. A subagent gets "commit what is green" once at 80 tool calls, and "commit, then return your status report" at 120 (again every 10 calls); advisory, it never blocks a call. In the lead: one "15 Bash calls in a row: delegate the rest to runner/implementer" line after 15 Bash calls with no Agent/Task call between (an Agent/Task call resets the count), and a "use scout" warning when a Read result passes about 20k chars in ultra-high. On SubagentStop a final report over a cap the spawn prompt states (for example "report <= 250 words") is sent back once; no stated cap means no check. Fails open, prints only fixed text and numbers. |
| `checkpoint.mjs` | PostToolUse (all tools); PreCompact | Starts a live session checkpoint (Haiku notes of the new transcript tail, stored in the recall DB) in a detached job once the transcript grew by about 40k tokens, and on PreCompact for the remaining tail. Main session only (a subagent is skipped); one job per session. Never blocks or prints; every error exits 0. |
| `recall-digest.mjs` | SessionStart(compact) | After a compaction prints a digest of this session's checkpoint notes (at most 6000 chars, newest first) plus the `recall "<query>" --session current` line; waits up to 8 s for a running checkpoint job. Prints nothing without notes; never fails the session start. |
| `test-files-only.mjs` | PreToolUse(Write, Edit, MultiEdit), wired in the `test-writer` frontmatter | Allows writes only to test files (`*.test.*`, `*.spec.*`, test directories, `conftest.py` and similar) and denies the rest; `node_modules` paths and unreadable input are denied (exit 2 + reason). |
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

`home/statusline.mjs`: model tier, effort, context size in tokens, cost, the finish time of the project's `STATUS.md` job (`done ~14:50-16:15`, read from a cache that `home/tools/estimate/statusline-cache.mjs` refreshes in a detached process; no segment when there is no STATUS.md, the estimate tool refuses or the job is delivered), and 5h / 7d usage windows with reset times. The 5h estimate comes from `ccusage`, pinned to `ccusage@20.0.50` (`CCUSAGE_PACKAGE` in `statusline.mjs`) and refreshed in a detached process; a failed refresh never breaks the line.

## Tools (`home/tools/`)

| Tool | What it does |
| ---- | ------------ |
| `ui-check` | Node CLI: `figma-pull`, `figma-frames` (lists the frames under Figma nodes into a frames file for `ui-coverage`), `compare`, `responsive`, `columns`, `batch` (many states in one run, writes `results.json`; each record has `part` compare or responsive, a pixel finding has `percent`). Flags added: `--locale`, `--expect-dir`, `--color-scheme`, `--storage`, `--cookie`; `responsive` also reports the `bidi-field` finding (judged on the filled state: only the typed value is left-to-right), the `bidi-placeholder` finding (a translated placeholder rendered left-to-right), and the hints `bidi-field?` (empty-field probe), `bidi-placeholder?`, `ltr-run-in-rtl?`, `untranslated?` (one row; reads placeholders, aria-label, title, alt) (`--same-in-all-locales`) and, in `batch`, `same-as-default?` (`sameInAllLocales`). See `home/tools/ui-check/README.md` and `docs/figma-pixel-perfect.md`. Pages wait for network idle (max 5 s) and a 1.5 s settle before measuring. Dependencies: `odiff-bin`, `pngjs`; Playwright comes from the target project. |
| `ui-coverage` | Node CLI for the `ui-coverage` skill: `init` writes a skeleton matrix with TODO placeholders (refuses to overwrite); `expand` adds a `todo` cell for every missing surface x state x locale (and width) in a matrix file; `scaffold` writes the `ui-check batch` states skeleton for the open cells (names agree with the matrix by construction); `init --frames` and `expand` take a Figma frames file, and `check` then fails a frame that is unlisted, unmapped or has no compare record (and prints a `frames:` line); a failing Figma compare is accepted only with an `accepted` entry whose owner ref is a real owner answer (an `ask.mjs answer --default` timeout does not count); `check` validates it (a control's `component` must be proven by `mountedAt`, a `none:` reference by `searched.reference`), merges `ui-check batch` results, prints the verdict first with problems grouped by root cause (`--verbose` for all) and exits 1 naming each uncovered or failing cell. See `home/tools/ui-coverage/README.md`. |
| `recall` | Node CLI: `node ~/.claude/tools/recall/recall.mjs "<terms>" [--session current]` searches past sessions and notes; `--owner [--session current|<id>] [--since YYYY-MM-DD]` lists the owner's own typed messages of one session, oldest first, one quoted, masked line each (first 300 characters; a sensitive listing: read it, do not paste it into project files), for the `## Standing rules` backfill. Details: `home/tools/recall/README.md`. |
| `estimate` | Node CLI: `node ~/.claude/tools/estimate/estimate.mjs STATUS.md` turns the `## Work items` table of a STATUS.md (size S/M/L, started, done, evidence; item prefix `close:`, `rework:` or `deliver:` sets the row kind; `deliver:` rows, done alone, mark deliveries when nothing else is running, else a 10-minute pause after a `close:` row is taken for one and the output says so) and the project's transcripts into `Finish:`, the local clock range when the whole job is finished: the open build rows (running time subtracted, never shorter than the longest row), then the closing phase (review, fix rounds, recheck, landing; the default 1.4-2.5 h, since a table has one first cycle), in series; rows started after a delivery are a follow-up round (default 0.4-2.6 h from its first start, never before the open rows' sizes); usage-limit windows are subtracted. It prints what is included and excluded and how often earlier deliveries were reopened; it refuses (exit 3, `No finish time:` and `What to do:`) when fewer than 5 done items are measured, a done row has no started, a time is later than now, a rate would be zero, or the closing has already run longer than every closing measured, and exits 2 on anything in the table it cannot read. Each new printed range is logged (ids, started times and numbers only, `~/.claude/state/estimate-log/`, `--log-dir`; a repeat of the last one is not), scored at its delivery while its rows are unchanged, and shown per phase (first cycles, follow-up rounds) as a `Track record` line; from 5 scored estimates the last 10 widen the range (target 8 of 10 inside). `home/tools/estimate/statusline-cache.mjs` feeds the status line's `done ~` segment from the same lib and only reads the log. See `home/tools/estimate/README.md`. |
| `readable` | Node CLI for the human-first rules: `node ~/.claude/tools/readable/readable.mjs check <dir> [--changed [--base <ref>]]` reports a folder with 3+ source files and no README, dumping-ground names (`misc`, `utils`, `data` ...), nesting deeper than 5 folders, a source file with no header comment, and uncommented keys in yaml, toml, ini and example-env files. With `--changed` only what the change added; whole-tree mode is an audit. Skips `.gitignore`d, lock, generated and locale files and framework layouts (Maven packages, Next.js routes, Rails helpers). Allow-list with a reason per entry in `.claude/readable.local.json` or `.readable.json`. Exit 0 clean, 1 findings, 2 usage, 3 crash. See `home/tools/readable/README.md`. |
| `refs` | Node CLI: `node ~/.claude/tools/refs/refs.mjs check [dir] [--json] [--no-hints]` reports config entries, Docker and CI paths and doc links that point at paths which do not exist. Used by the `repo-restructure` skill after every batch. |
| `env-names` | Node CLI: `node ~/.claude/tools/env-names/env-names.mjs list [dir] --save <file>` saves the env variable names a project uses; `diff <file> [dir]` compares the project against a saved list by name. Values are never read. YAML deploy files are read with the `yaml` package (the one dependency, installed by `install.sh`). Used by the `repo-restructure` skill. |
| `watch` | Node CLI: `node ~/.claude/tools/watch/watch.mjs <session-id>` follows a live session and prints action-only lines (owner prompts, compactions, errors, usage limits, guard denies and timeouts) plus a STALL alert when nothing is written for `--stall-min` minutes (default 20; an IDLE line instead when the session finished its turn and waits for its owner, opt-in as the `idle` class); API errors and limit windows are events too (`API_ERROR`, `LIMIT`, `LIMIT_RESET`). Run it under Monitor from a second session, or with `--exit-on-event [classes]` as a background Bash command that prints the first event that needs you and exits (also on a dead session or a stalled transcript; `--delay-sec`, `--skip` for a self-watch). See `home/tools/watch/README.md`. |
| `git-tidy` | Node CLI: `node ~/.claude/tools/git-tidy/git-tidy.mjs check [dir] [--base b]` reports unpublished merge commits and merged branches and worktrees (exit 0 when none); `prune [--apply]` lists, and with `--apply` removes, what is provably merged (never a dirty worktree or a branch with work of its own). Used by the `git-linear-history` skill. |

System CLIs (`tools/Brewfile`, `tools/windows-tools.ps1`): jq, ripgrep, gitleaks, gh, volta.

## Plugins (`plugins/plugins.json`)

Enabled: `frontend-design@anthropic-plugin-directory`, `code-review-anthropics@anthropic-plugin-directory`, `context7@anthropic-plugin-directory`, `skill-creator@anthropic-plugin-directory`, `code-simplifier@anthropic-plugin-directory`, `playwright@anthropic-plugin-directory`, `claude-md-management@anthropic-plugin-directory`, `typescript-lsp@claude-plugins-official`, `claude-code-setup@anthropic-plugin-directory`, `figma@claude-plugins-official`, `chrome-devtools-mcp@claude-plugins-official`. Off globally, enabled per project in `.claude/settings.local.json` (`enabledPlugins`): `superdesign@anthropic-plugin-directory`, `miro@claude-plugins-official`.

Installed but disabled: `gitkraken-hooks@gitkraken` (its hooks add ~45 ms to every tool call; the GitKraken app works without it), `superpowers@anthropic-plugin-directory` (its "1% chance" skill rule fights the routing rules; ~2k tokens per turn), `github@anthropic-plugin-directory` (its MCP fails every start with 400; use the `gh` CLI), `kotlin-lsp@claude-plugins-official`, `code-modernization@anthropic-plugin-directory`, `swift-lsp@claude-plugins-official`, `clangd-lsp@claude-plugins-official`.

Marketplaces: `anthropic-plugin-directory`, `claude-plugins-official`, `gitkraken`.

## Settings keys (`settings/base.json`)

| Key | Value / purpose |
| --- | --------------- |
| `env.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY` | 1; removes survey prompts |
| `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` | 400000 (models have 1M); fewer compactions, less forgetting; owner traded per-turn cost for it |
| `env.CLAUDE_CODE_SUBAGENT_MODEL` | `claude-sonnet-5-5`; model for agents that pin none |
| `permissions.allow` | WebSearch, WebFetch |
| `permissions.deny` | credentials files, `~/.ssh/**`, `~/.aws/**`, `*.pem`, `.npmrc` (Read and Bash patterns) |
| `autoContinueAtUsageLimit` | true; a run continues past a usage limit |
| `model` | `opus` (the session leads at effort high; see `home/modes/_lead.md`) |
| `hooks` | PreToolUse(Bash) -> `pre-bash-guard.mjs`; PreToolUse(Agent, Task) -> `agent-model-guard.mjs`; PreToolUse(Artifact) -> `artifact-ask.mjs`; UserPromptSubmit -> `skill-router.mjs`, `mode.mjs`; SessionStart -> `mode.mjs` (+ `skill-router.mjs`, `recall-digest.mjs` on "compact"); UserPromptExpansion -> `mode.mjs`; PostToolUse(Edit, Write, MultiEdit) -> `post-edit.mjs`, `skill-router.mjs`; PostToolUse(all) -> `agent-budget.mjs`, `checkpoint.mjs`; PreCompact -> `checkpoint.mjs`; Stop -> `typecheck-gate.mjs`, `ask-gate.mjs`, `final-reply-cap.mjs`; SubagentStop -> `typecheck-gate.mjs`, `agent-budget.mjs` |
| `statusLine` | command: `statusline.mjs` |
| `enabledPlugins` | plugin id -> true/false (mirrors `plugins/plugins.json`) |
| `modelSettings` | effort per model: Opus 5.5 high, Sonnet 5.5 medium, Haiku 5.5 low |

OS files: `settings/macos.json` (Notification hook plays a sound), `settings/windows.json` (Notification hook beeps), `settings/linux.json` (empty).
`settings/local.json` (gitignored, per machine): see `local.json.example` (`skipDangerousModePermissionPrompt`); its `hooks`
are appended to the shared ones (e.g. the PC's Android incubator hook).

## Scripts (`scripts/`)

| Script | Purpose |
| ------ | ------- |
| `install.sh` / `install.ps1` | Link `home/*` into `~/.claude`, build `settings.json`, install ui-check and env-names dependencies, set the git hook path, install plugins. Flags: `--dry-run`, `--no-plugins`, `--no-tools`. |
| `merge-settings.jq` | The shared jq merge (deep merge, `hooks` appended per event) used by `install.sh` and `doctor.sh`; `install.ps1` mirrors it. |
| `lane-new.sh` | `lane-new.sh <name> [base]`: new worktree `../claude-setup-wt/<name>` on branch `lane/<name>` (refuses an existing branch or folder), then `npm ci` in the tools `install.sh` lists in `TOOLS_WITH_DEPS`; prints the path. |
| `doctor.sh` | Read-only report: links, settings drift, plugins, CLI tools, ui-check and env-names dependencies and Chromium. |
