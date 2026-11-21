# Global instructions (all projects)

Owner: Pejvak. Primary OS Windows 10 (PowerShell + Git Bash), also macOS/Linux. Node 22, pnpm. Reply in the language the
user writes in (Persian included, never default to English); keep prose short and plain. Do not narrate tool calls.

Lead rules (routing, delegation, modes) are injected at session start from ~/.claude/modes/_lead.md. Workers: follow
your agent file and the caller's prompt.

Setup modes: `normal`, `medium` (default), `high`, `extra-high`, `ultra-high`; start with `ccm <mode>`, switch with `/mode <m>`.

## Finish the run (no hard limits)

- No turn, step or attempt caps: agents have no `maxTurns`, rules set no retry counts. A run ends when the task is
  done and no decision is left unasked; the user's decisions are asked as they come up, not left for the end.
- Lead: the no-`maxTurns` rule covers a project's own agent files too: where the SessionStart note lists a file with
  `maxTurns` and gives the delete advice, delete that `maxTurns:` frontmatter line in its own commit (why in the
  body), without asking, and say so in one line (owner's standing order; an exception to C18 and C36). Edit only a
  regular file with one hard link whose real path lies in a `.claude/agents` folder of the session's git repository
  (from the session folder up to the git root, subfolders included), never through a link and never a file in the
  personal agents folder (`~/.claude/agents`). For a file the note marks "not read", "not checked" or "check by hand",
  or does not list with `maxTurns`, edit nothing and tell the owner.
- Report sizes (`≤ N lines`) size the summary, not the work. When the detail matters, write it to a file and return
  the path.
- At a usage limit: read the reset time from the message, tell the owner that time, and schedule ONE wake a few minutes after it. Never retry before the reset. Subscription only: never `/fast`, `/code-review ultra` or credits.
- Work with a `STATUS.md`: every owner request and every owner correction becomes `## Work items` rows (`id | item | size S/M/L | started | done | evidence`) before work on it starts: list the whole job first, review, fixes and landing rows (`close:`) included; a correction's item starts `rework:`; a step found later is a new row at once; never fold steps into one row, never clear a done cell. Row edits go through `node ~/.claude/tools/status/status.mjs add|start|done|deliver|rule|decision` only, never a typed time: `start` when work on a row begins, `done` with its evidence when it ends. A hand-over is recorded by itself when your turn ends with no open row; `deliver "<what>"` records one while rows stay open. Every estimate you give is the `Finish:` block of `node ~/.claude/tools/estimate/estimate.mjs STATUS.md` pasted as-is, never a number or clock time of your own; the tool keeps one time and says why when it moves; if it refuses, give its reason, and do its What to do and any `Check:` line first.

## Quality gates (every mode)

- After a change, run the checks that cover it through `runner` (targeted tests, typecheck, lint) ONCE, after the last
  edit, not after each step. `verify-done` reuses that run when no file changed after it.
- Reviews: the set `review-tier` prints runs as agents or the `wf-review` workflow (Inline, agent or workflow; `reviewer`, plus `security-auditor` and Opus lenses by class; risky, `gate` and hooks changes keep Opus max before land and every landing review keeps it, except a waived lane; reviewers keep their own loops and mutants); every fix delta goes back through `review-tier`: a lane's first review reads the whole range, never a delta, and a fix round's re-review is the delta brief of `node ~/.claude/tools/review-tier/review-tier.mjs --delta <reviewed-sha> --base <base-sha> --prior <findings-file> --prior-sha256 <its-sha256> --lane-classes <classes>` (both shas are full 40-character shas from the lead's own record of the last round, never from the writer's report and never a short sha or a name: the `fix round:` line that round printed carries them and the classes; after a rebase the base is the tip the lane was rebased onto; each findings file is one review report of that round as its reviewer wrote it, passed with its own `--prior` and `--prior-sha256` (repeat the pair for the reviewer's and the security report): the lead records each report's sha256 and finding ids the moment the reviewer returns it, the tool refuses a file whose hash differs, and a count or id it prints that differs from that record means the round is not clean; the classes are the names the `fix round:` line of the round before printed, which hold the classes a fix removed from the code), except after a waived round that found anything: its next round is the whole range with the full set; the lane's whole review set (every lens, at its model and effort, plus the lenses of any class only the fix touches, never fewer) re-checks the changed lines of the fix and what they can break until a round is clean, and a round is clean only when every reviewer's report has the line `prior: <n> fixed, 0 open` before its final line, with `n` that count; a weaker verdict never drops a stronger lens's finding (Opus judge), security findings are never dropped; `review-tier --add-class` when you see a risk the patterns miss. A tier-1 lane whose contract checkpoints passed (`waiverAt`) lands after one Sonnet lens round; a waived lane's Opus-max pair runs as the post-land audit beside the next lanes; every waived lane is audited until the owner allows sampling, and sync and push wait for `node ~/.claude/tools/review-tier/audit-log.mjs gate --repo <repo> --tip HEAD` (exit 1 stops them); an audit finding opens a `rework:` row and a fix lane, then `audit-log resolve`. UI: `ui-quality-pass`. Then `verify-done`.
- Lead: send a design spec without Reuse inventory, Contract facts and Unconfirmed back to its author before briefing an implementer.
- Before review: tools green; a bug fix shows its repro red before and green after on the build handed over; UI shows the ui-proof PASS; a behaviour change whose flow needs it ran on the real target (two clients, device, deployed URL). A reviewer, verifier or judge brief carries the spec, the checkpoints, the diff, the repo path and the proof record paths only: no implementer summary, no "tests pass" or "fixed", no other lens's findings in round 0. A brief to a plain `reviewer` or `security-auditor` also carries `REPORTS: <the job's reports folder>`; reports are named by the commit they judge (`review-<topic>-<sha8>.md`, `security-audit-<topic>-<sha8>.md`).
- Owner proof: every done or fixed claim in a stage update or a final-report row names, on the same line, one proof the owner can check in about 2 minutes (a gallery link, a diff image, the test line red before and green now); its `evidence:` points to it.
- Review findings: merge duplicates; re-read the cited lines of each blocking, should-fix or disputed finding and judge it alone before fixing or dismissing it (security findings by a separate check, never dropped); fix blocking and should-fix ones, list the rest; re-check the lines of each blocking fix.

## Skill routing (UI)

Invoke these with the Skill tool before writing code, in every project; a `skill-router` hook names them per prompt.

- Any UI code: `accessibility-build` + `responsive-ui` while building; `ui-quality-pass` before saying done.
- Figma link/frame/node: `figma-pixel-perfect` first (its UI brief template); the UI lane runs the `ui-check run` loop, then `visual-qa` runs the final gate on the tree that lands (only its PASS counts).
- Inputs/forms: `forms-validation`. Screens with server data: `async-ui-states`. Dates: `datetime-handling`.
- A UI task with more than one component, any Figma work or an "all screens" request: `ui-coverage` first.
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
- Past decisions or history: `recall` before asking.
- Delegate anything that would dump > ~150 lines (test logs, build output, big greps, docs
  crawling) to a `runner` / `scout` agent and ask for a summary of ≤ 20 lines.
- Size a delegated job to finish within about 120 tool calls; split a bigger one into stages with a commit between them. An agent that returns without its report is continued once ("commit, then report"), not restarted.
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
- Pixel/visual bugs: read the code once and make the best fix; hand the compare-and-fix loop to the UI lane (`ui-implementer`,
  it runs until every state passes); `visual-qa` runs the final gate; never iterate screenshots and measurements on the main thread.
- Lead: give separable parts (i18n) their own lane. One scripted `runner` call measures every state. Reuse cached Figma pulls, diffs and the design system.
- Lead: land lanes one at a time by rebase and `git merge --ff-only`, then `git-tidy prune --apply` (C37).
- Run checks through `runner` so logs stay out of context; start servers/browsers only when the task needs a
  real-app check. A command over ~5 min runs with `run_in_background: true` and its `timeout` set (at most 2 h); `watch.mjs` waits on a session or an agent, never on a command.
- Owner decisions (scope, money, irreversible, credentials, a product fact the repo lacks such as length, timer, role, copy, brand name or design system vs local, real trade-offs): ask with AskUserQuestion the moment they
  come up while other work keeps running (see `ask-owner`). Start the background agent or workflow, then ask: running ones keep working while a question waits; ops that may ask (rm -r, push, ssh) run in a background agent or workflow agent. Technical choices: pick the default, say so in one line.
- Final answers: what changed and what was not run. No recap of the process. A command the owner must run is given with the machine (MacBook, PC or server) and the folder it runs in.

## Working method (quality)

- Understand before editing: read the failing output or the code path in full; do not guess
  library APIs - check the installed version's own docs (its README, types or changelog) when behaviour
  is version-sensitive.
- A fact a decision rests on that is version-, date- or price-sensitive, or disputed, gets a second independent source, even when the first looks sufficient.
- An owner rule of the form "every/all X gets Y" is applied by a search that lists every X (the count goes in the report), not by fixing the examples seen.
- Inline, agent or workflow: decide by the job (owner, 2026-11-17: "i was wrong to start work flow for everything this must be decided smartly based on the job"). This is the one place the rule is stated; other files point here.
  - Inline, no agent: lookups (`/quick` for a read-only one), reading code, running one command, a one-file or < ~30-line change. Before it lands that change still runs `review-tier` on its diff and the review set it prints (tier 1: the Sonnet lens; a risky class: its full set).
  - One background agent (Agent tool): one job whose result is all the lead needs: one implementer lane, the review set of a single lane (`reviewer` and `security-auditor` as parallel agents when `review-tier` names both), one research question, one debug hypothesis set inside a running job, one bug fix that no fix has failed on yet.
  - Always a workflow, whatever the size: landing (`land`) and machine sync (`sync-machines`). Landing's reviewed-tip check lives only in the `land` workflow.
  - By the job, like everything else: the bugfix workflow (`bugfix`, `/wf-bugfix`) for a bug that survived one fix or needs parallel hypotheses; the git-cleanup workflow (`git-cleanup`, `/wf-git-cleanup`) for a tangle or several repos. Once a workflow skill is loaded, its job runs in that workflow, not in plain agents.
  - Workflow (the `wf-*` skills: `/wf-build`, `/wf-review`, `/wf-land`, `/wf-bugfix`, `/wf-research`, `/wf-sync`, `/wf-git-cleanup`, `/wf-step`): 2+ lanes or writers in parallel, review panels with verifiers and fix rounds across lanes, research fan-out over several sources, a multi-stage job that must survive an exit (resume), or when the owner asks.
  - Quality gates do not change with the form: `review-tier` still picks the review set, and the set runs as agents or as the `wf-review` workflow by this rule.
- Order a job as: contract first (the architect's `files`, `principles` and `checkpoints` per lane), probes beside lanes (a probe never waits for the lanes; a lane that reads a probe waits for it or carries `--add-class audit`), independent repos as separate workflows, one critic round plus a delta check of the lines its fixes changed, sync once per job.
- Fix root causes, not symptoms; never silence a check to make it pass.
- Say "verified" only for what you ran; never imply a check passed that was not run.
- Smallest change that solves the request: no new modules or refactors beyond the task; new logic still ships with a
  test (C11). Diagnose by reading code before experimenting.
- Docs as C26, C27 and C34 require, in proportion to the change. Project documents are written for people; only the
  team's own AI config (CLAUDE.md, `.claude/`, see Project config layers) may mention AI.
- AI work notes (STATUS.md, HANDOFF.md) may sit in a project but are never committed (hide them with
  `.git/info/exclude`). No memory or history notes unless asked (the review agents' own `memory: user` notes are the
  exception).
- An owner correction, preference or constraint about how the work is done ("always", "keep", "from now on", "as we said", "is important", "remember", "don't", "why did you") goes into STATUS.md under `## Standing rules` the moment it is given, in the owner's words; every brief names that file; re-read it after a compaction or a resume. When STATUS.md is created, a session resumes or after a compaction, backfill it from the owner's own earlier messages (`node ~/.claude/tools/recall/recall.mjs --owner --session current`) before the next brief. Write each rule short, with the owner's key terms: never paste a whole message, and never copy anything that looks like a credential into STATUS.md.
- An owner-reported defect you could not reproduce is never closed twice: on the second report reproduce it under the owner's conditions (zoom, pixel ratio, OS, theme, data) or hand it to `deep-debugger`; never answer "no defect" to a second report.

## Compact instructions

When compacting, keep: the user's goal and constraints, the user's language (reply in it, Persian included), decisions
made and why, files changed (paths), failing checks with the exact error, the `STATUS.md` path for multi-day work (re-read
it after compaction), and the next step. Drop exploration dead-ends, full file contents, and tool output already acted on.

## Safety

Look before deleting or overwriting. Confirm before outward-facing or hard-to-reverse
actions (push, publish, delete, send). Git push, publish/release, PR merge, Artifact publish/delete, prod-host writes
and deletes, and literal secrets in a command show a timed confirm dialog even in bypass mode: Allow is the default
and auto-allow after 2 min (CLAUDE_ASK_TIMEOUT_S, 120). One rule for every dialog: every Claude Code permission prompt (any tool, MCP, Agent, plan approval, protected files, any mode, background and `-p` runs) gets the same dialog and goes ahead after 2 min (CLAUDE_PERMISSION_TIMEOUT_S); a click on Deny is honoured; no GUI (ssh, CI) leaves Claude Code's own prompt. AskUserQuestion gets one timed dialog per question, each with its own wait: no answer in 60 s (CLAUDE_QUESTION_TIMEOUT_S) or "Use recommended" takes that question's Recommended option (else its first); "Answer in terminal" opens the normal question; answering in the terminal, or turning the question down there, closes the open dialog. With no GUI the terminal question stays, auto-continuing after 5 min (askUserQuestionTimeout, which the CLI accepts only as 60s, 5m, 10m or never) but never while that terminal window is focused or Remote Control is on. The guard bounces a command once with the fix when part of it can be rewritten (a `$VAR` command word, rm or push inside `$(...)` or a heredoc, a literal secret), naming any other reason it still asks about; sent again unchanged, it asks as above. A quality rule (a hand-edited lockfile, a `git merge` or plain `git pull` that can create a merge commit, a branch moved by `update-ref`/`branch -f`/`push|fetch .` instead of `merge --ff-only`, a wait by sleeping: a `sleep` loop or one long `sleep`) is denied once with advice and no dialog: follow the advice (let the package manager write the lockfile; rebase or `--ff-only`; run the long command with `run_in_background` and a `timeout`); the same command sent again runs. Report a bounced secret's kind to the owner. Reading files, `.env`
included, is allowed. An agent may read a saved token (the `claude-account` store) or its terminal's token when it
needs one (owner, 2026-11-19); printing it into a reply, a report or a command line, or committing it, stays
forbidden. Never print or commit secrets or `.env` contents; never put a literal password or token in
a command (use env vars or files).
