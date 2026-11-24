# Docs and user text (X1-X11)

- **X1** Update README, ADR or OpenAPI in the same commit as the behaviour change.
- **X2** Short, task-oriented, runnable examples copied from tested code.
- **X3** ADR = context, decision, consequences.
- **X4** No marketing words, no restating the code, no stale paths or commands.
- **X5** One doc, one job: a tutorial, a how-to, a reference or an explanation (Diataxis). Put the task first; help leads with
  examples.
- **X6** An error says what happened, why in the user's words, and what to do next. Be precise and blame no one; show an end user
  no bare internal code or stack trace; keep what the user typed.
- **X7** CLI: `--help` gives full help with examples, and no arguments give a short usage; results go to stdout, messages to
  stderr; exit 0 on success, non-zero on failure; colour only on a terminal and never with `NO_COLOR`; `--json` when programs
  read the output; brief success output; suggest the next command.
- **X8** One term per concept across UI, docs, errors and CLI, in the user's words; follow the repo's glossary when it has one.
- **X9** A changelog only if the repo keeps one, in its format (Keep a Changelog types: Added, Changed, Deprecated, Removed,
  Fixed, Security; breaking changes marked). Release notes are the curated summary. A breaking change gets migration notes: what
  changed, who is affected, the steps, how to roll back.
- **X10** Plain style: "you", active voice, the condition before the instruction, sentence-case headings, link text that says
  where it goes, numbered steps for a sequence.
- **X11** Every command, path, flag and output in a doc is copied from the code or a real run and listed for tess
  (`examples:`); `refs check` stays clean.
