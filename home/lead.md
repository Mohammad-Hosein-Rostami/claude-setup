# Lead rules, part 2 (main session only)
<!-- Printed by hooks/lead-text.mjs at every SessionStart of the main session (startup, resume, clear, compact), never in a
subagent, as its own hook string: the 10,000-char cap is per string per hook, so it does not share the room of the
session-notes.mjs string, which carries part 1 (lead-rules.md) (probe P6-11 owed). An edit needs a session restart. -->

## Models and effort
- Start a session on a model with `claude --model <m> --effort <e>` (owner, 2026-11-19). `CLAUDE_CODE_EFFORT_LEVEL` stays unset: it overrides that flag and every agent's effort (doctor fails on it).
- Keep the lead model all session: a model switch, a classifier fallback too, rebuilds the cache. An effort change keeps the cache on Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1+, so raise effort (`ultrathink` or `/effort`) for one hard turn, then go back to `high`.
- Every Agent call names a model alias and an `effort`: the CLI default is `medium`, and a per-call model beats the agent file's. Sonnet agents top out at `xhigh`, never `max`; for Opus, `max` stays on the ladder until trial T7 shows `xhigh` equal on recall and false positives.
- Picks stay by lane, with no cheap-first cascade: Haiku and Sonnet at low report done without a check. A `scout` or `runner` that claims a reproduction gives the command, and the writer re-runs it before relying on it.
- Use `implementer` (or another own agent), not `general-purpose`: the built-in has no agent file, so it starts with every tool schema and an unpinned model. Built-in Explore and Plan ignore `CLAUDE_CODE_SUBAGENT_MODEL` and run on your model (sub-agents docs; probe P6-10 owed).
- On a Fable lead: each "never" keeps its scope and reason, since Fable takes it literally; review the diff yourself, since its closing summary can leave out small changes.

## Briefs and results
- Brief in six fields: objective and why; inputs; boundaries, with its Constraints first (scope exclusions, owner decisions, file scope); tools and sources; acceptance checks with failure classes to self-test, the defaults to take and "finish everything"; output format (the report's Constraints, Not run and Caveats sections, CLAUDE.md "Agents (workers)"). Add the STATUS.md path, and `ASK_QUEUE` for work over a few minutes.
- Judge an agent by its diff and the runner's record, not by its report alone. Ask for concrete checks (a command, a test, a separate reviewer), not a general request to check its work.

## Job form and order
- Inline or agents, by the job (owner, 2026-11-22: only subagents, 3-5 agents per step). Inline: lookups, reading code, one command, a one-file or < ~30-line change (with `review` on it still runs `review-tier` and its set before it lands). Everything else runs as steps.
- A batch is 1-5 agents launched together; a step runs its batches in order (build, review rounds, fixes). Every agent counts: writers, test-writers, lenses, judges, runners, scouts, deep-debugger, visual-qa and a SendMessage continuation. The hook refuses a 6th. The next batch starts once every result of this one is handled.
  - Build batch: lanes that share no file (a lane plus its test-writer counts two).
  - Review batch: whole `review-tier` sets of one or more lanes, never split by a fix.
  - Fix batch: one fix agent per lane, holding all of its confirmed findings.
- A fixed sequence is one script call, never an agent per command: `land-lane` (the only landing route, one land at a time), `road.mjs join`, `review-tier` with `verdict.mjs`, `scripts/sync-machines.mjs` (once per job, after the last land), `status.mjs`. A `runner` only keeps long output out of context.
- A writer brief names `BASE: <full sha>`, `BRANCH: <name>`, STATUS.md, the lane's contract (files, checkpoints, P and F questions, threat-model line) and `REPORTS:`. An agent that returns unfinished is continued once with SendMessage, else a fresh agent gets the six fields, `git diff <base>...<branch>` and its `HANDOFF-<row>.md`. Two stops in a row: you decide; no third agent.
- Order a job as:
  - the owner's questions first;
  - then the contract: the architect's spec with Reuse inventory, Contract facts, Unconfirmed, F questions and a threat-model line (send back one without them);
  - every lane job is a road (`road-<id>.json`, `road` skill), and each step runs build batch, `road.mjs join` per lane, review rounds (`review` on), `land-lane` per lane, `road.mjs gate`, then a `deliver` row with the `Finish:` block;
  - probes run beside lanes (a lane that reads a probe waits for it or carries `--add-class audit`); independent repos run as separate roads.
- Two fix rounds per lane, for a review, land, visual-qa or bugfix loop. When the second is not clean, or a fixer returns `needs-design`, the lane goes to the architect with its open findings by class, then to one implementer on that spec. A second re-spec of one class is an owner question. Before the second fix of a file that blocked the round before, one `deep-debugger` names the cause.
- Quality gates do not change with the form: they run only in the categories the owner turned on with `/check`. `smart` is on by default: its Stop hook picks each check's level by the change; act on its FAIL (start the review set it names); its `checked:` / `not checked:` / `suggest:` block shows under the final reply.
- Durable state, no journals: STATUS rows (a lane's `review r<N> <sha8> <verdict>` evidence), branch tips, `HANDOFF-<row>.md` and the reports folder. A new session reads those, then `road.mjs next`.
- Give separable parts (i18n) their own lane. One scripted `runner` call measures every state. Reuse cached Figma pulls, diffs and the design system.
- Size a delegated job to finish within about 120 tool calls; split a bigger one into stages with a commit between them. An agent that returns without its report is continued once ("commit, then report"), not restarted.
- One task per session. Unrelated next task → tell the user to `/clear` (or start a new
  session) *before* starting it. Long task → `/compact` at a natural seam.

## Owner, STATUS and proof
- Owner decisions (scope, money, irreversible, credentials, a product fact the repo lacks such as length, timer, role, copy, brand name or design system vs local, real trade-offs): ask with AskUserQuestion the moment they
  come up while other work keeps running (see `ask-owner`). Start the background agent, then ask: running ones keep working while a question waits; ops that may ask (rm -r, push, ssh) run in a background agent. Technical choices: pick the default, say so in one line.
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
- With `review` on, one complete review per round: the `steps:` line `review-tier` prints, with the lens briefs pasted as printed (plus spec, checkpoints, P and F questions, threat-model line, `REPORTS:`), never an implementer summary. Every lens answers the same failure-class checklist and ends with `read: a/b`; a count below the total is incomplete. Then `verdict.mjs`; merge duplicates and act on its `next:` line after you re-read the cited lines of each must-fix finding; security findings are never dropped.
- A fix closes the whole finding and its class: one fix agent per lane gets every confirmed finding with its parts and siblings. In a delta round only the five origins (prior, fix-line, sibling, security, lane-blocking) can block; optional items become follow-up rows and never enter a fix brief.
- Before review: tools green; a bug fix shows its repro red before and green after; UI shows the ui-proof PASS; a flow that needs it ran on the real target (two clients, device, deployed URL); with `review` on the builder self-probed: the tier's probes and every F probe.
- Land only with `land-lane` and the reviewed tip from your own record; never `git merge` by hand (C37).
