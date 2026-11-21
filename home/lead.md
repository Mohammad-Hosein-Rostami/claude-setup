# Lead rules, part 2 (main session only)
<!-- Printed by hooks/lead-text.mjs at every SessionStart of the main session (startup, resume, clear, compact), never in a
subagent, as its own hook string: the 10,000-char cap is per string per hook, so it does not share the room of the mode.mjs
string (probe P6-11 owed). An edit needs a session restart. When the modes go (r9-one-mode, owed), modes/_lead.md merges in. -->

## Models and effort
- Start a session on a model with `claude --model <m> --effort <e>` (owner, 2026-11-19). `CLAUDE_CODE_EFFORT_LEVEL` stays unset: it overrides that flag and every agent's effort (doctor fails on it).
- Keep the lead model all session: a model switch, a classifier fallback too, rebuilds the cache. An effort change keeps the cache on Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1+, so raise effort (`ultrathink` or `/effort`) for one hard turn, then go back to `high`.
- Every Agent call and workflow `agent()` names a model alias and an `effort`: the CLI default is `medium`, and a per-call model beats the agent file's. Sonnet agents top out at `xhigh`, never `max`; for Opus, `max` stays on the ladder until trial T7 shows `xhigh` equal on recall and false positives.
- Picks stay by lane, with no cheap-first cascade: Haiku and Sonnet at low report done without a check. A `scout` or `runner` that claims a reproduction gives the command, and the writer re-runs it before relying on it.
- Use `implementer` (or another own agent), not `general-purpose`: the built-in has no agent file, so it starts with every tool schema and an unpinned model. Built-in Explore and Plan ignore `CLAUDE_CODE_SUBAGENT_MODEL` and run on your model (sub-agents docs; probe P6-10 owed).
- On a Fable lead: each "never" keeps its scope and reason, since Fable takes it literally; review the diff yourself, since its closing summary can leave out small changes.

## Briefs and results
- Brief in six fields: objective and why; inputs; boundaries, with its Constraints first (scope exclusions, owner decisions, file scope); tools and sources; acceptance checks with failure classes to self-test, the defaults to take and "finish everything"; output format (the report's Constraints, Not run and Caveats sections, CLAUDE.md "Agents (workers)"). Add the STATUS.md path, and `ASK_QUEUE` for work over a few minutes.
- Judge an agent by its diff and the runner's record, not by its report alone. Ask for concrete checks (a command, a test, a separate reviewer), not a general request to check its work.
- Messaging a workflow agent is not documented: never rely on it; continue with a new stage or a fresh agent.

## Job form and order
- Inline, agent or workflow: decide by the job (owner, 2026-11-17: "i was wrong to start work flow for everything this must be decided smartly based on the job"). This is the one place the rule is stated; other files point here.
  - Inline, no agent: lookups (`/quick` for a read-only one), reading code, running one command, a one-file or < ~30-line change. With `review` on (/check), before it lands that change still runs `review-tier` on its diff and the review set it prints (tier 1: the Sonnet lens; a risky class: its full set).
  - One background agent (Agent tool): one job whose result is all the lead needs: one implementer lane, the review set of a single lane (`reviewer` and `security-auditor` as parallel agents when `review-tier` names both), one research question, one debug hypothesis set inside a running job, one bug fix that no fix has failed on yet.
  - Always a workflow, whatever the size: landing (`land`) and machine sync (`sync-machines`). Landing's reviewed-tip check lives only in the `land` workflow.
  - By the job, like everything else: the bugfix workflow (`bugfix`, `/workflows bugfix`) for a bug that survived one fix or needs parallel hypotheses; the git-cleanup workflow (`git-cleanup`, `/workflows git-cleanup`) for a tangle or several repos. Once a workflow skill is loaded, its job runs in that workflow, not in plain agents.
  - Workflow (the `workflows` skill: `/workflows build|review|land|bugfix|research|sync-machines|git-cleanup|step`; `/wf-resume` resumes): 2+ lanes or writers in parallel (a multi-lane job runs through `build`); a job that needs more than one step is a road ("Road of steps" below), each step one `build` run, review panels with verifiers and fix rounds across lanes, research fan-out over several sources, a multi-stage job that must survive an exit (resume), or when the owner asks.
  - Quality gates do not change with the form: they run only in the categories the owner turned on with `/check`; with `review` on, `review-tier` picks the set, run as agents or as the `review` workflow by this rule.
- Order a job as: the owner's questions for the whole job asked at its start; contract first (the architect's `files`, `principles` and `checkpoints` per lane); a job that needs more than one step is a road ("Road of steps"; 2+ lanes that fit one step are one `build` run); probes beside lanes (a probe never waits for the lanes; a lane that reads a probe waits for it or carries `--add-class audit`), independent repos as separate workflows, one critic round plus a delta check of the lines its fixes changed (with `review` on), sync once per job.
- Road of steps (owner, 2026-11-18: "controlled steps and group parallel", "best number of agents with limit"): the architect writes `road-<id>.json` beside STATUS.md with every step fixed at the start; a step is one `build` run of 1-5 lanes that share no file and use only contracts an earlier step landed (a step the owner steers: the same lanes as background agents, landed through `land` one at a time, reviewed to clean first with `review` on); between steps `road.mjs gate` (checks only for categories on), one update with the `Finish:` block and a `deliver` row. Walk it with the `road` skill.
- Send a design spec without Reuse inventory, Contract facts and Unconfirmed back to its author before briefing an implementer.
- Give separable parts (i18n) their own lane. One scripted `runner` call measures every state. Reuse cached Figma pulls, diffs and the design system.
- Size a delegated job to finish within about 120 tool calls; split a bigger one into stages with a commit between them. An agent that returns without its report is continued once ("commit, then report"), not restarted.
- One task per session. Unrelated next task → tell the user to `/clear` (or start a new
  session) *before* starting it. Long task → `/compact` at a natural seam.

## Owner, STATUS and proof
- Owner decisions (scope, money, irreversible, credentials, a product fact the repo lacks such as length, timer, role, copy, brand name or design system vs local, real trade-offs): ask with AskUserQuestion the moment they
  come up while other work keeps running (see `ask-owner`). Start the background agent or workflow, then ask: running ones keep working while a question waits; ops that may ask (rm -r, push, ssh) run in a background agent or workflow agent. Technical choices: pick the default, say so in one line.
- An owner correction, preference or constraint about how the work is done ("always", "keep", "from now on", "as we said", "is important", "remember", "don't", "why did you") goes into STATUS.md under `## Standing rules` the moment it is given, in the owner's words; every brief names that file; re-read it after a compaction or a resume. When STATUS.md is created, a session resumes or after a compaction, backfill it from the owner's own earlier messages (`node ~/.claude/tools/recall/recall.mjs --owner --session current`) before the next brief. Write each rule short, with the owner's key terms: never paste a whole message, and never copy anything that looks like a credential into STATUS.md.
- Owner proof: every done or fixed claim in a stage update or a final-report row names, on the same line, one proof the owner can check in about 2 minutes (a gallery link, a diff image, the test line red before and green now; with the category off, `not checked: <category>`); its `evidence:` points to it.
- The no-`maxTurns` rule covers a project's own agent files too: where the SessionStart note lists a file with
  `maxTurns` and gives the delete advice, delete that `maxTurns:` frontmatter line in its own commit (why in the
  body), without asking, and say so in one line (owner's standing order; an exception to C18 and C36). Edit only a
  regular file with one hard link whose real path lies in a `.claude/agents` folder of the session's git repository
  (from the session folder up to the git root, subfolders included), never through a link and never a file in the
  personal agents folder (`~/.claude/agents`). For a file the note marks "not read", "not checked" or "check by hand",
  or does not list with `maxTurns`, edit nothing and tell the owner.

## Reviews and landing
- Before review (only with `review` on): tools green; a bug fix shows its repro red before and green after on the build handed over; UI shows the ui-proof PASS; a behaviour change whose flow needs it ran on the real target (two clients, device, deployed URL). A reviewer, verifier or judge brief carries the spec, the checkpoints, the diff, the repo path and the proof record paths only: no implementer summary, no "tests pass" or "fixed", no other lens's findings in round 0. A brief to a plain `reviewer` or `security-auditor` also carries `REPORTS: <the job's reports folder>`; reports are named by the commit they judge (`review-<topic>-<sha8>.md`, `security-audit-<topic>-<sha8>.md`).
- Review findings: merge duplicates; re-read the cited lines of each blocking, should-fix or disputed finding and judge it alone before fixing or dismissing it (security findings by a separate check, never dropped); fix blocking and should-fix ones, list the rest; re-check the lines of each blocking fix.
- Land lanes one at a time by rebase and `git merge --ff-only`, then `git-tidy prune --apply` (C37).
