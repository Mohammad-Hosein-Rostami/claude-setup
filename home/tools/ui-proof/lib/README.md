# home/tools/ui-proof/lib

The parts of the `ui-proof` tool, which records whether the UI of a tree was checked and shows the proof to the owner.
`../ui-proof.mjs` is the command and `../README.md` has the options.

- `ui-files.mjs`: the one definition of "UI files" (used by the stop hook, `git-tidy land`, the road gate and the check plan) and the
  hash of a tree's UI files: markup, `.astro`, `.svelte`, `.vue`, `.mdx` and style files by path, and a `.js` file by its text (a JSX
  tag or a react, react-native or expo import; one it does not read counts as UI).
- `ui-evidence.mjs`: the one vocabulary of UI check evidence, shared by the check plan and the skill router (pure, imports nothing): the
  plan depths `none < same < render < visual < pixel` and the stricter-wins rule, the class of each changed file and line (test, docs
  page, dev config, deps, global look, look, text, logic; a line or file type it does not know counts as look); it re-exports the
  request part from `ui-request.mjs`, so callers import either file.
  `classifyFile(file, removed, added, hunks?)`: pass the hunk of each line (`hunks: { removed, added }`, one number per `@@` header)
  so a re-indent in place counts as no change; without it, or when a line moves to another hunk, the change is classed.
- `ui-request.mjs`: the design and no-change phrases in a request in English and Persian (pure, imports nothing; talk about the
  checks and negated clauses give none; a Figma link always counts), and the router's UI words. A negator refuses a design phrase
  only when it governs it directly (only light words between: "don't make it pixel perfect", not "never ship it unless it is pixel
  perfect"); in a talk clause a design phrase counts when a request verb asks for it ("implement the figma frame ... with full ui
  checks"). `requestEvidence` returns `partial: true` for a request over 1 MB (the rest is not read): plan the full checks for it.
  `uiClauses(text, maxBytes?)` and `ownClauseMatches(text, patterns, maxBytes?)` tell the skill router whether design and UI work are
  asked for and which of its own route patterns match outside talk and negated clauses; a text over `maxBytes` counts as everything.
- `ui-plan.mjs`: `planChecks`, the check plan of a change (a set of needs of none, same, render, visual and pixel per reached surface;
  `same` stays beside any raised need) from the request, the diff and the reached screens, and `briefFloor` (the `UI-PLAN:` line,
  which only adds); `ui-plan-proof.mjs`: `renderMap` (the widths, locales and states a same or render proof covers, and the sha256 of
  the run matrix), `runFiles` (that run matrix and its states) and `planProofProblem`, whether the records prove a plan. Rules:
  `home/standards/ui-checks.md`.
- `records.mjs`: the proof records, one JSON file per repository, one record per `ui-check run`, and the finders that look a record up by tree or commit.
- `review-html.mjs`: builds the HTML of the owner's review page from the review model (pure; every text is HTML-escaped).

Screens and reach (which screens of a project a change can show on), read at a commit with git plumbing, nothing written in the project:

- `screens.mjs`: `inferScreens`, the screens of a project at a commit with their urls and the lines that say what could not be inferred; picks the files to read and keeps the cache.
- `screen-sources.mjs`: the sources of screens: router files and the files they link (React Router, Vue Router, Angular), Next `app/` and `pages/`, stories, ui-coverage matrices, e2e urls.
- `route-parse.mjs`: the route declarations in the text of one router file (a tokenizer, route objects, `<Route>` elements, router calls, the names a file binds).
- `screens-cache.mjs`: the cache file of inferred screens under `~/.claude/state/ui-screens` (one per repository).
- `reach.mjs`: `reachedScreens`, the screens a set of changed files reaches by a full import walk, or every screen with one reason line.
- `resolve.mjs`: the module resolver of one tree (relative paths, tsconfig `paths`, Vite/webpack aliases, workspace packages).
- `git-read.mjs`: the read-only git calls (`ls-tree`, `cat-file --batch`) both use.
