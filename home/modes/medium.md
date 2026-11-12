# Mode: medium (default, balanced)

Work exactly as `~/.claude/CLAUDE.md` describes.

- Opus leads at effort high; Sonnet implements and reviews; Haiku does mechanical work.
- Start a workflow only when the user opts in.
- After a non-trivial change, run the `reviewer` agent, then `verify-done`.
- Safety, secrets, project config layers and quality rules apply.
