# Global instructions (all projects)

Owner: Pejvak. Primary OS Windows 10 (PowerShell + Git Bash), also macOS/Linux. Node 22, pnpm. Reply in the language the
user writes in; keep prose short and plain. Do not narrate tool calls.

## Model routing (cost policy)

The session model cannot change itself mid-session; routing happens through **subagents,
skills and plan mode**, each of which pins its own model. Default session model is
`opusplan` (Opus in plan mode, Sonnet 5.5 everywhere else).

| Work | Model | How |
| ---- | ----- | --- |
| Architecture, API/system design, trade-off decisions, ADRs, root-cause of a bug that survived one failed fix | **Opus 5.5** | `architect` / `deep-debugger` agent, or `/escalate`, or plan mode |
| Implementation, refactors, tests, normal bug fixes, small designs, reviews | **Sonnet 5.5** | main session, or `implementer` / `reviewer` agent |
| Searching, listing, reading many files, running tests/lint/build, log triage, summarising, formatting, trivial edits | **Haiku 5.5** | `scout` / `runner` agent, or `/quick` |
| UI implementation (pages, screens, steps, components, layout, styling, forms) | **Sonnet 5.5** | main session with UI skills, or `ui-implementer` agent (never plain `implementer`) |
| Figma match and responsive checks (compare, fix loop; returns text only, no images) | **Sonnet 5.5** | `visual-qa` agent, skill `figma-pixel-perfect` |

Rules:

1. Never stay on Opus for a long implementation. Opus produces a **spec** (decision, files,
   steps, acceptance checks, ≤ 60 lines); Sonnet executes it. Do not paste the spec into
   chat twice: hand it over by file path.
2. Escalate to Opus only when: the design has ≥ 2 credible options with real trade-offs, it
   crosses package/ownership boundaries, or a bug resisted one honest fix attempt. Otherwise
   stay on Sonnet — most "design" is not hard.
3. Downshift to Haiku for anything mechanical. If the result is a lookup, a log, or a file
   list, a Haiku agent returns the answer; the main context never sees the raw output.
4. If unsure which tier, pick the cheaper one and escalate on failure — not the reverse.

## Skill routing (UI)

Invoke these with the Skill tool before writing code, in every project; a `skill-router` hook names them per prompt.

- Any UI code: `accessibility-build` + `responsive-ui` while building; `ui-quality-pass` before saying done.
- Figma link/frame/node: `figma-pixel-perfect` first, then `visual-qa` for compare + responsive.
- Inputs/forms: `forms-validation`. Screens with server data: `async-ui-states`. Dates: `datetime-handling`.
- A project skill with the same purpose whose `paths:` match the files wins (e.g. `design-parity`).
- When delegating UI work, use `ui-implementer` (it preloads the UI skills); a subagent never inherits skills
  you loaded. A project's own `ui-implementer` shadows it: name the UI skills in the delegation prompt.

## Project config layers

Projects are shared with a team; this personal setup is not. Keep three layers apart:

1. **Personal (this repo, `~/.claude`)**: global skills, agents, hooks, rules. Never copied into a project.
2. **Team (committed in the project)**: CLAUDE.md, AGENTS.md, `.claude/{settings.json,agents,skills,rules}`.
   Complete on its own: it names only agents, skills, hooks and commands that exist in the repo, and never
   mentions `~/.claude`, my global skills/agents or paths on my machines. If a team workflow needs an agent,
   the project ships its own copy.
3. **Personal per project (never committed)**: `CLAUDE.local.md` containing only
   `@~/.claude/project-notes/<project>.md` (notes live in this repo), `.claude/settings.local.json` (plugins,
   personal permissions), symlinks hidden via `.git/info/exclude`. Make sure the project ignores these first.

When asked to set up or improve a project's AI config, edit layer 2 for what the team needs and layer 3 for how my
global setup combines with it.

## Token discipline

- Search before reading (Grep/Glob), read ranges (`offset`/`limit`) not whole files, and
  never re-read a file you just edited.
- Delegate anything that would dump > ~150 lines (test logs, build output, big greps, docs
  crawling) to a `runner` / `scout` agent and ask for a summary of ≤ 20 lines.
- **Cost = tool calls × context size.** Every tool call re-reads the whole conversation, so
  at 500k context one call costs ~30× a call in a fresh session. Therefore: batch (several
  reads/greps/commands in ONE call or one script), stop at the first sufficient answer, and
  never loop measure→adjust→measure on the main thread.
- If context is above ~100k (statusline `ctx`), delegate any investigation needing more than
  ~4 calls to a subagent (`scout` / general-purpose: fresh small context) and use its summary.
- One task per session. Unrelated next task → tell the user to `/clear` (or start a new
  session) *before* starting it. Long task → `/compact` at a natural seam.
- Parallelise independent tool calls in one turn. Prefer CLI (`gh`, `pnpm`) over MCP tools;
  browser/Playwright MCP only when asked (each call also echoes its code back).
- Pixel/visual bugs: read the code once, make the best single fix or report the finding and
  ask - do not iterate screenshots and measurements unprompted.
- Never run tests, typecheck, lint, build or format checks unless the user asks or flags it.
  Do not start servers/browsers or build throwaway pages unless asked.
- Ask the user only when blocked on a decision that is theirs; otherwise pick the sensible
  default, say so in one line, and continue.
- Final answers: what changed and what was not run. No recap of the process.

## Working method (quality)

- Understand before editing: read the failing output or the code path in full; do not guess
  library APIs - check the installed version's docs (docs MCP if configured) when behaviour
  is version-sensitive.
- Fix root causes, not symptoms; never silence a check to make it pass.
- Say "verified" only for what you ran; never imply a check passed that was not run.
- Smallest change that solves the request: no new modules, refactors, tests, docs, or memory/
  history/session notes unless asked. Diagnose by reading code before experimenting.
- A new unrelated task in a long session: suggest `/clear` instead of dragging the context.
- Stop and ask only for decisions that are the user's; otherwise choose, state it in a line,
  and continue to done.

## Compact instructions

When compacting, keep: the user's goal and constraints, decisions made and why, files
changed (paths), failing checks with the exact error, and the next step. Drop exploration
dead-ends, full file contents, and tool output already acted on.

## Safety

Look before deleting or overwriting. Confirm before outward-facing or hard-to-reverse
actions (push, publish, delete, send). Never print or commit secrets or `.env` contents.
