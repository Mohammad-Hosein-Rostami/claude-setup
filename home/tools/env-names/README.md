# env-names

Compares the environment variables of a project by NAME, never by value. When you move apps, change the build tool or add
Docker and CI, the env setup breaks silently: a variable the code reads is no longer defined, an env file is dropped, a
prefix changes. Opening `.env` files to check puts secret values into a chat transcript; this tool gives the same answer
from names only. Node 22, no dependencies.

Run: `node ~/.claude/tools/env-names/env-names.mjs list [dir] [--json] [--save <file> [--overwrite]] [--wrapper <fn>]...`
and `node ~/.claude/tools/env-names/env-names.mjs diff <old-snapshot.json> [dir] [--json]`.
`dir` defaults to the current folder. Before a restructure run `list --save before.json`; after it run `diff before.json`.
`--wrapper getEnvVariable` (repeatable) also counts `getEnvVariable('NAME')` as a read. The wrapper list is stored in the
snapshot and `diff` uses it, so the two scans are comparable; a different `--wrapper` given to `diff` is a usage error.

## The invariant

No value of any env file ever reaches stdout, stderr, a snapshot file or an error message. The rule is: when the tool is not
sure a token is a variable name, it counts it and prints nothing. Two independent defences guard every leak, so one mistake
does not leak.

Defence 1, the parsers (`lib/env-file-names.mjs` is the only code that sees env file content):
- Of each line only the text left of the first `=` (or `: ` in dotenv's colon form) is a candidate name; the rest is used only
  to see whether the value goes on, and is dropped.
- A line that is not blank, a comment or a definition starts a skipped region that lasts until the next blank line. A PEM block
  (`-----BEGIN` to `-----END`, wherever it starts, also as the start of a value) is skipped whole. A value that opens a quote
  (`"`, `'`, backtick, bash `$'`) that is not closed, ends with a backslash, or is a YAML block scalar (`|`, `>`) swallows the
  lines after it. A line whose value is only `=` characters (base64 or base32 padding) is not a definition. Skipped lines are
  counted as `other lines`, never parsed and never echoed.
- The scanners for code and deploy files capture names only (a regular expression group around the name), never the line.
  A Dockerfile continuation is joined with no space, as Docker does, and after the first `NAME=value` only words of the form
  `NAME=...` count.
- Env-named `*.yaml`, `*.yml`, `*.json` and `*.toml` files are config files, not env files: listed as `not read (structured file)`.

Defence 2, the output rule, applied before anything is printed or saved:
- A name taken from an env file is printed only if it is `UPPER_SNAKE` or `lower_snake` of at most 64 characters, or if code or
  a deploy file names the same name. Others are counted per file as `N names not shown (mixed case or too long)`. A fragment of
  a secret (a base64 line, a token) almost never has that shape.
- Names from deploy files follow the same rule, except that a name in a key position (`NAME:` of a YAML mapping, `${NAME`,
  `${{ secrets.NAME }}`) may be mixed case up to 64 characters. A name from the left of `=` in a Dockerfile or in a
  `- NAME=value` item must be plain. Hidden deploy names are counted under `Not read`.

Other rules that keep content out:
- A file that cannot be read is listed with a fixed reason (`link, not read`, `binary, not read`, `too large, not read`,
  `not a regular file, not read`, `unreadable (EACCES), not read`), built from the error code and never from the error message.
  Only regular files are opened: no symlink, FIFO, socket or device is ever opened, by `list`, `diff` or `--save`.
- A snapshot that does not parse is refused with a fixed sentence; the JSON parser's message (which quotes the start of the
  text) is never shown, so passing an env file by mistake prints nothing of it.
- File and folder names are printed as they are, but control characters and newlines in them are replaced by `?` so a name
  cannot forge a line of the report. File names are not values, but they can say something (`.env.production`).

`tests/env-names-invariant.test.mjs`, `env-names-multiline.test.mjs` and `env-names-hidden.test.mjs` plant marker values in
every place a value can sit (and every multi-line shape found in a security review) and check that none reaches any output.

## Saving a snapshot

`--save <file>` creates the file with the exclusive flag: any existing path, a symlink included, is refused (exit 2).
`--overwrite` replaces an existing regular file, still never a symlink or a special file. A file name that looks like an env file
(`.env`, `.env.*`, `*.env`) is refused in every case, so a snapshot can never replace or be mistaken for a real env file.
`diff` reads only a regular file (a symlinked snapshot is refused).

## What it collects

Walks the folder, hidden folders included, skipping `.git`, `node_modules`, `dist`, `build`, `coverage`, `.nx`, `.next`,
`.turbo` and `.cache`. Git is not asked: untracked and git-ignored env files are included. Symlinked folders are not
entered, symlinked source files are skipped, a symlinked env file is listed as `link, not read`.

1. Env files: `.env`, `.env.*`, `*.env` at any depth. Per file: sorted names (see the output rule), the count of other lines.
   Example files (`.env.example`, `.env.sample`, `.env.template`, `*.example`, `*.sample`, `*.template`) are listed apart.
2. Read by code, in `*.{js,jsx,ts,tsx,mjs,cjs,mts,cts,vue,svelte}`: `process.env.NAME`, `process.env['NAME']`,
   `import.meta.env.NAME`, `import.meta.env['NAME']`, `Deno.env.get('NAME')` and `--wrapper` calls, each with `file:line`.
   Vite's `MODE`, `DEV`, `PROD`, `SSR`, `BASE_URL` (read through `import.meta.env`) are listed apart. Dynamic access
   (`process.env[name]`) is counted per file.
3. Mentioned in deploy files, with `file:line`: `Dockerfile*` (`ARG`, `ENV`), `docker-compose*.yml` and `compose*.yml`
   (`environment:` keys and `- NAME=...` items, `${NAME}`), `.github/workflows/*.yml` and `.gitlab-ci.yml` (`env:` keys,
   plus `variables:` in GitLab, and `secrets.NAME`, `vars.NAME` inside `${{ }}`). `.yaml` is accepted as well as `.yml`.

### What "defined" means

A name is defined by a real env file (not an example file, not a file that was not read). A read in a file is covered when an
env file in its folder or any parent folder defines the name (the folder chain; the scanned folder is the top). So there are
two lists, both printed: "Read by code but defined in no env file" is certain (examples that hold the name are named in the
row), and "Read by code, defined only outside its folder chain" needs a look (the env files that do define it are printed).
A deploy file mention does not define a name; it counts as use in "Defined but never read".

## Output of `list`

```
Env files (2):
  .env  (3 names, 1 other line)
  apps/web/.env.local  (1 name)

Example files (1):
  .env.example  (3 names)

Read by code but defined in no env file (1):
  MISSING_ONE  apps/api/server.js:1

Read by code, defined only outside its folder chain (look at these) (0):

Defined but never read by code or deploy files (1):
  ONLY_ROOT  .env

Names that differ between env files of the same folder (2):
  ONLY_ROOT  in .env; not in .env.example

env-names: 2 env files, 4 defined names, 5 names read by code, values never read
```

`Vite built-ins read`, `Dynamic access` and `Not read` sections appear only when they have rows. `--json` prints the full
structure; `--save` writes the same JSON with `{ version: 1, root, generatedAt, wrappers }` (a snapshot).

## Output of `diff`

Against a snapshot, the sections that have rows, in this order: `Now undefined` (names code reads that a real env file
defined before and none defines now: look at these first), `Definition moved out of the reader's folder chain` (still
defined, but no longer where the reader looks), `Env files no longer read` (an env file became a link, binary, unreadable or
too large: its names are not reported as undefined), `Env files added`, `Env files removed`, `Names changed in env files`,
`Names read by code added` / `removed`, `Names in deploy files added` / `removed`, then a closing line
`env-names: changes since <time>` or `env-names: no changes since <time>`. A moved env file shows as removed plus added;
when both hold exactly the same names each gets a `same names as <other path>` line.

## Exit codes

| Command | Code | Meaning |
| ------- | ---- | ------- |
| list | 0 | printed |
| list, diff | 2 | usage error, a folder that is not readable, a snapshot that is unreadable, not a regular file, not JSON, of the wrong shape or of a version other than 1 (refused, not guessed), a `--save` that is refused or cannot be written, a `--wrapper` that differs from the snapshot's |
| diff | 0 | nothing changed |
| diff | 1 | something changed |

## What it cannot see

- Names built at run time (`process.env[prefix + 'KEY']`): only counted per file.
- Names set by the host or CI at run time, and variables inherited from the shell.
- `const { A, B } = process.env` and `...process.env`: not parsed as reads.
- Code in comments counts as code (a commented-out `process.env.X` is listed).
- Compose `env_file:`, inline `environment: { A: 1 }` maps, GitLab `variables:` outside the blocks described above, YAML anchors.
- Moving only the code that reads a name, without changing the name, is invisible to `diff` (it compares names, not places).
- Skipping is deliberate: an unclosed quote swallows the lines after it, a value ending in a backslash swallows the next line
  (a Windows path such as `DIR=C:\logs\` hides the line below it), and a stray line hides the lines up to the next blank
  line. Losing a name shows up in `other lines`; leaking a part of a value is not allowed.
- A quoted YAML value in a compose file that continues on a line of its own is not tracked; a plain-shaped name inside it could
  be printed (mixed-case ones are hidden by the output rule).
- Files above 16 MB (env files) or 4 MB (source and deploy files) are listed under `Not read`.

## Layout

`env-names.mjs` (CLI: arguments, exit codes, printing) over `lib/`, see `lib/README.md`. Tests:
`node --test tests/env-names-*.test.mjs`.
