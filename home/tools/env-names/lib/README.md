# home/tools/env-names/lib

The parts of the `env-names` tool. `../env-names.mjs` is the command; see `../README.md` for the options, the output and
the rule that no env file value ever reaches an output.

- `env-file-names.mjs`: the only code that sees env file content; returns names and a count of other lines, never a value.
- `code-reads.mjs`: names a source file reads (`process.env.X`, `import.meta.env.X`, `Deno.env.get`, wrappers), and the count of dynamic accesses.
- `deploy-names.mjs`: names in Dockerfile, compose, GitHub workflow and GitLab CI files, and which file is which kind.
- `walk.mjs`: lists the env, source and deploy files of a folder without reading them (hidden folders in, symlinks not followed).
- `collect.mjs`: runs the walk, the reader and the scanners and builds the snapshot object (the same shape `list --json` prints).
- `analyze.mjs`: from that object, the names read but undefined, defined but never read, and differing between env files of one folder.
- `snapshot.mjs`: reads a saved snapshot back with a strict shape and version check.
- `diff.mjs`: compares an old snapshot with the current collection.
- `report.mjs`: turns an analysis or a diff into text.
- `usage-error.mjs`: the error class the command turns into exit 2; its message never carries file content.

## Test

From the repo root:

    node --test tests/env-names-*.test.mjs

`tests/env-names-fixtures.mjs` builds the temp project folders and holds the marker values. They are made-up words, never a real secret.

## Watch out for

- `readFileSync` may appear only in `env-file-names.mjs`, `collect.mjs` (source and deploy files) and `../env-names.mjs` (the snapshot); a test checks this.
- Never put an error object's `message` into output: for a JSON parse error it quotes the start of the file. Use `err.code`.
