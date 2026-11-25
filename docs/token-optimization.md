# Token optimisation

Cost is tool calls x context size: every call re-reads the whole conversation. This setup cuts both.

| Lever | Where | Effect |
| ----- | ----- | ------ |
| Model routing | agent files (`model`, `effort`), `settings/base.json` (`model`) | The Opus session (the boss) routes and delegates. Opus 5.5: `lex`, `dev`, `tess`, `max`, `dev-ui`, `dev-pixel`, `dev-debug` (`xhigh`), `tess-review`. Sonnet 5.5: `dev-part`, `dev-docs`, `lex-web`, `pixel-qa`, `tess-simple`, `tess-edge`, `tess-write` (a caller may raise `dev-part`, `dev-docs` or `tess-write` to Opus per call). Haiku 5.5: `lex-scout`, `dev-run`. Every pin is `high` unless named. The boss leaves model and effort out of an Agent call unless it raises one; the agent guard drops a lower per-call value. Built-ins have no agent file: the guard gives `general-purpose` and `Explore` `sonnet`, `Plan` `opus` |
| Effort per model | `settings/base.json` `modelSettings` | Opus high, Sonnet medium, Haiku medium (low stops early and skips checks) for sessions and built-ins; an agent file's `effort` wins for that agent, and every agent file pins `high` (`dev-debug` `xhigh`), so no agent runs at medium; the pin is a floor. Opus 5.5 at `medium` already beats Opus 5 at `high`; `effort: "xhigh"` or `effort: "max"` only for a measured gain |
| Compaction | `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` (400000) | Opus 5.5 / Fable 5.2 have 1M, and with no window set Claude Code compacts them at about 967K; 400K compacts earlier and keeps each turn's re-read smaller (owner choice, 2026-11-14) |
| Short skill descriptions | `home/skills/*/SKILL.md` | Descriptions are loaded every session; bodies only when triggered |
| Preload only what every run needs | agent files (`skills:`) | A preloaded skill loads its whole body at every start and is re-read every turn. An agent preloads only the skills every run of it needs (dev: `clean-code`; max: `ship-readiness`; lex: `tradeoff-analysis`, `tech-research`); the rest load on demand from their listed descriptions, and dev names the ones a part needs in its brief (`skills:`). Measured 2026-11-25: about 2.5k tokens fewer at each dev start, 2.7k at each max start, 1.1k at each lex start |
| Owner-only skills hidden from the model | `settings/base.json` `skillOverrides` | The built-in skills only the owner starts (`code-review`, `fewer-permission-prompts`, `init`, `keybindings-help`, `security-review`, `ship-local` (`/ship`), `steward`, `update-config`) are `"user-invocable-only"`: not listed to the model (about 1.2k tokens in every session and every agent with the Skill tool), and `/name` still works. Plugin skills ignore this key |
| Helper caps in words | `lex-web.md`, `lex-scout.md` | The brief's word cap, else 250 (lex-web) or 200 (lex-scout, a map 500); a long report stays in its caller's context for the rest of its run |
| Path-scoped rules | `home/rules/*.md` `paths:` | Rules load only when matching files are in play |
| Subagents with short reports | `home/agents/*.md` | Return summaries (at most 150 words to the boss, a helper's own cap to its caller) instead of raw output; no `maxTurns`, so they never stop at a turn cap (a capped agent returns a partial result that has to be resumed) |
| Status line | `home/statusline.mjs` | Shows context size in tokens (green < 60k, yellow < 150k, red above), cost, 5h/7d usage |
| Figma via REST | `ui-check figma-pull` | Baseline and exact geometry fetched with zero MCP tokens |
| Reports instead of images | `ui-check compare` / `responsive`, `pixel-qa` agent | The model reads a <= 40-line `report.md`, not screenshots |

## Measured (2026-11-24 to 2026-11-25, before the team split landed)

From the transcripts under `~/.claude/projects/`; re-run with `node scripts/agent-usage.mjs --since <iso>`.

| Agent | runs | cold start (mean) | context read per run (mean) | turns per run (mean) | report words (median) |
| ----- | ---- | ---------- | -------------------- | ------------- | --------------------- |
| dev | 34 | 29.4k | 22.0M | 147 | 114 |
| tess (then Sonnet) | 20 | 22.8k | 7.4M | 84 | 105 |
| tess-review | 17 | 11.8k | 6.3M | 74 | 289 |
| tess-write | 17 | 20.8k | 5.1M | 65 | 254 |
| lex | 8 | 25.4k | 9.6M | 77 | 207 |
| lex-web | 16 | 6.3k | 1.5M | 36 | 837 |
| lex-scout | 9 | 5.2k | 2.5M | 47 | 743 |

- A fresh main session in this repo starts at 15.9k tokens (`/context`): system 2.4k, tools 2.1k, agents 1.1k, memory files
  3.3k, skills 6.5k.
- 25% of dev's turns were above 200k of context; cache rebuilds after a gap of more than 5 minutes were 0.5% of dev's reads, so
  the subagent cache stays at 5 minutes.

No hard limits: there are no turn, step, retry or output caps. Caps stop runs mid-task and cost more in redone work
than they save; cost is steered by the levers above instead. Bash and MCP output use the CLI defaults (30000 chars;
25000 tokens): larger output is saved to a file and Claude gets a preview plus the path, so nothing is lost.

Habits: search before reading, read ranges, batch independent calls, one task per session, `/clear` between unrelated
tasks, `/compact` at a natural seam, hand specs over by file path.
