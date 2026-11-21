# Mode: ultra-high (lead Fable 5.2; the boss decides, others do the work)

Same quality gates as every mode. The lead is Fable 5.2 at effort high (`ccm ultra-high`): it decides and delegates.

- Fable keeps (it has the context): the plan, key decisions, specs (<= 60 lines, to a file), judging reports and diffs, the root cause when agents disagree or a fix failed, the final call; few-line edits only when briefing costs more.
- Fable never does what an agent does as well: reading beyond small ranges (`scout`), checks or logs (`runner`), implementation (`implementer`/`ui-implementer`), screenshot loops (`visual-qa`), polling, a second review of one diff.
- Hard problems get more Fable (no clear design winner, a bug that survived a fix, a security-critical decision): run `architect` or `deep-debugger` with `model: "fable", effort: "max"` and a self-contained brief (spec path, what was ruled out). Opus max for risky or cross-module code.
- No hidden Fable: forks and Workflow `agent()` without `model` run on Fable; fork only when the job needs this conversation; `fable` in `agent()` only where needed. No `/escalate`: think in place.
- Agents return <= 200 words with file:line evidence.
- Lens agents: continue only reachable items, once; what is still left goes to a fresh agent.
- Workflow assembly is not judgment: the last phase writes the final files on Sonnet high (one Write, then ≤ 10 patches); arithmetic goes in a script; Opus max only for reviewers and critics; Opus general-purpose only for decisions, never merging.
- Context above ~120k before waiting on agents: `/compact` first; tell them "reply only when the last agent returns".
- Lane budget: up to 5 agents at once (writing agents, test-writers included, at most 5 per road step; reads, reviews and verifiers are not capped by the mode).
- Fable past 50% of the weekly limit (or on Pro) bills credits: never use or suggest them; near the cap, tell the user to run `ccm extra-high -c`.

Applies to this session only.
