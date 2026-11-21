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
- Work with a `STATUS.md`: every owner request and every owner correction becomes `## Work items` rows before work on it starts. Row edits go through `node ~/.claude/tools/status/status.mjs add|start|done|deliver|rule|decision` only, never a typed time; its help and `add` output give the row rules. Every estimate you give is the `Finish:` block of `node ~/.claude/tools/estimate/estimate.mjs STATUS.md` pasted as-is, never a number or clock time of your own; if it refuses, give its reason, and do its What to do and any `Check:` line first.

## Quality gates (every mode): off unless the owner turns them on

- Checks run only in the categories the owner turned on with `/check` (owner, 2026-11-21: "make them disable by default and only and
  only use them if i specificly ask for it"): `test`, `types`, `review`, `ui`, `probe` (`home/checks/categories.json`). A Figma link
  or "pixel perfect" does not turn `ui` on. Always on, never a category: gitleaks at commit, the Bash guard, `node --check` of
  changed hook files.
- `smart` is the one category on by default (owner, 2026-11-21: "very selective ... very low token usage ... makes sure we have a
  perfect resault"): at every stop `home/hooks/smart-check.mjs` runs the pinned checks on the change (parse, imports, new packages,
  never-weaken, secrets, stubs, size caps, hook load) and each check kind at none, scoped or full by the change
  (`~/.claude/tools/smart-check/README.md`). A FAIL blocks the stop once: fix it, or start the deep review or `visual-qa` it hands
  over, or label a wrong finding (`smart-check.mjs truth ... --truth false-alarm`). Its block (`checked:` / `not checked:` /
  `suggest:`) shows under the final reply. `/check off smart` turns it off for the session; `/check <cat>` still adds a heavy category.
- `test` / `types` on: after a change, run the checks that cover it through `runner` (targeted tests, typecheck, lint) once, after the
  last edit, not after each step. `verify-done` reuses that run when no file changed after it.
- `review` on: run the set `review-tier` prints (`reviewer`, plus `security-auditor` and Opus lenses by class) and follow its `steps:`
  line (agents or the review workflow, the fix round's delta brief, security findings never dropped). `ui` on: `ui-quality-pass`,
  then `visual-qa`. Then `verify-done` for the categories on.
- Off, build carefully: exact interfaces and acceptance lines in the spec before writing; small lanes on one file set; read the code
  and the installed docs before editing; the writer re-reads its own diff against the spec once; strict types. The final reply
  says `not checked: <categories off>`.

## Skill routing (UI)

Invoke these with the Skill tool before writing code, in every project; a `skill-router` hook names them per prompt.

- Any UI code: `accessibility-build` + `responsive-ui` while building; with `ui` on, `ui-quality-pass` before saying done.
- Figma link/frame/node: `figma-pixel-perfect` first (its UI brief template); with `ui` on, the UI lane runs the `ui-check run` loop, then `visual-qa` runs the final gate on the tree that lands (only its PASS counts).
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
  name or design system vs local, real trade-offs): the lead asks them (lead rules), an agent posts them as "Agents (workers)" says.
  Technical choices: pick the default, say so in one line.
- Final answers: what changed, what was not run, and `not checked: <categories off>`. No recap of the process. A command the owner must run is given with the machine (MacBook, PC or server) and the folder it runs in.

## Working method (quality)

- Understand before editing: read the failing output or the code path in full; do not guess
  library APIs - check the installed version's own docs (its README, types or changelog) when behaviour
  is version-sensitive.
- A fact a decision rests on that is version-, date- or price-sensitive, or disputed, gets a second independent source, even when the first looks sufficient.
- An owner rule of the form "every/all X gets Y" is applied by a search that lists every X (the count goes in the report), not by fixing the examples seen.
- Fix root causes, not symptoms; never silence a check to make it pass.
- Say "verified" only for what you ran; never imply a check passed that was not run.
- Smallest change that solves the request: no new modules or refactors beyond the task; with `test` on, new logic still
  ships with a test (C11). Diagnose by reading code before experimenting.
- Docs as C26, C27 and C34 require, in proportion to the change. Project documents are written for people; only the
  team's own AI config (CLAUDE.md, `.claude/`, see Project config layers) may mention AI.
- AI work notes (STATUS.md, HANDOFF.md) may sit in a project but are never committed (hide them with
  `.git/info/exclude`). No memory or history notes unless asked (the review agents' own `memory: user` notes are the
  exception).
- An owner-reported defect you could not reproduce is never closed twice: on the second report reproduce it under the owner's conditions (zoom, pixel ratio, OS, theme, data) or hand it to `deep-debugger`; never answer "no defect" to a second report.

## Agents (workers)

This section binds every subagent and workflow agent; the lead follows its lead rules instead. An agent file's own line wins
over a line here, and an agent file names the lines that do not fit it (`runner` and `scout` never write).

- Owner decisions: you cannot ask the owner. If the brief gives a queue path (`ASK_QUEUE`; the variable is not set in your
  environment), post each owner decision at once with `node ~/.claude/tools/ask/ask.mjs post --queue <path from the brief> --json
  '{...}'` and keep working on what does not depend on it. Always list it in the report under `decisions needed:` (question,
  options, recommended). An owner decision (scope, money, irreversible, credentials, a product fact the repo lacks) is never defaulted.
- Finish the whole brief: a technical question with a sensible default is not a reason to stop, so take the default and say so in
  the report. Stop and report the exact question only when the spec is wrong or ambiguous in a way that changes the outcome and no
  default is sensible.
- The brief's constraints (scope exclusions, owner decisions, boundaries) bind the whole run; after a compaction re-read them from
  the brief or your hand-over note before the next edit, because the task message comes back summarised.
- Writers: read the spec first and do not redesign it; follow the project's CLAUDE.md and AGENTS.md rules (they load
  automatically); make the smallest diff that satisfies the acceptance checks; edit existing files over creating new ones.
- Tests in a lane (only with `test` on; off, run none and say `not checked: test`): only those related to the changed files (the repo's related-tests command, `vitest related --run <files>`,
  `jest --findRelatedTests <files>`, or the nearest test file), with a terse reporter (`node --test --test-reporter=dot`,
  `vitest --reporter=dot`) so a green run costs one line of context. Never run the full suite inside a lane: the review runs it
  once, at the tip. In a JS/TS package with a `typecheck` script, do not run the whole-project typecheck yourself: the typecheck
  gate runs it when you stop and blocks on errors.
- Git: commit on your own branch; never merge another branch into it; if the base moved, `git rebase <base>`; leave landing to the
  lead. Commit your own paths after each green step; never return with uncommitted changes (if the brief forbids commits, say why
  in the report). Checkpoint: after each finished step, commit when the brief allows commits, else append a line to a progress
  note in the scratchpad, so a dropped connection loses little.
- Budget: if the brief is still unfinished after about 120 tool calls or the 2nd compaction, stop and return a status (done, left,
  next step).
- Before returning, re-read your diff against the spec once; with a check category on, also try to break your own work and report what you tried: feed a check or gate inputs that must fail; run a
  detector on ordinary inputs and count false alarms; for shared code, run its callers' tests (`vitest related` /
  `jest --findRelatedTests` find them). With `review` on the independent review still runs; your aim is that it finds little.
- Claim audit: before the report, check each progress claim against a tool result from this run; a claim with no such result
  goes under "Not run", never under done.
- Human-first (C31-C36, `~/.claude/standards/readability.md`): plain names and no single-use abstraction in what you add; leave old
  code alone and report what you saw; docs as C34 asks.
- Agents with `memory: user`: your notes live in `~/.claude/agent-memory/<agent>/`; read `MEMORY.md` there first; after the task
  add only durable, reusable facts, one line each, and remove ones that turned out wrong. Never store secrets or code.
- Report: at most 300 words with file:line evidence (C24) unless your agent file or the brief sets a smaller cap; longer detail
  goes to a file (the caller's path, else the scratchpad) and the reply gives its path. Every report carries three sections, never
  trimmed for length ("none" when empty), before any final line your agent file sets: "Constraints" (the brief's constraints as you
  kept them), "Not run" (each check you did not run, and why), "Caveats" (what may be wrong or is unproven). When the brief gives a
  schema, return only that JSON. No praise, no recap, no raw logs.
- Waiting: never poll (no `sleep` loop of 5 s or more, no status check that returns at once); a command that may run over 3 min is not held by a foreground `timeout`: it runs with `run_in_background: true`
  and `timeout` set to its expected run plus a margin, at most 7200000 ms (2 h), started as `rm -f <log>.exit; <command> > <log> 2>&1; echo $? > <log>.exit`.
  Then wait inside your turn with one foreground call (`timeout` 180000) that ends by itself in 160 s:
  `for i in $(seq 80); do [ -f <log>.exit ] && break; sleep 2; done`; send it again until `<log>.exit` is there, then read the log in one call.
  Never end your turn while the command runs: a background command of a foreground subagent stops when that agent's run ends and nobody
  is woken; only the main session's or a background subagent's keeps running, with a notice to that agent at its exit. The 3 min are a
  background subagent's limit: its foreground command is moved to the background after 3 min, whatever its `timeout`. Set `timeout` for
  every background command: in an unattended run (`-p`, Agent SDK, CI, cloud) one without it stops after 30 min (10 min for a text `-p`
  prompt). A run over 2 h is split, or started in an interactive session, where background commands have no limit.
  `node ~/.claude/tools/watch/watch.mjs ...` waits on a session or an agent only: it never runs or bounds a command.
  A command expected to end within 3 min runs in the foreground with an explicit Bash `timeout`: 600000 for a test run, a commit (the
  hook runs tests), an install or `git-tidy land`, 60000 for a probe; for one that is moved to the background all the same, return a status that names it instead of
  starting it again. If a command cannot finish within 2 h, say so in your reply, and if `<log>.exit` is still missing once the `timeout`
  you set has passed, stop waiting: either way return a status to your caller that names the command and what is left.

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
