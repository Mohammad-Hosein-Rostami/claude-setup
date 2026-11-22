---
name: token-audit
description: Audit where tokens go - the setup's always-loaded text, skills, agents, plugins and MCP servers, and from the transcripts the use per account, role and lane, cache, compactions and waste - and propose concrete cuts. Use periodically or when sessions feel expensive.
disable-model-invocation: true
context: fork
effort: medium
allowed-tools: Bash(node *) Bash(claude plugin *) Read Grep Glob
---

This runs as a fork (`context: fork`) on the session's model, so the main session keeps its prompt cache. Read-only: you change
no file; you report and propose.

1. Setup text: run `node ~/.claude/hooks/token-audit.mjs` from the project root. It first prints two totals, `main session
   start` and `agent start`, each naming every part counted and every part not counted; the start hooks' text (lead text, lead
   rules) is counted by running the hooks in a throwaway HOME, and a total with a hook missing, failing or past 5 s says
   "at least"; the checkpoint digest and an agent's compaction note show 0 ("only after a compaction"). Then it prints
   byte/line sizes (≈ tokens = bytes/4) of every always-loaded file, path-scoped rule, skill description, agent and
   `.mcp.json` server, and each project's `MEMORY.md` size. `node ~/.claude/hooks/token-audit.mjs --budget` gives the budget
   status (the lead text against its 10,000-char SessionStart cap); `scripts/doctor.sh` prints the same lines.
2. Use: run `node ~/.claude/tools/token-view/token-view.mjs` (7 days; `--days N`, `--project <text>`, `--detail`, `--json`). It
   prints (a) the limits against time per account, (b) the use per role (agent type) with each role's start tokens, and per
   lane, (c) cache reads, writes and rebuilds after an idle gap, the context peak and compactions per session against the
   compaction point, (d) waste (failed or cut-off runs, `rework` runs, review rounds after the first, duplicate starts; each rule
   is printed beside its count), (e) general-purpose spawns per day.
3. Plugins: `claude plugin details <name>` for each enabled plugin (a local command); report its size lines.
4. Native `/usage` and `/context` cover this machine's session only (under a setup token `/usage` shows no model bars), so do
   not repeat them; ask the owner to run `/context` only when a figure above needs it.
5. Report, ranked by recurring cost: start tokens per agent type, the largest always-loaded parts, compactions, waste, each
   project's `MEMORY.md` size, always-loaded files over 200 lines, rules without `paths:`, skill descriptions over 300 chars and
   MCP servers unused in recent work. No dollar figures, except in a detail view, labelled "API-price equivalent".
6. A `MEMORY.md` trim (for example the bill-gin one): show the owner the duplicate or near-duplicate lines read-only, with the
   file path, and ask before any trim; trimming is the owner's decision, never done here.
7. Propose cuts as concrete edits; the session applies only the ones the owner approves.
