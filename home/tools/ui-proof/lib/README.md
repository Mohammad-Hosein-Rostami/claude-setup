# home/tools/ui-proof/lib

The parts of the `ui-proof` tool, which records whether the UI of a tree was checked and shows the proof to the owner.
`../ui-proof.mjs` is the command and `../README.md` has the options.

- `ui-files.mjs`: the one definition of "UI files" (used by the stop hook, `git-tidy land` and the road gate) and the hash of a tree's UI files.
- `ui-evidence.mjs`: the one vocabulary of UI check evidence, shared by the check plan and the skill router (pure, imports nothing): the
  plan depths `none < same < render < visual < pixel` and the stricter-wins rule, the class of each changed file and line (test, docs
  page, dev config, deps, global look, look, text, logic; a line or file type it does not know counts as look); it re-exports the
  request part from `ui-request.mjs`, so callers import either file.
  `classifyFile(file, removed, added, hunks?)`: pass the hunk of each line (`hunks: { removed, added }`, one number per `@@` header)
  so a re-indent in place counts as no change; without it, or when a line moves to another hunk, the change is classed.
- `ui-request.mjs`: the design and no-change phrases in a request in English and Persian (pure, imports nothing; talk about the
  checks and negated clauses give none; a Figma link always counts), and the router's UI words. `requestEvidence` returns
  `partial: true` for a request over 1 MB (the rest is not read): plan the full checks for it.
- `records.mjs`: the proof records, one JSON file per repository, one record per `ui-check run`, and the finders that look a record up by tree or commit.
- `owner-waiver.mjs`: the one rule of the owner's ui-proof waiver for a road (the `## Owner decisions` line, the landing row's evidence text), used by `git-tidy land`, `land-lane` and the road gate.
- `review-html.mjs`: builds the HTML of the owner's review page from the review model (pure; every text is HTML-escaped).
