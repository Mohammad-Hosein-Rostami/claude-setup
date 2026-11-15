# home/tools/env-names/lib

The parts of the `env-names` tool. `../env-names.mjs` is the command; see `../README.md` for the options, the output and
the rule that no env file value ever reaches an output.

- `env-file-names.mjs`: the only code that sees env file content; returns names and a count of other lines, never a value.
- `read-regular-file.mjs`: opens a file once (no symlink followed, no FIFO block), checks type and size on that descriptor and reads from it; used for env files and for the scanned code and deploy files.
- `name-shape.mjs`: the shape a name must have to be printed without a second reason (the output rule, shared by `collect.mjs` and `deploy-names.mjs`).
- `code-reads.mjs`: names a source file reads (`process.env.X`, `import.meta.env.X`, `Deno.env.get`, wrappers), and the count of dynamic accesses.
- `deploy-names.mjs`: names in Dockerfile, compose, GitHub workflow and GitLab CI files, and which file is which kind. Dockerfiles are read line by line here; YAML kinds go to `deploy-yaml-names.mjs`.
- `deploy-yaml-names.mjs`: reads YAML deploy files with the `yaml` package and takes names from parsed map keys at the env positions only; a file with any parser error or warning is untrusted (names print only when code reads them too). Without the package the YAML files are skipped.
- `walk.mjs`: lists the env, source and deploy files of a folder without reading them (hidden folders in, symlinks not followed), and tells example files and structured files (`.env.yaml`) apart.
- `collect.mjs`: runs the walk, the reader and the scanners and builds the snapshot object (the same shape `list --json` prints).
- `analyze.mjs`: from that object, the names read but undefined, read but defined only outside the reader's folder chain, defined but never read, and differing between env files of one folder. Example files define nothing.
- `snapshot.mjs`: reads a saved snapshot back with a strict shape and version check.
- `diff.mjs`: compares an old snapshot with the current collection (names now undefined, definitions moved out of the folder chain, env files no longer read, names added and removed).
- `report.mjs`: turns an analysis or a diff into text.
- `usage-error.mjs`: the error class the command turns into exit 2; its message never carries file content.

## Test

From the repo root:

    node --test tests/env-names-*.test.mjs

`tests/env-names-fixtures.mjs` builds the temp project folders and holds the marker values. They are made-up words, never a real secret.

## Watch out for

- `readFileSync` may appear only in `read-regular-file.mjs` (env, source and deploy files) and `../env-names.mjs` (the snapshot); a test checks this.
- Env-file paths are read only through `readEnvFile`, which reads regular files only (through `read-regular-file.mjs`).
- Never put an error object's `message` into output: for a JSON parse error it quotes the start of the file. Use `err.code`.
