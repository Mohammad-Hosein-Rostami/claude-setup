# 0009: The catalog is generated, git-ignored and written by install

- Status: accepted. Date: 2026-11-25 (the owner's decision, in the list of setup speed-ups).

## Context

`docs/catalog.md` mixed generated rows with hand text. Every branch that added or changed a skill, agent, tool or hook edited
it, so parallel branches conflicted there.

## Drivers

1. No branch conflicts on the catalog.
2. It works however the work is split: worktrees, one shared folder, or jj.
3. No text is lost.
4. The simplest to keep.

## Options

| Option | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| A. Fully generated and committed, regenerated in one step after each job's last land | only with a step someone must remember | ok | ok | ok |
| B. Fully generated, git-ignored, written by install | yes | yes | yes | yes; the catalog is missing on the GitHub page and in a clone before install |
| C. A git merge driver that regenerates it on a conflict | yes | no: git only, and it needs a local config on every machine | ok | no |

## Decision

B. `scripts/catalog.mjs` builds every section from the files: frontmatter, a rule's `paths` and ids, a standard's first line, a
hook's first header line, a tool README's first line, a script's `Purpose:` line, `plugins/plugins.json` and
`settings/base.json`. The hand text moved beside the file it describes (hook headers and `home/hooks/README.md`, the tool READMEs,
`plugins/README.md`, `settings/README.md`, the script headers, "Status line" in `docs/how-it-works.md`). `.gitignore` lists
`/docs/catalog.md`, and install writes it. If the owner later picks A, the same generator serves it, plus a `docs(catalog)`
commit after the last land.

## Consequences

- Good: no conflicts and no catalog step; the hand text lives beside its file.
- Bad: a reader of the repo online sees no catalog; each file must carry its description in its header.
- Reversal signal: someone needs the catalog without installing (sharing the setup with others); then take A.

## Sources

- `scripts/catalog.mjs` header (read 2026-11-25).
- git documentation on `.gitignore` and tracked files: a tracked file stays tracked until `git rm --cached`.
