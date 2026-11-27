---
name: plan-writing
description: Use when writing a build plan and its pieces.json for dev and tess - the plan's sections, each piece's fields and test list, acceptance lines that can fail, and the contact check against the real code before handoff. Preloaded by lex.
---

A plan is done when dev can build each piece without a guess and tess can check it with commands. Plans fail on contact with
the code: a test or text that still pins the old behaviour, a new rule an existing case breaks, a caller left out, a check
that cannot fail. Ground each claim in a file you read or a command you ran; re-reading your own plan finds little.

## The plan file

`## ` sections in this order (`spec: <plan>#<section>` links to one):
1. Status: date, repo, base sha, and what landed or changed since (a re-plan edits the plan in place and says so here).
2. Decision and why (at most 8 lines). Decisions: each owner answer and each default taken, numbered, as
   `<question>: <answer> (owner | UNCONFIRMED, default)`.
3. Reuse inventory, Contract facts, the state design (locks, concurrency, security or data loss) and one `THREAT:` line per
   risky feature: the boundary each input crosses, what can go wrong there, the answer (mitigate, remove or accept) and the
   test that shows it.
4. Unconfirmed: each fact not checked, why it could not be, the default taken and the signal that reverses it. A fact a
   command or the installed docs can settle is checked, not listed.
5. Pieces, then Contact check, Pre-mortem, Risks, `needs-from-<owner>:` (changes only another plan or team may make), `ship:`.

## A piece

Who writes and runs a piece's tests is what dev.md and home/CLAUDE.md say today. Where dev edits no test, a piece whose Tests
add or change cases is test-first: tess-write commits them on `test/<id>` and frees that branch, the piece names it as
`branch`, and dev builds on it once that commit is there, without editing a test (the Pieces section tells dev so).

`### <id>: <outcome> (feature <f>, risk <classes or none>, qa <value>; after <ids>)`, then:
- Files: every file it changes, new ones marked `(new)`, with its tests and the docs, comments and help text it makes stale.
- Rule: one `old -> new` line per behaviour it changes (output, exit code, default, flag, refusal, format); `none` if none.
- Changes: one line per file; exact names, signatures (no bodies) and user-facing text.
- Tests: `new:` each case as given, action, observable result; `changed:` each `file:line` that pins an old rule, as
  `old -> new`; `stays:` the test files that must pass unchanged.
- Acceptance: commands with the exit each must return, run by tess on the base; each fails on the base or on a broken change.
- Edge cases, the P-ids of `~/.claude/rules/principles.md` that fit, `helpers:` (`dev-part <part> [opus]`) and their files.

One outcome per piece. An interface lands with its callers, tests and docs in the same piece, never in a later docs piece;
one too big for that goes expand, migrate, contract: add the new form, move the callers, then remove the old, each a piece.

## pieces.json

`<plan>.pieces.json` beside the plan (or the path the brief gives); `board tick` reads `job`, the features' `id` and `risk`,
and the pieces' `id`, `feature`, `files`, `after` and `branch`, and ignores the rest:

```json
{ "job": "<slug>", "repo": "<abs>", "base": "<40-hex>",
  "features": [{ "id": "login", "risk": "none | security,data,...", "qa": "<qa value>", "spec": "<plan path>#<section>" }],
  "pieces": [{ "id": "lgn-1", "feature": "login", "files": ["<repo-relative path>"], "after": ["<piece id>"],
               "waits": ["<branch of another job>"], "test": ["node", "--test", "tests/<file>"],
               "acceptance": "plan section <piece id>" }] }
```

`base`: the sha the plan was first written on (a re-plan keeps it). `branch`: only for a test-first piece or a `Fix:`.
`test`: the test command as a word list (`node`, `npm`, `npx`, `pnpm` or `yarn`, then flags and repo-relative paths).
`waits`: another job's branches that must land first; the tick does not read it yet, so the report names each for the boss.
No other field. Ids start with a short job prefix, and each piece's branch (`branch`, else `lane/<id>`) is new:
`git branch --list '<branch>'` and `grep -l '"branch":"<branch>"' ~/.claude/state/land/*.jsonl` print nothing.

## Contact check

Before the report; each result, with its command, goes in the plan's Contact check section.
1. Old forms: for each changed name, text, flag, exit code, default or rule, grep its old form in code, tests, docs, agent and
   skill text, READMEs and comments (an impact brief to `lex-scout` for a wide one), and find the test files that import,
   start or read by path the changed file; for a new rule, the rules already on its topic. Each hit is in a piece, under
   `changed:` or `stays:`, or named out of scope with why.
2. Callers and siblings: every caller of a changed interface (code, CLIs, the agent and rule text that tells someone to run
   it, the loop that runs it, its error and missing-input paths) and every other place that does the same operation.
3. Rules against cases: evaluate each new rule or predicate on every existing test case of its area, first the cases it
   must not match. A rule that can delete or overwrite data also gets a probe in a scratch copy.
4. Acceptance dry-run: run each read-only acceptance command at the base (a grep, `ls`, git; a test glob lists the files you
   mean) and write what it prints now. A line the base already passes, or a broken change would pass, is rewritten.
5. Fit: `git -C <repo> ls-tree -r --name-only <base> -- <files>` lists every file not marked `(new)`; on a scratch clone
   (`git clone -q --local <repo> <scratch>/clone`), with no session id, the tick does not exit 2: `env -u
   CLAUDE_CODE_SESSION_ID node ~/.claude/tools/board/board.mjs tick --repo <scratch>/clone --plan <abs pieces.json>`; every
   piece has a file and `after` has no cycle; no two pieces with no `after` path between them share a file (the tick does not
   show that yet); the open plans the brief names share no file without a `waits`.
6. Fresh: read the base sha again last, also after any Codex or owner change; when it moved, `git diff --stat <old>..<new>`
   and re-run checks 1 and 2 for what it touched.

## Pre-mortem

Assume dev stopped on this plan, or tess found a must-fix after a land: write the likeliest reasons (at most 7), each with the
step that now prevents it or why the risk is accepted. Look first at: a test or text still pinning the old behaviour; a rule
an existing case breaks; a caller or sibling left out; the first run on existing state (old installs, records not written
yet, a removed protection with nothing in its place yet); two runs or two plans at once; an error or missing input read as
empty or passed; an acceptance line that cannot fail; a fact from memory.
