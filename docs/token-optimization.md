# Token optimisation

Cost is tool calls x context size: every call re-reads the whole conversation. This setup cuts both.

| Lever | Where | Effect |
| ----- | ----- | ------ |
| Model routing | `home/modes/_lead.md` (printed to the lead at SessionStart), `settings/base.json` (`model`) | The Opus session plans, decides and delegates; Sonnet agents implement and review; Haiku looks things up and runs commands. Unpinned `general-purpose` runs on Sonnet via `CLAUDE_CODE_SUBAGENT_MODEL`; the built-in `Explore` and `Plan` agents use the lead's model |
| Effort per model | `settings/base.json` `modelSettings` | Opus high, Sonnet medium, Haiku medium (low stops early and skips checks). Opus 5.5 at `medium` already beats Opus 5 at `high`; `xhigh`/`max` only for a measured gain |
| Compaction | `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` (400000) | Opus 5.5 / Fable 5.2 have 1M; 400K keeps ~4x more work between compactions at ~1.9x per-turn read cost (owner choice, 2026-11-14) |
| Short skill descriptions | `home/skills/*/SKILL.md` | Descriptions are loaded every session; bodies only when triggered |
| Path-scoped rules | `home/rules/*.md` `paths:` | Rules load only when matching files are in play |
| Subagents with short reports | `home/agents/*.md` | Return summaries (for example 20 lines) instead of raw output; no `maxTurns`, so they never stop mid-task |
| Status line | `home/statusline.mjs` | Shows context size in tokens (green < 60k, yellow < 150k, red above), cost, 5h/7d usage |
| Token audit | `token-audit` skill, `home/hooks/token-audit.mjs` | Approximate recurring token cost (bytes / 4) of the config |
| Figma via REST | `ui-check figma-pull` | Baseline and exact geometry fetched with zero MCP tokens |
| Reports instead of images | `ui-check compare` / `responsive`, `visual-qa` agent | The model reads a <= 40-line `report.md`, not screenshots |

No hard limits: there are no turn, step, retry or output caps. Caps stop runs mid-task and cost more in redone work
than they save; cost is steered by the levers above instead. Bash and MCP output use the CLI defaults (30000 chars;
25000 tokens): larger output is saved to a file and Claude gets a preview plus the path, so nothing is lost.

Habits: search before reading, read ranges, batch independent calls, one task per session, `/clear` between unrelated
tasks, `/compact` at a natural seam, hand specs over by file path.
