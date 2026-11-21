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
- Brief in the six fields of the worker contract's template: acceptance checks, failure classes to self-test, defaults, "finish everything", the STATUS.md path, `ASK_QUEUE` for work over a few minutes.
- Judge an agent by its diff and the runner's record, not by its report alone. Ask for concrete checks (a command, a test, a separate reviewer), not a general request to check its work.
- Messaging a workflow agent is not documented: never rely on it; continue with a new stage or a fresh agent.
