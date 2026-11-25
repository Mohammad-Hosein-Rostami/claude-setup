# 0005: Final pass over the agents: fix what the evidence shows, measure the rest

- Status: accepted (the owner still decides whether the 7-day limits log goes). Date: 2026-11-25.

## Context

After the team split, every agent and helper was read once more against real use: the transcripts of 2026-11-24 and
2026-11-25 (the numbers are in `docs/token-optimization.md`, "Measured"), a fresh session's `/context`, and the token cost of
each preload and listed skill. Some defects need no more data:

- dev preloaded four skills (about 10 KB at every start, re-read every turn), max three, lex three; most runs need one.
- Eight built-in skills that only the owner starts were listed to the model in every session and agent (about 1.2k tokens).
- lex-web and lex-scout went over their line caps in most runs (median about 800 words).
- tess-review and tess-simple stopped at 8 findings, which cuts recall; tess already filters and counts.
- The playwright browser server was unpinned (`@latest`) and chrome-devtools was pinned to an old release.
- `docs/token-optimization.md` named the old model routing.

Other questions (do helpers get used, does tess on Opus pay off, how often tess-write's tests are vacuous) cannot be answered
yet: no run of the split team existed when this was written.

Drivers: accuracy (no weaker check), evidence for every change, a small boss context, nothing built that real use has not
asked for, one writer per file across the open lanes.

## Options

| Option | accuracy | evidence | small boss context | no needless build |
|---|---|---|---|---|
| X. One lane with every proposed change, the unmeasured ones guessed | ok | bad (guesses) | good | bad |
| Y. Fix the evidenced defects now, add a usage script, decide the rest from real use with fixed rules | good | good | good | good |
| Z. Change nothing until real use | good | good | good | good, but known defects stay for weeks |

## Decision

Y. Now: each agent preloads only the skills every run of it needs (dev `clean-code`, max `ship-readiness`, lex
`tradeoff-analysis` and `tech-research`), and dev names the skills a part needs in its brief (`skills:`); `skillOverrides`
hides the eight owner-only built-ins from the model (`/name` still works); helper caps are in words; review findings have no
cap; both browser servers are pinned (`@playwright/mcp@0.0.86`, `chrome-devtools-mcp@1.14.0`); tess gains the `e2e` check.
Later: after three days or five jobs of real use, `node scripts/agent-usage.mjs` gives the numbers for the decision rules
M1-M10 of the final-pass plan (section 7), and only a rule that fires gets a change.

X loses because it builds on guesses. Z loses because it leaves defects that need no measurement.

## Consequences

- Good: about 2.5k fewer tokens at each dev start, 2.7k at each max start, 1.1k at each lex start, 1.2k in every session and
  every agent with the Skill tool; browser servers change only when someone edits the pin; the follow-ups are measured.
- Bad: a part may miss a skill dev forgot to name (the descriptions stay listed, so the part can still load it, and
  tess-review flags date and refactor errors); tess's detail file grows with uncapped findings.
- Unproven: whether `skillOverrides` applies to `init` and `security-review` (built-in commands); `/context` after install
  shows it.

## Reversal signals

- A rule M1-M10 fires.
- tess-review finds in two jobs that a dropped preload was needed.
- A review returns more than 30 findings twice: cap follow-ups only (must-fix is never capped).

## Sources

- Claude Code skills, "Override skill visibility from settings": https://code.claude.com/docs/en/skills (read 2026-11-25);
  the settings schema in the installed Claude Code 2.1.330.
- Claude Code sub-agents (`skills:` preloads, `omitClaudeMd`): https://code.claude.com/docs/en/sub-agents
- Model configuration and effort: https://code.claude.com/docs/en/model-config
- Anthropic, prompting Claude Opus 5 (report everything, filter in a separate pass), on platform.claude.com, as cited in the
  final-pass plan, section 5.
- npm registry, `npm view @playwright/mcp version` and `npm view chrome-devtools-mcp version` (2026-11-25).
