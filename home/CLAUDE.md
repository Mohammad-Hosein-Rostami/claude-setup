# Global instructions (all projects)

Owner: Pejvak. MacBook and PC on macOS (zsh); a Windows machine (PowerShell + Git Bash) and Linux are tested. Node 22, pnpm. Reply in the language the
user writes in (Persian included, never default to English); keep prose short and plain. Do not narrate tool calls.

The main session also gets the lead rules at session start (`~/.claude/modes/_lead.md` and `~/.claude/lead.md`). Workers: follow your
agent file and the caller's prompt.

## Finish the run (no hard limits)

- No turn, step or attempt caps: agents have no `maxTurns`, rules set no retry counts. A run ends when the task is
  done and no decision is left unasked; the user's decisions are asked as they come up, not left for the end.
- Report sizes (`≤ N lines`) size the summary, not the work. When the detail matters, write it to a file and return
  the path.
- At a usage limit: read the reset time from the message, tell the owner that time, and never retry before the reset (a retry only
  spends the wait). Interactive sessions and workflows continue by themselves after a reset within 24 h (sessions at most 3 times,
  workflows twice); schedule one wake a few minutes after the reset only where that does not reach: a weekly reset over 24 h, after
  an exit, `-p` and background runs, or once those continuations are spent (a wake over 1 h is a scheduled task, not ScheduleWakeup).
- Subscription only: never `/fast`, `/code-review ultra` or usage credits, since they bill beyond the plan. Usage credits are off on
  every account (owner, 2026-11-19); a headless run names a non-Fable model, since a `-p` run on Fable would bill them.
- Work with a `STATUS.md`: every owner request and every owner correction becomes `## Work items` rows (`id | item | size S/M/L | started | done | evidence`) before work on it starts: list the whole job first, review, fixes and landing rows (`close:`) included; a correction's item starts `rework:`; a step found later is a new row at once; never fold steps into one row, never clear a done cell. Row edits go through `node ~/.claude/tools/status/status.mjs add|start|done|deliver|rule|decision` only, never a typed time: `start` when work on a row begins, `done` with its evidence when it ends. A hand-over is recorded by itself when your turn ends with no open row; `deliver "<what>"` records one while rows stay open. Every estimate you give is the `Finish:` block of `node ~/.claude/tools/estimate/estimate.mjs STATUS.md` pasted as-is, never a number or clock time of your own; the tool keeps one time and says why when it moves; if it refuses, give its reason, and do its What to do and any `Check:` line first.

## Quality gates (every mode)

- After a change, run the checks that cover it through `runner` (targeted tests, typecheck, lint) once, after the last
  edit, not after each step. `verify-done` reuses that run when no file changed after it.
- Reviews: the set `review-tier` prints runs as agents or the `wf-review` workflow (Inline, agent or workflow; `reviewer`, plus `security-auditor` and Opus lenses by class; risky, `gate` and hooks changes keep Opus max before land and every landing review keeps it, except a waived lane; reviewers keep their own loops and mutants); every fix delta goes back through `review-tier`: a lane's first review reads the whole range, never a delta, and a fix round's re-review is the delta brief of `node ~/.claude/tools/review-tier/review-tier.mjs --delta <reviewed-sha> --base <base-sha> --prior <findings-file> --prior-sha256 <its-sha256> --lane-classes <classes>` (both shas are full 40-character shas from the lead's own record of the last round, never from the writer's report and never a short sha or a name: the `fix round:` line that round printed carries them and the classes; after a rebase the base is the tip the lane was rebased onto; each findings file is one review report of that round as its reviewer wrote it, passed with its own `--prior` and `--prior-sha256` (repeat the pair for the reviewer's and the security report): the lead records each report's sha256 and finding ids the moment the reviewer returns it, the tool refuses a file whose hash differs, and a count or id it prints that differs from that record means the round is not clean; the classes are the names the `fix round:` line of the round before printed, which hold the classes a fix removed from the code), except after a waived round that found anything: its next round is the whole range with the full set; the lane's whole review set (every lens, at its model and effort, plus the lenses of any class only the fix touches, never fewer) re-checks the changed lines of the fix and what they can break until a round is clean, and a round is clean only when every reviewer's report has the line `prior: <n> fixed, 0 open` before its final line, with `n` that count; a weaker verdict never drops a stronger lens's finding (Opus judge), security findings are never dropped; `review-tier --add-class` when you see a risk the patterns miss. A tier-1 lane whose contract checkpoints passed (`waiverAt`) lands after one Sonnet lens round; a waived lane's Opus-max pair runs as the post-land audit beside the next lanes; every waived lane is audited until the owner allows sampling, and sync and push wait for `node ~/.claude/tools/review-tier/audit-log.mjs gate --repo <repo> --tip HEAD` (exit 1 stops them); an audit finding opens a `rework:` row and a fix lane, then `audit-log resolve`. UI: `ui-quality-pass`. Then `verify-done`.

## Skill routing (UI)

Invoke these with the Skill tool before writing code, in every project; a `skill-router` hook names them per prompt.

- Any UI code: `accessibility-build` + `responsive-ui` while building; `ui-quality-pass` before saying done.
- Figma link/frame/node: `figma-pixel-perfect` first (its UI brief template); the UI lane runs the `ui-check run` loop, then `visual-qa` runs the final gate on the tree that lands (only its PASS counts).
- Inputs/forms: `forms-validation`. Screens with server data: `async-ui-states`. Dates: `datetime-handling`.
- A UI task with more than one component, any Figma work or an "all screens" request: `ui-coverage` first.
- A project skill with the same purpose whose `paths:` match the files is preferred (e.g. `design-parity`); a personal skill with the
  same name always wins over the project one, so a project copy needs its own name.

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
- Past decisions or history: `recall` before asking.
- Delegate anything that would dump > ~150 lines (test logs, build output, big greps, docs
  crawling) to a `runner` / `scout` agent and ask for a summary of ≤ 20 lines.
- Cost = tool calls × context size: every tool call re-reads the whole conversation. So batch (several reads, greps or commands in
  one call or one script), stop at the first sufficient answer, and never loop measure→adjust→measure on the main thread.
- If context is above ~100k (statusline `ctx`), delegate any investigation needing more than ~4 calls to a fresh `scout` and use
  its summary.
- Parallelise independent tool calls in one turn. Prefer CLI (`gh`, `pnpm`) over MCP tools;
  browser/Playwright MCP only when asked (each call also echoes its code back).
- Pixel/visual bugs: read the code once and make the best fix; hand the compare-and-fix loop to the UI lane (`ui-implementer`,
  it runs until every state passes); `visual-qa` runs the final gate; never iterate screenshots and measurements on the main thread.
- Run checks through `runner` so logs stay out of context; start servers/browsers only when the task needs a
  real-app check. A command over ~5 min runs with `run_in_background: true` and its `timeout` set (at most 2 h); `watch.mjs` waits on a session or an agent, never on a command.
- Owner decisions (scope, money, irreversible, credentials, a product fact the repo lacks such as length, timer, role, copy, brand
  name or design system vs local, real trade-offs): the lead asks them (lead rules), an agent posts them as its agent file says.
  Technical choices: pick the default, say so in one line.
- Final answers: what changed and what was not run. No recap of the process. A command the owner must run is given with the machine (MacBook, PC or server) and the folder it runs in.

## Working method (quality)

- Understand before editing: read the failing output or the code path in full; do not guess
  library APIs - check the installed version's own docs (its README, types or changelog) when behaviour
  is version-sensitive.
- A fact a decision rests on that is version-, date- or price-sensitive, or disputed, gets a second independent source, even when the first looks sufficient.
- An owner rule of the form "every/all X gets Y" is applied by a search that lists every X (the count goes in the report), not by fixing the examples seen.
- Fix root causes, not symptoms; never silence a check to make it pass.
- Say "verified" only for what you ran; never imply a check passed that was not run.
- Smallest change that solves the request: no new modules or refactors beyond the task; new logic still ships with a
  test (C11). Diagnose by reading code before experimenting.
- Docs as C26, C27 and C34 require, in proportion to the change. Project documents are written for people; only the
  team's own AI config (CLAUDE.md, `.claude/`, see Project config layers) may mention AI.
- AI work notes (STATUS.md, HANDOFF.md) may sit in a project but are never committed (hide them with
  `.git/info/exclude`). No memory or history notes unless asked (the review agents' own `memory: user` notes are the
  exception).
- An owner-reported defect you could not reproduce is never closed twice: on the second report reproduce it under the owner's conditions (zoom, pixel ratio, OS, theme, data) or hand it to `deep-debugger`; never answer "no defect" to a second report.

## Compact instructions

When compacting, keep these sections, in this order: goal (the user's goal and constraints, and the user's language: reply in it,
Persian included), rules (the standing rules, and the `STATUS.md` path for multi-day work: re-read it after compaction), decisions
(made, and why), files touched (paths), last check (failing checks with the exact error), open questions, next (the next step). Drop
exploration dead-ends, full file contents, and tool output already acted on.

## Safety

- Look before deleting or overwriting. Confirm before outward-facing or hard-to-reverse actions (push, publish, delete, send), with
  any tool.
- Git push, publish/release, PR merge, Artifact publish/delete, prod-host writes and deletes, and literal secrets in a command show a
  timed confirm dialog even in bypass mode; it goes ahead after 2 min unless the owner clicks Deny. Every other permission prompt
  gets the same dialog, except a sandbox network prompt (no hook event) and anything a deny rule refuses (no hook can allow it).
- Each owner question gets its own popup and its own 60 s wait; answering in the terminal closes it. The dialog details are in
  `docs/daily-use.md` "Long or unattended runs".
- The guard bounces a command once with the fix when part of it can be rewritten (C30): send the rewrite. A quality rule (a
  hand-edited lockfile, a merge that can create a merge commit, a branch moved without `merge --ff-only`, a wait by sleeping) is
  denied once with advice: follow it. Report a bounced secret's kind to the owner.
- Reading files, `.env` included, is allowed. An agent may read a saved token (the `claude-account` store) or its terminal's token
  when it needs one (owner, 2026-11-19); printing it into a reply, a report or a command line, or committing it, stays forbidden.
  Never print or commit secrets or `.env` contents; never put a literal password or token in a command (use env vars or files).
