# refs

Finds config entries that point at paths which do not exist. After a restructure (a folder moved, a build tool
removed) the typecheck finds broken imports, but nothing finds a stale `tsconfig` alias, a Dockerfile `COPY`, a CI
`working-directory`, a compose `env_file` or a link in a README. `refs` reads those places, including hidden folders
such as `.github`, `.cursor` and `.claude` that `rg` skips by default. Node 22, no dependencies.

Run: `node ~/.claude/tools/refs/refs.mjs check [dir] [--json] [--no-hints]` (dir defaults to the current folder).

| Code | Meaning |
| ---- | ------- |
| 0 | no findings (hints never change the exit code) |
| 1 | findings |
| 2 | usage error, or the folder cannot be read |

## Output

One line per item, sorted by file then line, findings first and then hints (kind ends in `?`):

```
tsconfig.json:12 tsconfig-path src/old/* -> missing
docs/setup.md:30 md-path? scripts/gone.sh -> missing
refs: 1 findings, 1 hints in 42 files scanned
```

`--json` prints one object `{ findings, hints, scanned }`; each item is `{ file, line, kind, value }`. `--no-hints`
leaves the hints out. A file that cannot be read or parsed is the hint `unreadable?`; its value is the reason.

## Findings (exact readers)

| Kind | Where | Checked |
| ---- | ----- | ------- |
| `tsconfig-extends` | `tsconfig*.json`, `jsconfig*.json` | `extends` (a package name is skipped) |
| `tsconfig-reference` | same | `references[].path` |
| `tsconfig-path` | same | each alias target against the `baseUrl` found through `extends` (else the file's folder); with `*` checked up to the wildcard |
| `tsconfig-include` | same | literal `include` and `files` entries (no globs) |
| `package-entry` | `package.json` | `main`, `module`, `types`, `typings` (an extension or `index.*` may be added), `bin`, string leaves of `exports` |
| `workspace-glob` | `pnpm-workspace.yaml`, `workspaces` | an entry that matches no folder (`!` entries skipped) |
| `compose-path` | `docker-compose*.yml`, `compose*.yml` | build `context` and `dockerfile` |
| `dockerfile-copy` | `Dockerfile*` | each `COPY`/`ADD` source, tried in the Dockerfile's folder, the scanned root and any compose build context naming it (heredoc bodies are shell text and skipped) |
| `ci-path` | `.github/workflows/*.yml` | `working-directory`, `cache-dependency-path`, `uses: ./...` (values with `${{` skipped) |
| `codeowners-path` | `CODEOWNERS` (root, `.github`, `docs`) | a pattern without wildcards that matches nothing |
| `md-link` | `*.md`, `*.mdc` | relative `[text](path)` links; `#anchor`, `?query`, URLs, `/site-root` links, links leaving the folder and links in code skipped |

## Hints (heuristics, can be wrong)

| Kind | Where | Meaning |
| ---- | ----- | ------- |
| `package-entry?` | `package.json` | the missing entry is under `dist`, `build`, `lib` or `out`: a build probably creates it |
| `compose-path?` | compose files | a missing `env_file` or bind-mount source (often git-ignored or made by the host), or a path under a build output folder |
| `dockerfile-copy?`, `ci-path?` | Dockerfile, workflows | the missing path is under `dist`, `build`, `out`, `coverage`, `.next` or `.output`: a build or an earlier step creates it |
| `tsconfig-path?` | tsconfig | `paths` not judged because the `extends` chain cannot be followed (package parent, missing or unreadable parent); the value says why |
| `script-path?` | `package.json` `scripts` | a `./x` or `dir/file.ext` token that does not exist next to the package |
| `config-path?` | `*.config.{js,cjs,mjs,ts,mts}`, `eslint.config.*`, `.eslintrc*` | a `./` or `../` string literal that does not exist; object keys and values of output or cache keys (`outDir`, `cacheDir`, ...) are skipped |
| `md-path?` | markdown | a backticked `dir/file` whose first folder exists at the top level but the full path does not (npm names such as `@scope/pkg` or a dependency are skipped) |
| `unreadable?` | any scanned file | the file could not be read or parsed |

A finding must be certain. Whatever something else may create (a build, a test run, the Docker host, an earlier CI step)
is a hint, so the exit code only reports paths that are really gone.

## Rules of the walk

- Existence questions (CODEOWNERS, links, globs) go to the real file system, so a build folder that the walk skips still counts as present.
- Skipped folders: `.git`, `node_modules`, `dist`, `build`, `coverage`, `.nx`, `.next`, `.turbo`, `.cache`.
- Symlinks are never followed, so a link out of the directory or a loop is never entered.
- Files named `.env*` are never opened (a reference to one is still checked for existence).
- Existence is case-exact: each path segment must match a real directory entry, so a case-only mistake that macOS
  and Windows hide (and Linux CI does not) is reported.
- Windows `\` separators in values are read as `/`. JSON may have comments, trailing commas, a BOM and CRLF.
- YAML is read line by line for the keys above only. Anchors, multi-line scalars, flow lists and templates are skipped,
  not guessed. A file over 8 MiB is a hint, not read.

## What it does not check

Imports in source code (the typecheck's job), ignore files (`.gitignore`, `.dockerignore`), paths built from variables
or templates, reference-style markdown links, and scripts or configs in languages other than the ones above.

## Layout

`refs.mjs` (arguments, printing, exit code) over `lib/`; see `lib/README.md`. Tests: `tests/refs-*.test.mjs`.
