---
name: token-audit
description: Audit where tokens go in this project's Claude setup - instruction files, rules, skills, agents, MCP servers - and propose concrete cuts. Use periodically or when sessions feel expensive.
disable-model-invocation: true
model: sonnet
effort: medium
allowed-tools: Bash(node *) Read Grep Glob
---

1. Run `node ~/.claude/hooks/token-audit.mjs` from the project root. It prints byte/line
   sizes (≈ tokens = bytes/4) of every always-loaded file, path-scoped rule, skill
   description, agent, and `.mcp.json` server.
2. Ask the user to run `/context` and `/usage` if they have not (you cannot see them).
3. Report, ranked by recurring cost: always-loaded files over 200 lines, rules without
   `paths:`, skill descriptions over 300 chars, MCP servers unused in recent work, and any
   `Read`-heavy directories (sessions, lockfiles, generated output).
4. Propose cuts as concrete edits. Apply only the ones the user approves.
