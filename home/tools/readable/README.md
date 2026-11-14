# readable

Checks the mechanical part of the human-first rules (C26, C32, C34, C35 in `home/rules/core.md`; the reasoning is in
`home/standards/readability.md`). Node 22, no dependencies. It reads files and runs `git`; it never writes.

Run: `node ~/.claude/tools/readable/readable.mjs check <dir> [--changed [--base <ref>]]`

## Two modes

- Whole tree (no `--changed`): an audit. Every finding in the folder is reported, old or new.
- `--changed`: reports only what the change ADDED, so old code is left alone (C36). The change is the working tree
  against the base (default: the merge-base with `origin/HEAD`, else `main`, else `master`, else `HEAD`; `--base <ref>`
  picks another). Untracked files count as added.

## What it finds

| Check | Finding | With `--changed`, only when | Rule |
| ----- | ------- | --------------------------- | ---- |
| `no-readme` | a folder with 3 or more source files and no README | the change created the folder or added a source file that took it past two | C34, C26 |
| `dumping-ground` | a folder named `misc`, `common`, `shared`, `utils`, `util`, `helpers`, `helper`, `stuff`, `tmp`, `temp`, `new`, `old` or `data`; a file named `misc`, `utils`, `util`, `helpers`, `helper`, `stuff`, `tmp` or `temp` (name before the first dot) | the change created that file, or created that folder (nothing was under it before) | C32 |
| `deep-nesting` | a file more than 5 folders below the project root | the change added a file in it | C32 |
| `no-header` | a source file that does not start with a comment (a shebang or `'use strict'` may come first) | the file is new | C26 |
| `config-comment` | a key in a `.yml`, `.yaml`, `.toml`, `.ini`, `.cfg` or `.env.example` file with no comment: inline, on the line above, on its section or parent key, or (env) opening its block | the change added the key (editing a value does not count) | C35 |

Source files are `js mjs cjs jsx ts tsx py go rs java kt rb php cs c cpp h swift sh`. A line reads
`file:line RULE check: problem. Fix: what to do`; the last line is `readable: ok` or the count per check.

## Built-in exemptions

- Skipped completely: everything `.gitignore` hides (also the `.gitignore` files above the folder, up to the repo root),
  symlinks, the folders `.git node_modules vendor bower_components dist build out coverage target .next .nuxt .turbo
  .cache __pycache__ .venv venv .gradle .idea generated __generated__ .svelte-kit .output Pods .dart_tool .yarn`, lock
  files (`*-lock.*`, `*.lock`, `go.sum`) and generated files (`*.gen.*`, `*.generated.*`, `*.min.*`, `*.pb.go`,
  `*_pb2.py`, `*.d.ts`). `json` config is skipped because it cannot hold comments.
- Depth does not count: a Maven or Gradle package path below `src/main|test/<java|kotlin|scala|groovy>`, anything below a
  Next.js `app/` or `pages/` folder, and `(group)` and `[param]` folders.
- Names that are fine: Rails `app/helpers/`, a route folder `new` below `app/` or `pages/`, `packages/shared` and
  `packages/common` in a workspace, folders inside a Maven package path, and files called `new`, `old`, `data`, `common`
  or `shared` (Rails `new.html.erb`, i18n `common.json`).
- Config: files under `locales/`, `i18n/` or `translations/`, and the CI step keys `uses` and `run`.

## Keeping a name on purpose

List it with a reason in `.claude/readable.local.json` (personal, never committed; use this one in a team repo) or in
`.readable.json` (only when the team adopted this tool). Both are read, the local file first.

    { "allow": [ { "path": "src/data", "reason": "CSV fixtures the finance team edits by hand" } ] }

A file that is not valid JSON, has a key other than `allow`, or has an entry without a `path` or a `reason` is an error
(exit 2), never silently ignored.

## Exit codes

0 nothing found, 1 findings, 2 usage error (bad flag, not a folder, no git for `--changed`, bad allow-list file), 3 the
tool crashed (one line on stderr).

## What it cannot judge

These stay with the reviewer (the "human-first" lens in `home/agents/reviewer.md`): whether a name says what the thing
is, an interface with one implementation, a pass-through wrapper, whether a README or decision record is any good,
whether a comment says why, and whether a config value is explained well enough.
