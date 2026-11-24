# token-view

Where the tokens of a period went, read from this machine's Claude Code transcripts (`~/.claude/projects`) and the per-account
7-day limit logs the status line writes (`~/.claude/state/limits/<account>.jsonl`). Read-only; run it by hand.

```sh
node ~/.claude/tools/token-view/token-view.mjs            # the last 7 days
node ~/.claude/tools/token-view/token-view.mjs --days 1 --detail
node ~/.claude/tools/token-view/token-view.mjs --project my-app --json
```

Sections: (a) limits against time per account (highest 7-day and 5-hour use per day); (b) use per role (agent type, the lead
as `lead`) with the average start tokens (the context of a run's first request), and per lane (git branch, else the working
folder); (c) cache reads, writes and rebuilds (a request after an idle gap longer than its cache lifetime, 5 min or 1 h, that
wrote more than it read), the context peak and compactions per session against the compaction point (the largest
`preTokens` seen; no compaction, no fill figure); (d) waste, each rule printed beside its count; (e) general-purpose spawns per
day (probe P6-13: a fall after the lead text changed shows it works).

Files: `token-view.mjs` (the command line), `lib/transcripts.mjs` (reads one transcript into a run), `lib/summary.mjs` (sums runs
into the view), `lib/limits.mjs` (reads the limit logs), `lib/print.mjs` (text and JSON).

The transcript fields are not documented and change between CLI builds; `lib/transcripts.mjs` names the ones it reads and the
builds they were seen on. A new pinned build gets a parser test with its own fixture (owed to the test phase). Native `/usage`
covers this machine only and shows no model bars under a setup token, so the view does not repeat it; it prints tokens, no
dollar figures.
