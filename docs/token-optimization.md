# Token optimisation

Cost is tool calls x context size: every call re-reads the whole conversation. This setup cuts both.

| Lever | Where | Effect |
| ----- | ----- | ------ |
| Model routing | `home/CLAUDE.md`, `settings/base.json` (`model`) | The Opus session plans, decides and delegates; Sonnet agents implement and review; Haiku looks things up and runs commands; unpinned agents default to Sonnet (`CLAUDE_CODE_SUBAGENT_MODEL`) |
| Effort per model | `settings/base.json` `modelSettings` | Opus high, Sonnet medium, Haiku low. Opus 5.5 at `medium` already beats Opus 5 at `high`; `xhigh`/`max` only for a measured gain |
| Output caps | `env.BASH_MAX_OUTPUT_LENGTH` (12000), `env.MAX_MCP_OUTPUT_TOKENS` (15000) | Bounds what each call adds to context |
| Compaction | `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` (200000) | Compacts before context gets costly |
| Short skill descriptions | `home/skills/*/SKILL.md` | Descriptions are loaded every session; bodies only when triggered |
| Path-scoped rules | `home/rules/*.md` `paths:` | Rules load only when matching files are in play |
| Subagents with caps | `home/agents/*.md` | Return summaries (for example 20 lines) instead of raw output |
| Status line | `home/statusline.mjs` | Shows context size in tokens (green < 60k, yellow < 150k, red above), cost, 5h/7d usage |
| Token audit | `token-audit` skill, `home/hooks/token-audit.mjs` | Approximate recurring token cost (bytes / 4) of the config |
| Figma via REST | `ui-check figma-pull` | Baseline and exact geometry fetched with zero MCP tokens |
| Reports instead of images | `ui-check compare` / `responsive`, `visual-qa` agent | The model reads a <= 40-line `report.md`, not screenshots |

Habits: search before reading, read ranges, batch independent calls, one task per session, `/clear` between unrelated
tasks, `/compact` at a natural seam, hand specs over by file path.
