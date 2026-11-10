---
name: tradeoff-analysis
description: Use when a design choice has two or more credible options (datastore, queue, sync vs async, build vs buy) - compare them, pick one, record an ADR.
---

Skip choices with one sensible default; say so in one line.

1. **Decision and drivers**: one sentence for the decision, then the 3-5 requirements or quality scenarios that decide it (latency, consistency, cost, team skill, operability). Drivers come from stated requirements, not taste.
2. **Options**: at most 3, always including "do the simplest thing". For each: cost, what it breaks, what it enables, how it fails.
3. **Score** each option per driver (good / ok / bad) in a small table. A driver every option meets decides nothing: drop it.
4. **Choose**, and say why the others lose in the driver's words. Name the assumption and the signal that would reverse the choice.
5. **Record** as an ADR in the repo's existing ADR folder (default `docs/adr/NNNN-<slug>.md`): Status, Context, Options, Decision, Consequences (good and bad), Sources (X3).
6. Check: could a newcomer disagree using only the ADR? If yes, drivers or reversal signal are missing.

For library or service facts, use `tech-research` first.
