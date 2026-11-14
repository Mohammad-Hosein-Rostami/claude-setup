# Readability for humans (C31-C36)

What you leave in a project must work for a developer on a day with no AI. Readability changes the form of a solution,
never its scope, accuracy or performance target. If a requirement needs something complex, keep it and explain it.

## Scope: new work and changed lines
These rules apply to what you add and the lines you change. Old code keeps its own conventions (C17), and files the
task does not need stay untouched (C18): no renames, moves, restructures, headers or READMEs for old code unless the
owner asks. If you see a problem in old code, say so in your report and leave it.

## The no-AI test
A newcomer must answer these five questions from the repo alone. Before you finish, answer them for what you touched:
1. What is this? (the root README: one paragraph)
2. Where is X? (folder and file names tell you)
3. How do I run it and test it? (exact commands in the README)
4. Why is it built this way? (a decision record, or a comment next to the odd part)
5. How do I change or undo Y? (the README of that area; migrations and scripts say how to roll back)

## Names
- Use the words of the domain: `invoice`, `shipment`, not `item`, `entry`, `thing`.
- No abbreviations a newcomer must decode: `customerAddress`, not `custAddr`. Well-known ones stay (`id`, `url`).
- One word per concept, everywhere. Pick `fetch` or `load` or `get` and keep it; do not mix them.
- Functions are verbs (`sendInvoice`), data is nouns (`invoice`), booleans read as questions (`isPaid`). Folders and
  files say what is inside: `billing/invoice-pdf.ts`, not `utils/helpers2.ts`.
- For a new folder or file, avoid `misc`, `common`, `shared`, `utils`, `helpers`, `stuff`, `tmp`, `new`, `old`. Put the
  file with the feature that uses it, or name it for what it does (`money-format.ts`). Names a framework gives meaning
  are fine: Rails `helpers/`, a Next.js `new/` route, a Maven package path, `packages/shared`, i18n `common.json`.

## Structure
- Follow the standard layout of your language or framework (Next.js `app/`, Django apps, Maven `src/main/java`, Go
  `cmd/` and `internal/`). Do not invent a layout when a standard one exists.
- Where the framework does not decide, group by feature or domain (`billing/`, `accounts/`), not by kind of file.
- Keep trees shallow (framework paths such as Maven packages and route folders do not count). Tests sit beside the
  code (`invoice.ts`, `invoice.test.ts`) or in a folder that mirrors it; say which in the README.
- One entry point, named in the README (`npm start`, `python manage.py runserver`, `node src/main.mjs`).

## Abstraction
Shared helpers: extract on the third copy (C2). Interfaces, wrappers, factories, layers and options: only with a
second real use. The plain form first:

| Smell | Plain alternative |
| ----- | ----------------- |
| Interface with one implementation | Use the class or function directly |
| Wrapper that only calls through | Call the inner thing |
| Factory that builds one kind of object | Call the constructor |
| One layer "so we can swap the database later" | Write the query for the database you have |
| Option or parameter nobody passes | Remove it; add it when someone needs it |
| Base class with one child, or config that never changes | Put the code in the child; use a named constant |

An interface at a real edge is fine: an outside system (network, disk, clock, payment provider), a second
implementation, or a test double. Keep abstractions that already exist unless the task is to remove them.

## Comments
- Say why, not what. `// Retry once: the bank API drops the first call after midnight.` is good.
  `// increment i` is noise.
- Say what must always be true, and the units: `// always sorted by date, newest first`. Link the decision when
  there is one: `// See docs/decisions/0004-use-sqlite.md`.
- Never restate the code; delete commented-out code. A file you create opens with a short header (C26): what it is
  for, what it exports, what must stay true.

## Documents
Documents are for people, in proportion to the change. Use the repo's existing places and format. The one exception to
"no AI" is the team's own AI config (`CLAUDE.md`, `.claude/`): it follows the project layers in `home/CLAUDE.md`.

| Document | What goes in it | When |
| -------- | --------------- | ---- |
| README | what it is, how to run, test, change and undo | the project and each package or module you add |
| Decision record | the choice, why, what you rejected | a choice others would question, where the repo keeps them |
| Changelog | one line per user-visible change | only if the repo already keeps one |
| Runbook | steps to operate or recover, with commands | a new service or a new manual operation |

- A small fix needs a clear commit message and nothing else. A new module needs its README section.
  If the repo keeps no decision records, put the why in a comment or the commit body; do not start a new `docs/` tree.
- Working notes (`STATUS.md`, `HANDOFF.md`) are not committed unless the team wants them.

## Configs
- A comment says why a value is what it is and its unit (`# 30 s: the vendor times out at 45 s`, `timeoutMs`).
- One place per setting: if two files hold the same value, one is wrong. Local values go in a git-ignored file with
  a committed example (`.env.example`). Never commit secrets (C15).

## When complexity is required
A hard algorithm, a concurrency fix, a performance trick or a legal rule can be complex. Do not simplify it away.
1. Keep it in one file or function with a clear name.
2. Explain it where it lives: what it does, why the simple version is not enough, what must stay true.
3. Test the edge that forced it, and record why if a later developer might "clean it up".

## Checking
`node ~/.claude/tools/readable/readable.mjs check <dir> --changed` finds what your change added: a new unclear name,
a new folder with no README, a new file with no header, an uncommented config key. Fix those; list older ones as seen.
A reviewer judges the rest. In a team repo, keep a personal allow-list in `.claude/readable.local.json`, uncommitted.
