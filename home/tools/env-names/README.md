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
does not leak, and one rule decides when the tool stops trying to understand a file at all.

Regular and irregular env files. A file is REGULAR only if every line (split on CRLF, LF and a lone CR) is blank, a comment, or
ONE complete definition `NAME=value` or `export NAME=value`, where the value has balanced quotes on that same line, has nothing
after a closing quote but a comment, does not end in a backslash and has no backslash right before a quote (`\"`: dotenv
reads it as an escaped quote, this tool does not, so they could disagree on where the value ends), and the file holds no `-----BEGIN` text, no lone CR, no NUL
byte and no heredoc marker (`<<`). Anything else (a stray line, `NAME: value`, a quote that opens and does not close, a PEM
block, a JSON value spread over lines, a shell heredoc) is IRREGULAR: the tool cannot be sure where a value ends, so a "name"
could be a piece of a secret. From a regular file names print under the name-shape rule below. From an irregular file a name
prints only if code reads the same name or a deploy file names it too; every other name is counted, never shown:
`N names not shown (this file has multi-line or unusual values; only names also found in code or deploy files are listed)`.
The file is marked `irregular` in the text report, the JSON and the snapshot. `diff` compares hidden names by count only
(`names not shown: 3 -> 2`), never by value.

Defence 1, the parsers (`lib/env-file-names.mjs` is the only code that sees env file content; its skip rules stay on for every
file, regular or not):
- Of each line only the text left of the first `=` (or `: ` in dotenv's colon form) is a candidate name; the rest is used only
  to see whether the value goes on, and is dropped.
- A line that is not blank, a comment or a definition starts a skipped region that lasts until the next blank line. A PEM block
  (`-----BEGIN` to `-----END`, wherever it starts, also as the start of a value) is skipped whole. A value that opens a quote
  (`"`, `'`, backtick, bash `$'`) that is not closed, ends with a backslash, or is a YAML block scalar (`|`, `>`) swallows the
  lines after it; a `-----END` line ends the PEM region only, never an open quote. A line whose value is only `=` characters (base64 or base32 padding) is not a definition. Skipped lines are
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
  `${{ secrets.NAME }}`) may be mixed case up to 64 characters, because a key is never a value. A name from the left of `=` in a
  Dockerfile or in a `- NAME=value` item must be plain. Dockerfile heredoc bodies and compose `$${NAME}` (an escaped literal)
  are skipped.
- Regular and irregular YAML blocks (the same idea as for env files, `lib/deploy-names.mjs`). A block under `environment:`
  (compose), `env:` (workflow, GitLab) or `variables:` (GitLab) is REGULAR only if every line is blank, a comment, `NAME:` with
  an empty value, a plain value or a value quoted completely on that line, or a list item `- NAME`, `- NAME=value` or the same
  quoted on one line (a key may be in one pair of matching quotes), all at one indent, no tab, no backslash right before a
  closing quote, and a plain value never starts with `&` `*` `!` `|` `>` `{` `[` or a quote. Anything else (an anchor, alias or tag,
  a block scalar, a flow map or list, a quote that does not close on its line, a key with a space, a deeper or shifted line) makes
  the whole block IRREGULAR. From an irregular block, and from every line after a quote or flow collection left open, a name
  prints only if code reads the same name; the rest are counted per file as `N names not shown (... unusual layout ...)`.
  Ordinary compose, workflow and GitLab files stay regular. A compose block that uses `<<: *anchor` or `${...}` flow values,
  or a GitLab variable with `value:` / `description:` sub-keys, is irregular by this rule. There is no Kubernetes reader.

Other rules that keep content out:
- A file that cannot be read is listed with a fixed reason (`link, not read`, `binary, not read`, `too large, not read`,
  `not a regular file, not read`, `unreadable (EACCES), not read`), built from the error code and never from the error message.
  Only regular files are opened: no symlink, FIFO, socket or device is ever opened, by `list`, `diff` or `--save`. Env, code and
  deploy files are opened once without following links or blocking, and the type and size are checked on that open file, so a file
  swapped for a link or FIFO while the scan runs is not read and cannot hang it.
- A snapshot that does not parse is refused with a fixed sentence; the JSON parser's message (which quotes the start of the
  text) is never shown, so passing an env file by mistake prints nothing of it.
- File and folder names are printed as they are, but control characters and newlines in them are replaced by `?` so a name
  cannot forge a line of the report. File names are not values, but they can say something (`.env.production`).

`tests/env-names-invariant.test.mjs`, `env-names-multiline.test.mjs` and `env-names-hidden.test.mjs` plant marker values in
every place a value can sit (and every multi-line shape found in a security review) and check that none reaches any output.

## Saving a snapshot

`--save <file>` creates the file with the exclusive, no-follow flags: any existing path, a symlink included, is refused (exit 2).
`--overwrite` replaces an existing file only if it is a regular file that already holds one of this tool's snapshots (so
`package.json`, notes, a hard link to a real `.env` are refused), opened without following a symlink. A file name that looks like
an env file (`.env`, `.env.*`, `*.env`), in any letter case, is refused in every case, so a snapshot can never replace or be
mistaken for a real env file. `diff` opens only a regular file without following links (a FIFO or symlink is refused) and
refuses a snapshot of an older version (version 1 snapshots may hold fragments of values; save a new one).

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
Env files (3):
  .env  (3 names)
  apps/web/.env.local  (1 name)
  tools/.env  (1 name, 4 other lines, 6 names not shown (this file has multi-line or unusual values; only names also found in code or deploy files are listed), irregular)

Example files (1):
  .env.example  (3 names)

Read by code but defined in no env file (1):
  MISSING_ONE  apps/api/server.js:1

Read by code, defined only outside its folder chain (look at these) (0):

Defined but never read by code or deploy files (1):
  ONLY_ROOT  .env

Names that differ between env files of the same folder (2):
  ONLY_ROOT  in .env; not in .env.example

env-names: 3 env files, 4 defined names, 5 names read by code, values never read
```

`Vite built-ins read`, `Dynamic access` and `Not read` sections appear only when they have rows. `--json` prints the full
structure; `--save` writes the same JSON with `{ version: 2, root, generatedAt, wrappers }` (a snapshot).

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
| list, diff | 2 | usage error, a folder that is not readable, a snapshot that is unreadable, not a regular file, not JSON, of the wrong shape or of a version other than 2 (refused, not guessed), a `--save` that is refused or cannot be written, a `--wrapper` that differs from the snapshot's |
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
- In a REGULAR env file an unquoted value that continues on the next line, where the continuation is itself `NAME=...`, reads as
  a second definition: every dotenv reader does the same, so no rule can tell them apart. A single-case name of a secret that
  ends in `=` (a base32 seed) could print this way. Keep secrets of that shape in quotes.
- Irregular env files show few names (only those code or deploy files confirm); that is the price of never printing a fragment.
- `-----BEGIN` in a comment makes the file irregular and skips to the next `-----END` or the end of the file.
- Files above 16 MB (env files) or 4 MB (source and deploy files) are listed under `Not read`.

## Layout

`env-names.mjs` (CLI: arguments, exit codes, printing) over `lib/`, see `lib/README.md`. Tests:
`node --test tests/env-names-*.test.mjs`.
