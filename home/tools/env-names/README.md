# env-names

Compares the environment variables of a project by NAME, never by value. When you move apps, change the build tool or add
Docker and CI, the env setup breaks silently: a variable the code reads is no longer defined, an env file is dropped, a
prefix changes. Opening `.env` files to check puts secret values into a chat transcript; this tool gives the same answer
from names only. Node 22, no dependencies.

Run: `node ~/.claude/tools/env-names/env-names.mjs list [dir] [--json] [--save <file>] [--wrapper <fn>]...`
and `node ~/.claude/tools/env-names/env-names.mjs diff <old-snapshot.json> [dir] [--json] [--wrapper <fn>]...`.
`dir` defaults to the current folder. Before a restructure run `list --save before.json`; after it run `diff before.json`.
`--wrapper getEnvVariable` (repeatable) also counts `getEnvVariable('NAME')` as a read.

## The invariant

No value of any env file ever reaches stdout, stderr, a snapshot file or an error message.

- `lib/env-file-names.mjs` is the only code that sees env file content. Of each line it keeps the text left of the first
  `=` as a candidate name (`NAME=...`, `export NAME=...`, `NAME = ...`; names match `[A-Za-z_][A-Za-z0-9_]*`). The rest of the
  line is used only to see whether the value goes on over the next lines, and is dropped.
- A value continues when it opens a quote (`"`, `'`, backtick) that is not closed on the line, or ends with a backslash. The
  lines it covers are counted as `other lines` and not parsed, so the lines of a PEM key or a base64 block cannot become
  fake names. A line that is not a comment, blank or `NAME=...` is counted the same way, never echoed.
- The scanners for code and deploy files capture names only (a regular expression group around the name), never the line.
- Files that cannot be read are listed with a fixed reason (`link, not read`, `binary, not read`, `too large, not read`,
  `unreadable (EACCES), not read`), built from the error code and never from the error message.
- A snapshot that does not parse is refused with a fixed sentence; the JSON parser's message (which quotes the start of the
  text) is never shown, so passing an env file by mistake prints nothing of it.

`tests/env-names-invariant.test.mjs` plants marker values in every place a value can sit and checks that none reaches any
output; the other test files check the same on each collector.

## What it collects

Walks the folder, hidden folders included, skipping `.git`, `node_modules`, `dist`, `build`, `coverage`, `.nx`, `.next`,
`.turbo` and `.cache`. Git is not asked: untracked and git-ignored env files are included. Symlinked folders are not
entered, symlinked source files are skipped, a symlinked env file is listed as `link, not read`.

1. Env files: `.env`, `.env.*`, `*.env` at any depth. Per file: sorted names and the count of other lines.
2. Read by code, in `*.{js,jsx,ts,tsx,mjs,cjs,mts,cts,vue,svelte}`: `process.env.NAME`, `process.env['NAME']`,
   `import.meta.env.NAME`, `import.meta.env['NAME']`, `Deno.env.get('NAME')` and `--wrapper` calls, each with `file:line`.
   Vite's `MODE`, `DEV`, `PROD`, `SSR`, `BASE_URL` (read through `import.meta.env`) are listed apart. Dynamic access
   (`process.env[name]`) is counted per file.
3. Mentioned in deploy files, with `file:line`: `Dockerfile*` (`ARG`, `ENV`), `docker-compose*.yml` and `compose*.yml`
   (`environment:` keys and `- NAME=...` items, `${NAME}`), `.github/workflows/*.yml` and `.gitlab-ci.yml` (`env:` keys,
   plus `variables:` in GitLab, and `secrets.NAME`, `vars.NAME`). `.yaml` is accepted as well as `.yml`.

## Output of `list`

```
Env files (3):
  .env  (3 names, 1 other line)
  apps/web/.env.local  (1 name)
  linked/.env  (link, not read)

Read by code but defined in no env file (1):
  MISSING_ONE  apps/api/server.js:1

Defined but never read by code or deploy files (1):
  ONLY_ROOT  .env

Names that differ between env files of the same folder (2):
  ONLY_ROOT  in .env; not in .env.example

env-names: 3 env files, 5 defined names, 5 names read by code, values never read
```

`Vite built-ins read`, `Dynamic access` and `Not read` sections appear only when they have rows. A deploy file mention
counts as use in the third section. `--json` prints the full structure; `--save` writes the same JSON with
`{ version: 1, root, generatedAt }` (a snapshot).

## Output of `diff`

Against a snapshot, the sections that have rows, in this order: `Now undefined` (names code reads that an env file defined
before and none defines now: look at these first), `Env files added`, `Env files removed`, `Names changed in env files`,
`Names read by code added` / `removed`, `Names in deploy files added` / `removed`, then a closing line
`env-names: changes since <time>` or `env-names: no changes since <time>`. A moved env file shows as removed plus added;
when both hold exactly the same names each gets a `same names as <other path>` line.

## Exit codes

| Command | Code | Meaning |
| ------- | ---- | ------- |
| list | 0 | printed |
| list, diff | 2 | usage error, a folder that is not readable, a snapshot that is unreadable, not JSON, of the wrong shape or of a version other than 1 (refused, not guessed), a `--save` that cannot be written |
| diff | 0 | nothing changed |
| diff | 1 | something changed |

## What it cannot see

- Names built at run time (`process.env[prefix + 'KEY']`): only counted per file.
- Names set by the host or CI at run time, and variables inherited from the shell.
- `const { A, B } = process.env` and `...process.env`: not parsed as reads.
- Code in comments counts as code (a commented-out `process.env.X` is listed).
- Compose `env_file:`, inline `environment: { A: 1 }` maps, GitLab `variables:` outside the blocks described above, YAML anchors.
- An env file with an unclosed quote swallows the lines after it (they show up in `other lines`); a value ending in a backslash
  swallows the next line (a Windows path such as `DIR=C:\logs\` hides the line below it). Both are chosen on purpose: losing a
  name is visible, leaking a part of a value is not allowed.
- Files above 16 MB (env files) or 4 MB (source and deploy files) are listed under `Not read`.

## Layout

`env-names.mjs` (CLI: arguments, exit codes, printing) over `lib/`, see `lib/README.md`. Tests:
`node --test tests/env-names-*.test.mjs`.
