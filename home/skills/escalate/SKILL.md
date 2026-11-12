---
name: escalate
description: Send a hard design, architecture or stubborn-bug question to Opus 5.5 in an isolated fork and get a short decision. Not for implementation.
when_to_use: /escalate <question>, "think harder about the architecture", "I need a real design decision", a bug that survived one fix attempt.
context: fork
agent: architect
model: claude-opus-5-5
effort: high
argument-hint: <design question or hard bug>
---

Decide: $ARGUMENTS

Follow your output contract: a decision with rationale, the minimal change list and acceptance checks. Return it
inline, ≤ 40 lines. Write `plans/<slug>.md` only when the caller gives a path or asks for a file; then return the
path plus a ≤ 5 line summary. Do not implement.
