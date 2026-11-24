# 0002: Team split (one part builder per call, tess as a manager, tests only in tess)

- Status: accepted. Date: 2026-11-25. Number: 0001 is taken by the Bash guard record on its lane; renumber at land if needed.

## Context

Most of the spend in a day of lanes (2026-11-24) was Opus subagents whose every turn re-read 100-230k tokens of context. The
full test suite (about 3 minutes alone, 4 when two ran at once) ran several times on the same tree: dev ran it, then tess ran it
again, and two lanes ran it at the same time. dev did whole lanes itself, so mechanical and clear parts ran in a big Opus context.

Drivers: (D1) accuracy: no weaker check, quality equal to an Opus build; (D2) tokens per job; (D3) wall time, test waits
included; (D4) simplicity: few agents, readable rules; (D5) the boss's context stays small.

## Options

| Option | D1 | D2 | D3 | D4 | D5 |
|---|---|---|---|---|---|
| A. Keep the agents; add only the simplicity text and "related tests in dev" | good | ok (no context relief) | ok | good | good |
| B. One part builder `dev-part` (Sonnet pin, Opus per call) + `tess-simple` + the `suite` queue; dev checks every result | good | good | good | ok (2 agents, 1 tool) | good |
| C. Two part-builder files (Sonnet, Opus) | good | good | good | worse (one body twice, more names in lists) | good |
| D. Many helpers (per-area writers, per-class reviewers, a test fixer, a mapper, a runner) or agent teams | ok (more hand-offs) | bad (teams use many times the tokens) | ok | bad | ok |

## Decision

B, with the owner's later decisions:

- dev splits its job into parts that each own their files, with no cap on helpers; parts that share a file run one after
  another. `dev-part` is pinned to Sonnet 5.5 high and raised per call to `model: "opus"` and/or `effort: "xhigh"` for an
  important, risky or hard part. dev may write any part itself and reads every helper's diff against its brief before taking it.
- Tests and checks belong to tess and its helpers only; dev and its helpers build. tess is an Opus 5.5 high manager: `dev-run`
  (Haiku) runs the checks, `tess-edge`, `tess-write` and `tess-simple` (Sonnet) probe, write tests and review simplicity,
  `tess-review` (Opus) reviews against the spec; tess keeps the judgement and the `landing:` verdict.
- lex stays Opus 5.5 high; the boss raises it to xhigh or max for a hard design or an unclear need. Lookups and web facts go to
  lex-scout and lex-web.
- Full suites, installs and builds go through `suite run` (one queue per machine, 1 slot by default); a full suite runs once per
  tree (`--cache`).

A loses on D2: text alone does not move work out of a big context. C loses on D4 for no gain: the per-call model passes the
agent guard's pin floor, and Fable is denied. D loses on D2 and D4 and puts D1 at risk.

## Consequences and reversal signals

- dev's report carries `helpers: <n> (<model>/<effort> each)`, tess's report `simplicity:` and `helpers:`, so the split can be
  measured.
- Reverse or adjust when, after two weeks, the `helpers:` lines show dev delegating less than once per lane, or tess-review finds
  more must-fix findings in Sonnet-built parts than in Opus- or dev-built ones (then move that kind of part to `model: "opus"`).
- Not measured yet: the savings, Sonnet part quality against an Opus build, and tess on Opus as a manager against the old Sonnet
  tess running its own commands.

## Sources

- Claude Code docs, sub-agents: per-call `model` (an alias) overrides the agent file's `model`; `omitClaudeMd`; subagent nesting.
- Claude Code docs, Bash and Monitor tools: background commands, completion notices, `timeout` up to 7200000 ms.
- Local probes on the agent guard (agent-model-guard with the pin floor): `model: "opus"` on dev-part kept, `"fable"` denied,
  `"haiku"` and `effort: "medium"` dropped to the pin.
- Measured suite times and duplicate runs from the 2026-11-24 transcripts; `home/tools/suite/README.md` (slot measurement).
