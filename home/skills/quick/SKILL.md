---
name: quick
description: Run a simple lookup or mechanical task on Haiku 5.5 in an isolated fork - find, list, read and summarise (read-only, no commands).
when_to_use: /quick <task>, "just find where X is", "list all Y", "summarise these files". To run tests or other commands use the `runner` agent.
context: fork
agent: scout
model: haiku
effort: medium
argument-hint: <simple task>
---

$ARGUMENTS

Answer in ≤ 15 lines with `path:line` references. This fork can only read and search (no Bash, no edits); do that part fully. If part of the task needs
judgment or non-trivial edits, finish what you can and end with one line naming what the session must still decide.

Verification (Anthropic's Haiku 5.5 verification paragraph, prompting guide "Tell coding agents to verify their changes", adapted
to a read-only lookup): every claim in the answer comes from a file you read or a search you ran in this run, cited as
`path:line`. A file you did not open, or a search that returned nothing, does not count as evidence; say which part you could not
check and why instead of answering it.
