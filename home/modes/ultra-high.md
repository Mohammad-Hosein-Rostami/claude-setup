# Mode: ultra-high (lead Fable 5.2; the boss decides, others do the work)

Same quality gates as every mode. The lead is Fable 5.2 at effort high (`ccm ultra-high`): it decides and delegates.

- Fable keeps (it has the context): the plan, key decisions, specs (<= 60 lines, to a file), judging reports and diffs, the root cause when agents disagree or a fix failed, the final call; few-line edits only when briefing costs more.
- Fable never does what an agent does as well: reading beyond small ranges (`scout`), checks or logs (`runner`), implementation (`implementer`/`ui-implementer`), screenshot loops (`visual-qa`), polling, a second review of one diff.
- Hard problems get more Fable (no clear design winner, a bug that survived a fix, a security-critical decision): run `architect` or `deep-debugger` with `model: "fable", effort: "max"` and a self-contained brief (spec path, what was ruled out). Opus max for risky or final reviews, security audits and cross-module code (independent second model). Else pinned models.
- No hidden Fable: forks and Workflow `agent()` without `model` run on Fable; the guard pins unpinned Explore and general-purpose to Sonnet, Plan to Opus. Use `scout` not Explore, `architect` not Plan; fork only when the job needs this conversation; give every Workflow `agent()` a `model` (`haiku` mechanical, `sonnet` work, `opus` judges, `fable` where needed). No `/escalate`: think in place.
- Cheap turns: batch independent calls in one message; agents return <= 200 words with file:line evidence.
- Lens agents: continue only reachable items, max 1 continuation.
- Workflow assembly is not judgment: the last phase writes the final files on Sonnet high (one Write, then ≤ 10 patches); arithmetic goes in a script; Opus max only for reviewers and critics; Opus general-purpose only for decisions, never merging.
- Context above ~120k before waiting on agents: `/compact` first; tell them "reply only when the last agent returns".
- Lane budget: up to 8 agents at once. Workflows as in high: Claude starts one itself for substantive multi-part tasks (`ccm ultra-high` or `/mode ultra-high` is the user's standing request).
- Launch: `ccm ultra-high`; hardest work `CCM_LEAD_EFFORT=xhigh` or `max`. The hook note names the fix when the lead does not match.
- Fable is on Max/Ultra/Team Premium plans up to 50% of the weekly limit; beyond that (or on Pro) it bills credits: never use or suggest them; near the cap, tell the user to run `ccm extra-high -c`.
- Kept: Safety, secrets, project config layers, confirm before push/publish/delete.

Applies to this session only.
