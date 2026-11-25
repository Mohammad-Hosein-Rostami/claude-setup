# 0003: A ship agent (max) and a docs writer (dev-docs)

- Status: accepted. Date: 2026-11-25.
- Superseded in part by 0008: no hook enforces the click on `max`'s dialog or the `owner-command:` rule any more; both stay as
  instructions.

## Context

Release and production work had no owner: dev only builds, tess only checks, and nobody gave the go/no-go or wrote the release
and rollback commands. Docs and user-facing text were written last, if at all, with no shared rules for error messages, help
or CLI output. A first proposal gave one agent integration, performance, architecture and incidents, plus a separate reviewer
agent for clarity; most of that already has an owner.

Drivers: (D1) accuracy and safety of outward actions (push, publish, deploy, production writes); (D2) no duplicate owner per
duty; (D3) simplicity: few agents, few lines; (D4) cost: rare Opus runs, a cheap writer; (D5) the boss's context stays small.

## Options

| Option | D1 | D2 | D3 | D4 | D5 |
|---|---|---|---|---|---|
| A. No new agents: a `ship-readiness` skill dev loads, docs rules in clean-code | ok (no one owns the go/no-go) | ok | good | good | good |
| B. `max` main agent (rare, Opus, own slots) + `dev-docs` helper (Sonnet) + two skills + deploy asks | good | good | ok (2 agents, 2 skills) | good | good |
| C. As proposed: max does integration, performance, architecture and incidents itself; a reviewer agent after dev | ok | bad (overlaps tess, lex, dev-debug, the UI skills) | bad | bad (two more Opus runs per job) | ok |

## Decision

B, with the owner's decisions (2026-11-25):

- `max` (Opus 5.5 high; never Fable) runs one job and ends: the `ship-readiness` review, the release gaps closed (code gaps
  through `dev-part`, notes through `dev-docs`), the built artefact checked in a production-like local run, and the exact
  outward and rollback commands written. Then it stops. The owner pushes, deploys and publishes himself. max runs an outward
  action only on an `owner-command:` brief line, which the boss writes from the owner's own chat words, and only a click runs
  its dialog for that action; while any max runs, every outward ask needs a click (the guard enforces both).
- max is started rarely: when the owner asks, or after a job's last land when lex's plan ends with `ship: <target>`. Never for a
  job whose result only lands, and never from a long-run step. It has its own 3 slots beside lex, dev and tess.
- `dev-docs` (Sonnet 5.5 high; Opus per call for migration notes, a public API reference or security text) writes the docs and
  user-facing text while the code is built, from the plan's interfaces. It returns `terms:` and `examples:`; tess runs the
  examples. Its rules are X5-X11 in `home/standards/docs.md` and the `docs-writing` skill.
- Every other duty of the proposal keeps its owner: integration (the boss and `land`), tests and review (tess), architecture
  (lex), UI quality (dev-ui and its skills), root causes (dev-debug).

A loses on D1: nobody would own the readiness verdict and the prepared release and rollback commands. C loses on D2 and D3, and
the owner rejected a separate reviewer agent.

## Consequences and reversal signals

- Assumption: a real ship is rare here; most jobs only land.
- Tighten max's auto cases when it runs on more than one job in five.
- Raise dev-docs's pin to Opus when tess-review finds X-rule issues in its output in two of five lanes.
- Add a checklist item when a `ship-ready: yes` is followed by a rollback twice.

## Sources

- Google SRE, production readiness review: https://sre.google/sre-book/evolving-sre-engagement-model/
- AWS operational readiness reviews: https://docs.aws.amazon.com/wellarchitected/latest/operational-readiness-reviews/the-orr-tool.html
  and https://docs.aws.amazon.com/wellarchitected/latest/operational-readiness-reviews/appendix-b-example-orr-questions.html
- Canarying releases: https://sre.google/workbook/canarying-releases/
- SemVer 2.0.0: https://semver.org/ ; Keep a Changelog: https://keepachangelog.com/
- Docs as code: https://www.writethedocs.org/guide/docs-as-code/ ; Diataxis: https://diataxis.fr/
- Error messages: https://developers.google.com/tech-writing/error-messages ; style: https://developers.google.com/style/highlights
- Command line interface guidelines: https://clig.dev/
- Claude Code sub-agents (frontmatter fields): https://code.claude.com/docs/en/sub-agents
