# home/tools/ui-proof/lib

The parts of the `ui-proof` tool, which records whether the UI of a tree was checked and shows the proof to the owner.
`../ui-proof.mjs` is the command and `../README.md` has the options.

- `ui-files.mjs`: the one definition of "UI files" (used by the stop hook, `git-tidy land` and the road gate) and the hash of a tree's UI files.
- `records.mjs`: the proof records, one JSON file per repository, one record per `ui-check run`, and the finders that look a record up by tree or commit.
- `review-html.mjs`: builds the HTML of the owner's review page from the review model (pure; every text is HTML-escaped).
