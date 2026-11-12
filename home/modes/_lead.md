# Lead rules (main session only; injected by the mode hook at session start)

Workers do not read this file: they follow their agent file and the caller's prompt.

## Modes

- `normal` (thrift), `medium` (default), `high` (full speed), `extra-high` (high plus lead Opus 5.5 at max),
  `ultra-high` (high plus lead Fable 5.2 at max).
- Modes are per session (a state file plus `CLAUDE_MODE`). normal/medium/high change only parallelism, workflows and
  report brevity. extra-high/ultra-high also change the lead (Opus max / Fable max, set by `ccm` at launch) and send
  important jobs (architecture, hard bugs, security audits, key decisions, and risky or final reviews: auth,
  data/migrations, money, concurrency, security, or the last review before merge/push) to Opus at max
  (`model: "opus", effort: "max"`). Quality gates never change.
- Start with `ccm normal|medium|high|extra-high|ultra-high`; `/mode <m>` switches this session only (records the mode, injects the playbook).
- Subscription usage only, in every mode: never fast mode (`/fast`), never `/code-review ultra`, nothing billed as
  usage credits; at a usage limit, wait for the reset.
- The playbook injected by the mode hook (`~/.claude/modes/<m>.md`) overrides "Token discipline" in CLAUDE.md where they conflict.

## Model routing (Opus leads, agents do the work)

The session runs on **Opus 5.5 at effort `high`** (normal/medium/high) and acts as the lead: it thinks, decides and
delegates. Each agent pins the model/effort for its job; `general-purpose` (no pin) runs on Sonnet 5.5 through
`CLAUDE_CODE_SUBAGENT_MODEL`, while the built-in Explore and Plan agents run on the lead's model (Opus). Use `scout`
(Haiku) for lookups, Explore only for broad sweeps. Escalate per call with the Agent `model`/`effort` params:
`implementer`/`test-writer` `effort: "high"` for tricky or cross-module logic; `reviewer` `model: "opus"` for risky
changes (auth, data, migrations, money, concurrency, security); `architect`/`deep-debugger` `effort: "xhigh"` for the
hardest problems or after a failed attempt. Never downgrade a pick to save tokens.

| Work | Who | How |
| ---- | --- | --- |
| Planning, analysis, architecture/API design, trade-off decisions, ADRs, root cause of hard bugs, judging agent results, the final call | **Opus 5.5 (the session)** | itself; `architect` / `deep-debugger` / `/escalate` when the question needs a clean context |
| Implementation, refactors, tests, normal bug fixes, reviews | **Sonnet 5.5** | `implementer`, `test-writer`, `reviewer` agent |
| UI implementation (pages, screens, steps, components, layout, styling, forms) | **Sonnet 5.5** | `ui-implementer` agent (never plain `implementer`) |
| Figma match and responsive checks (compare, fix loop; returns text only, no images) | **Sonnet 5.5** | `visual-qa` agent, skill `figma-pixel-perfect` |
| Searching, listing, reading many files, running tests/lint/build, log triage, summarising, formatting, trivial edits | **Haiku 5.5** | `scout` / `runner` agent, or `/quick` |

Rules:

1. Opus does not write long implementations itself. It writes a **spec** (decision, files, steps,
   acceptance checks, ≤ 60 lines) to a file, hands the path to a Sonnet agent, then checks the
   report and the diff and decides whether it is done. Do not paste the spec into chat twice.
2. Opus keeps only the work that needs the strong model: planning, analysis, decisions, review of
   what agents return, and edits of a few lines where briefing an agent costs more than doing it.
3. Downshift to Haiku for anything mechanical. If the result is a lookup, a log, or a file
   list, a Haiku agent returns the answer; the main context never sees the raw output.
4. Independent pieces of work go to agents in parallel, in one message. Merge small pieces (each ~1-2 edits, same
   module) into one agent with one section per piece; parallelise pieces that are large or in different modules.
5. For a new kind of task with no pinned agent, start with the cheaper tier and escalate on failure; never downgrade a
   pinned agent to save tokens.
6. Effort: the lead stays at `high` in normal/medium/high; deeper thinking goes to the agent call via `effort`. Opus 5.5
   at `medium` already beats Opus 5 at `high`, so do not raise the lead's effort (a mid-session effort change costs
   a prompt-cache miss).

## Finish the run

- Stuck is a signal to change approach, not to stop: `root-cause-debug`, then `deep-debugger`, then `/escalate`. If a
  subagent comes back unfinished, continue it (SendMessage) or re-delegate with what it learned; never drop the work.
- Cost is steered, not capped: routing (rules above), delegation of noisy work, auto-compaction and `/compact` at
  seams, and short reports.

## Delegating UI work

- Use `ui-implementer` (it preloads the UI skills); a subagent never inherits skills you loaded.
- A project's own `ui-implementer` shadows it: name the UI skills in the delegation prompt.
