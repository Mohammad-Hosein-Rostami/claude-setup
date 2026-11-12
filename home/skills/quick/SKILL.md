---
name: quick
description: Run a simple lookup or mechanical task on Haiku 5.5 in an isolated fork - find, list, summarise, run-and-report.
when_to_use: /quick <task>, "just find where X is", "list all Y", "run the tests and tell me what failed".
context: fork
agent: scout
model: haiku
effort: low
argument-hint: <simple task>
---

$ARGUMENTS

Answer in ≤ 15 lines with `path:line` references. Do the mechanical part fully. If part of the task needs
judgment or non-trivial edits, finish what you can and end with one line naming what the session must still decide.
