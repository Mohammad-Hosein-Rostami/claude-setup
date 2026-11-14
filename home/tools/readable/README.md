# readable

Checks the mechanical part of the human-first rules (C26, C32, C34, C35 in `home/rules/core.md`; the reasoning is in
`home/standards/readability.md`). Node 22, no dependencies. It reads files and runs `git`; it never writes.

Run: `node ~/.claude/tools/readable/readable.mjs check <dir> [--changed [--base <ref>]]`

## What it finds

| Check | Finding | Rule |
| ----- | ------- | ---- |
| `no-readme` | a folder with 3 or more source files and no README | C34, C26 |
| `dumping-ground` | a file or folder named `misc`, `common`, `shared`, `utils`, `util`, `helpers`, `helper`, `stuff`, `tmp`, `temp`, `new`, `old` or `data` (the bare name, before the first dot) | C32 |
| `deep-nesting` | a file more than 5 folders below the project root | C32 |
| `no-header` | a source file that does not start with a comment (a shebang or `'use strict'` may come first) | C26 |
| `config-comment` | a key in a `.yml`, `.yaml`, `.toml`, `.ini`, `.cfg` or `.env.example` file with no comment: inline, on the line above, on its section or parent key, or (env) opening its block. `json` is skipped, it cannot hold comments | C35 |
| `allow-list` | a problem in `.readable.json` (bad JSON, or an entry without a reason) | C32 |

Source files are `js mjs cjs jsx ts tsx py go rs java kt rb php cs c cpp h swift sh`, without `.d.ts` and `.min.` files.
Skipped: everything `.gitignore` hides, symlinks, and the folders `.git node_modules vendor bower_components dist build
out coverage target .next .nuxt .turbo .cache __pycache__ .venv venv .gradle .idea generated`.

Each line reads `file:line RULE check: problem. Fix: what to do`. The last line is `readable: ok` or the count per check.

## Options

- `--changed`: keep only findings about files changed against the base, so old code does not drown the report. For a
  config file only the changed lines are checked. Untracked files count as changed.
- `--base <ref>`: the commit to compare with. Default: the merge-base with `origin/HEAD`, else `main`, else `master`,
  else `HEAD`.
- Exit codes: 0 nothing found, 1 findings, 2 usage error (bad flag, not a folder, no git for `--changed`).

## Keeping a name on purpose

Put a `.readable.json` in the project root. Every entry needs a reason; an entry without one is ignored and reported.

    { "allow": [ { "path": "src/data", "reason": "CSV fixtures the finance team edits by hand" } ] }

## What it cannot judge

These stay with the reviewer (the "human-first" lens in `home/agents/reviewer.md`):
whether a name says what the thing is, an interface with one implementation, a pass-through wrapper, whether a README
or decision record is any good, whether a comment says why, and whether a config value is explained well enough.
