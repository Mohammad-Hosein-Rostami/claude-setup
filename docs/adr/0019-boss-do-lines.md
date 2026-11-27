# 0019: The tools print the boss's steps

- Status: accepted. Date: 2026-11-27. Builds on 0010, 0014, 0017, 0018.

## Context

The round-loop rules were right but not followed under load: on 2026-11-26 the boss made 22 lands with 1 tick, cut every land
output, and missed 22 failed syncs; another project's session had 6 ticks for 57 lands and about 30 snapshots left locked. Several plans
ran at once while the tick took one. Owner asks for status were answered from memory.

## Options

A sharper rules only; B tools print every step (`do` lines, land prints the tick, `board start`, remembered plans, holds, a sync
record); C an autopilot that lands, claims and releases by itself. Drivers: every land followed by a tick; no hand-built
command; small boss context; state survives compaction; simple.

## Decision

B. The boss runs what the tick prints and keeps every judgement (what lands, what goes to the owner). A lost on measurement; C
lands without reading the report and widens one bug to every lane.

## Consequences

Good: the loop is one command after each report; status comes from files (plans, ledger, marks, board, sync record) after any
compaction; releases and syncs stay visible. Bad: six small board modules more; the tick's output format changes (tests and
docs move with it); a broken tick now also hides the next steps (each part fails alone, the base line still prints).

## Reversal

If on the next 3 jobs the boss still skips printed steps (agent-usage B1 under 0.9 ticks per land, or B2 above 0), move to C for
the mechanical steps only (release, sync). If the printed commands fail in use (any do-line command exits 2), fix the tick first.

## Sources

anthropic.com/engineering/building-effective-agents (2024-12-19); anthropic.com/engineering/effective-context-engineering-for-ai-agents
(2025-09-29); anthropic.com/engineering/multi-agent-research-system (2025-06-13); dora.dev/capabilities/working-in-small-batches
(2025-12-08); the transcript counts in plan-core-best.md section 2.
