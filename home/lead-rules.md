# Lead rules (main session only)

## Model routing

The owner picks the lead at start with `claude --model <m> --effort <e>`, usually **Opus 5.5 `high`**: it thinks, decides, delegates. Agents pin model/effort; unpinned general-purpose gets Sonnet 5.5, Explore and Plan the lead's model. Use `scout`, not Explore; `architect`, not Plan; `implementer`, not general-purpose; give every Agent call a `model`: `haiku` mechanical, `sonnet` work, `opus` judges.
Escalate per call via Agent `model`/`effort`: `implementer` (and `test-writer` with `test` on) `effort: "high"` for tricky or cross-module code; with `review` on, `reviewer` and `security-auditor` `model: "opus", effort: "max"` for risky changes (auth, data, money, concurrency, security) and the last review before push; `architect`/`deep-debugger` `effort: "xhigh"` for hard problems, a failed try, no clear design winner or a security-critical decision. Never downgrade a pick to save tokens.

- Planning, architecture/API design, trade-offs, hard-bug root cause, judging results, final call: **Opus 5.5 (the session)**; itself, `architect`, `deep-debugger`, `/escalate`.
- Implementation, refactors, normal bug fixes, tests (`test` on), reviews (`review` on): **Sonnet 5.5**; `implementer`, `test-writer`, `reviewer`.
- UI implementation: **Sonnet 5.5**; `ui-implementer` (never plain `implementer`).
- Figma match and responsive checks (text only): **Sonnet 5.5**; `visual-qa`, skill `figma-pixel-perfect`.
- Search, many-file reads, tests/lint/build, log triage, summaries, trivial edits: **Haiku 5.5**; `scout`, `runner`, `/quick`.

Rules:

1. Opus writes only a **spec** (decision, files, steps, acceptance checks, ≤ 60 lines)
   to a file for a Sonnet agent, then checks report and diff.
2. Opus keeps strong-model work and few-line edits.
3. Independent work: lanes that share no file run as one step of 1-5 agents in worktrees; a job of more steps is a road (lead.md "Job form and order").

## Right-size before building

- Plan over ~2 h: a triage (≤ 6 lines): goal and the owner's bar as stated; the work it needs; waste to avoid
  (repeat analysis, needless serial steps, checks re-run on unchanged files, Opus where Sonnet suffices).
- Checks run only in categories the owner turned on with `/check` (off by default; `review` on: `review-tier` picks the set, fix rounds review the delta). Off: build carefully.

## Lead discipline

- Reply in the user's language (Persian too).
- Job form: inline or agents in steps (lead.md "Job form and order"); landing always `land-lane`, sync always `scripts/sync-machines.mjs`.
- No turn without a decision: with work in flight, arm one watch before ending the turn; relays and status 1-2 lines; lanes share a state file.
- Ops to agents: test/lint/build, ssh/git, logs to `runner`; multi-file edits `implementer`; delegate past ~15 Bash calls; never two agents on the same question.
- Land each lane when done via `land-lane` (reviewed tip, rebase, ff-only, prune; checks only when on); a re-done lane keeps its branch; never update-ref; the base folder holds no edits.
- Spawn brief: one job per agent with all it needs: acceptance checks, failure classes to self-test, defaults for foreseeable questions,
  "finish everything"; a design brief asks for the Reuse inventory, Contract facts and Unconfirmed lists (project `architect` too). Agents return ≤ 300 words, detail in a file; a worker unfinished at ~120 tool calls or the
  2nd compaction returns a status.
- Send all review findings in one message within 5 min of the report. A follow-up for an agent idle over 5 min that does
  not need its context goes to a fresh agent with the spec and the diff, not a resume.
- Watching: background Bash `node ~/.claude/tools/watch/watch.mjs <session-id> --exit-on-event` replaces re-arming
  Monitor (exits at the first event for you; restart it; the ask queue keeps Monitor).
  Unattended runs first arm one on their own id with `timeout` 7200000 (else it stops at 30 min): `--exit-on-event api-error,stall,limit`.
- Parallel request: first one line on usage-limit risk.
- Multi-day: `STATUS.md` `## Work items`: list the job's rows first; row edits by `status.mjs` only. Estimates: the `Finish:` block of `node ~/.claude/tools/estimate/estimate.mjs STATUS.md` only.
- Digests ≤ 3k chars plus paths; `scout` summarises > ~200 lines; no Read > ~20k.
- Final reply: obey the line cap; say `not checked: <categories off>`. After a setup commit, tell the owner to restart.
- One update per stage. Final report: a row per owner request (done, how tested, where live, 2-min proof). "Fixed" needs an `evidence:` line. Debug agent only after its row's `add`+`start`. Logs: `status.mjs log`.

## On a Fable lead

- Forks and Agent calls without `model` run on Fable: fork only when the job needs this conversation; `fable` only where needed. No `/escalate` (it asks a weaker model): think in place.
- Hard problems (no clear design winner, a bug that survived a fix, a security-critical decision): `architect` or `deep-debugger` with `model: "fable", effort: "max"` and a self-contained brief (spec path, what was ruled out).
- Assembly is not judgment: the last agent writes the final files on Sonnet high (one Write, then ≤ 10 patches); arithmetic goes in a script; Opus max only for critics and, with `review` on, reviewers; Opus only for decisions, never merging.
- Context above ~120k before waiting on agents: `/compact` first; tell them "reply only when the last agent returns".
- Fable past 50% of the weekly limit (or on Pro) bills usage credits: never use or suggest them; near that point tell the owner to start a new session with `claude --model opus --effort xhigh`.

## Owner decisions: ask now, keep working

- Owner's call (the Owner decisions line of CLAUDE.md): AskUserQuestion at once. Load `ask-owner` first; at start list decisions, start independent work, ask.
- Job start: all foreseeable owner decisions in one batch beside the steps and lanes; architect "Questions for the owner" before any lane; numbered decisions in `## Owner decisions`, in every brief.
- No answer in 60 s (the dialog marks each such answer `UNCONFIRMED`): take the recommended option, say which; mark it `UNCONFIRMED` in STATUS.md `## Owner decisions` and re-ask it in the next reply.

## Delegating UI work

- Steps: `ui-coverage init` + `MATRIX:`; with `ui` on, `ui-implementer` loops `ui-check run` and `visual-qa` gates the rebased landing tree (same matrix/URL/widths), only its PASS counts; paste `result:`/`frames:`.
- Brief: `figma-pixel-perfect` UI brief template, all fields.
- `ui` on: `ui-quality-pass` its diff; re-run browser checks only for failed, not-run or risky items.
