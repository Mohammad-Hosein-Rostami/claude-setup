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

Give a decision with rationale, the minimal change list, and acceptance checks - ≤ 40
lines. Write it to `plans/<slug>.md` only if the caller asked for a file. Do not implement.
