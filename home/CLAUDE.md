# Global instructions (all projects)

Owner: Pejvak. Primary OS Windows 10 (PowerShell + Git Bash), also macOS/Linux. Node 22, pnpm. Reply in the language the
user writes in (Persian included, never default to English); keep prose short and plain. Do not narrate tool calls.

Lead rules (routing, delegation, modes) are injected at session start from ~/.claude/modes/_lead.md. Workers: follow
your agent file and the caller's prompt.

Setup modes: `normal`, `medium` (default), `high`, `extra-high`, `ultra-high`; start with `ccm <mode>`, switch with `/mode <m>`.

## Finish the run (no hard limits)

- No turn, step or attempt caps: agents have no `maxTurns`, rules set no retry counts. A run ends when the task is
  done and no decision is left unasked; the user's decisions are asked as they come up, not left for the end.
- Report sizes (`≤ N lines`) size the summary, not the work. When the detail matters, write it to a file and return
  the path.

## Quality gates (every mode)

- After a change, run the checks that cover it through `runner` (targeted tests, typecheck, lint) ONCE, after the last
  edit, not after each step. `verify-done` reuses that run when no file changed after it.
- Non-trivial change: `reviewer`. Risky change: also `security-auditor`. UI: `ui-quality-pass`. Then `verify-done`.

## Skill routing (UI)

Invoke these with the Skill tool before writing code, in every project; a `skill-router` hook names them per prompt.

- Any UI code: `accessibility-build` + `responsive-ui` while building; `ui-quality-pass` before saying done.
- Figma link/frame/node: `figma-pixel-perfect` first, then `visual-qa` for compare + responsive.
- Inputs/forms: `forms-validation`. Screens with server data: `async-ui-states`. Dates: `datetime-handling`.
- A project skill with the same purpose whose `paths:` match the files wins (e.g. `design-parity`).

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

- Search before reading (Grep tool or `rg`, Glob), read ranges (`offset`/`limit`) not whole files, and
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
- Pixel/visual bugs: read the code once and make the best fix; hand the compare-and-fix loop to `visual-qa` (it runs
  until it passes) instead of iterating screenshots and measurements on the main thread.
- Run checks through `runner` so logs stay out of context; start servers/browsers only when the task needs a
  real-app check.
- Owner decisions (scope, money, irreversible, credentials, real trade-offs): ask with AskUserQuestion the moment they
  come up while other work keeps running (see `ask-owner`). Technical choices: pick the default, say so in one line.
- Final answers: what changed and what was not run. No recap of the process.

## Working method (quality)

- Understand before editing: read the failing output or the code path in full; do not guess
  library APIs - check the installed version's docs (docs MCP if configured) when behaviour
  is version-sensitive.
- Fix root causes, not symptoms; never silence a check to make it pass.
- Say "verified" only for what you ran; never imply a check passed that was not run.
- Smallest change that solves the request: no new modules or refactors beyond the task, no docs beyond C26/C27, no
  memory/history/session notes unless asked (the review agents' own `memory: user` notes are the exception); new logic
  still ships with a test (C11). Diagnose by reading code before experimenting.

## Compact instructions

When compacting, keep: the user's goal and constraints, the user's language (reply in it, Persian included), decisions
made and why, files changed (paths), failing checks with the exact error, the `STATUS.md` path for multi-day work (re-read
it after compaction), and the next step. Drop exploration dead-ends, full file contents, and tool output already acted on.

## Safety

Look before deleting or overwriting. Confirm before outward-facing or hard-to-reverse
actions (push, publish, delete, send). A blanket allow ("do everything", bypass mode) never covers git push,
publish/release, PR merge, Artifact publish/delete, or writes and deletes on prod hosts: these always ask, and a guard
hook enforces it. Never print or commit secrets or `.env` contents; never put a literal password or token in a command
(use env vars or files).
