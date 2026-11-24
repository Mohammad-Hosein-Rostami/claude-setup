# Token optimisation

Cost is tool calls x context size: every call re-reads the whole conversation. This setup cuts both.

| Lever | Where | Effect |
| ----- | ----- | ------ |
| Model routing | agent files (`model`, `effort`), `settings/base.json` (`model`) | The Opus session (the boss) routes and delegates; `lex`, `dev`, `dev-ui`, `dev-pixel`, `dev-debug` and `tess-review` run Opus 5.5 (RC2); `tess`, `lex-web` and `pixel-qa` run Sonnet; `lex-scout` and `dev-run` run Haiku. The boss leaves model and effort out of an Agent call unless it raises one; the agent guard drops a lower per-call value. Built-ins have no agent file: the guard gives `general-purpose` and `Explore` `sonnet`, `Plan` `opus` |
| Effort per model | `settings/base.json` `modelSettings` | Opus high, Sonnet medium, Haiku medium (low stops early and skips checks); an agent file's `effort` wins for that agent (`dev-pixel` is `high`: the pixel-perfect path is never lowered). Opus 5.5 at `medium` already beats Opus 5 at `high`; `xhigh`/`max` only for a measured gain |
| Compaction | `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` (400000) | Opus 5.5 / Fable 5.2 have 1M, and with no window set Claude Code compacts them at about 967K; 400K compacts earlier and keeps each turn's re-read smaller (owner choice, 2026-11-14) |
| Short skill descriptions | `home/skills/*/SKILL.md` | Descriptions are loaded every session; bodies only when triggered |
| Path-scoped rules | `home/rules/*.md` `paths:` | Rules load only when matching files are in play |
| Subagents with short reports | `home/agents/*.md` | Return summaries (for example 20 lines) instead of raw output; no `maxTurns`, so they never stop at a turn cap (a capped agent returns a partial result that has to be resumed) |
| Status line | `home/statusline.mjs` | Shows context size in tokens (green < 60k, yellow < 150k, red above), cost, 5h/7d usage |
| Figma via REST | `ui-check figma-pull` | Baseline and exact geometry fetched with zero MCP tokens |
| Reports instead of images | `ui-check compare` / `responsive`, `pixel-qa` agent | The model reads a <= 40-line `report.md`, not screenshots |

No hard limits: there are no turn, step, retry or output caps. Caps stop runs mid-task and cost more in redone work
than they save; cost is steered by the levers above instead. Bash and MCP output use the CLI defaults (30000 chars;
25000 tokens): larger output is saved to a file and Claude gets a preview plus the path, so nothing is lost.

Habits: search before reading, read ranges, batch independent calls, one task per session, `/clear` between unrelated
tasks, `/compact` at a natural seam, hand specs over by file path.
