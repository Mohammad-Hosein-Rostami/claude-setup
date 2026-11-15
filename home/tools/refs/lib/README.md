# refs/lib

The parts of the `refs` tool. `../refs.mjs` is the command; `scan.mjs` walks the folder and hands each file to the
readers below. A reader gets `(file, context)` and returns `{kind, value, line}` items for the paths it found missing;
a kind ending in `?` is a hint. See `../README.md` for the kinds and the rules.

| File | Job |
| ---- | --- |
| `scan.mjs` | walk, pick readers by file name, never open `.env*`, turn read errors into `unreadable?`, sort |
| `walk.mjs`, `disk.mjs`, `glob.mjs`, `ref-path.mjs` | list files; case-exact existence; glob matching on real entries; path rules |
| `jsonc.mjs`, `yaml-lines.mjs`, `js-strings.mjs` | read JSON with comments, the YAML keys needed, and string literals, all with line numbers |
| `tsconfig.mjs`, `package.mjs`, `docker.mjs`, `ci.mjs`, `markdown.mjs` | the readers of findings (and `md-path?`) |
| `hints.mjs` | `script-path?` and `config-path?` |
| `report.mjs` | text and JSON output |
