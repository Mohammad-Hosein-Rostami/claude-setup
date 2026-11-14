# Readability for humans (C31-C35)

Everything you leave in a project must work for a developer on a day with no AI. Readability changes the form of a
solution, never its scope, accuracy or performance target. If a requirement needs something complex, keep it, keep it
in one place, and explain it there (see "When complexity is required").

## The no-AI test
A newcomer must answer these five questions from the repo alone, without asking anyone:
1. What is this? (the root README: one paragraph)
2. Where is X? (folder and file names tell you)
3. How do I run it and test it? (exact commands in the README)
4. Why is it built this way? (a decision record, or a comment next to the odd part)
5. How do I change or undo Y? (the README of that area; migrations and scripts say how to roll back)
Before you finish, answer all five for the thing you touched. If one answer is "ask the author", fix that first.

## Names
- Use the words of the domain: `invoice`, `shipment`, not `item`, `entry`, `thing`.
- No abbreviations a newcomer must decode: `customerAddress`, not `custAddr`. Well-known ones stay (`id`, `url`, `http`).
- One word per concept, everywhere. Pick `fetch` or `load` or `get` and keep it; do not mix them.
- Functions are verbs (`sendInvoice`), data is nouns (`invoice`), booleans read as questions (`isPaid`, `hasItems`).
- Folders and files say what is inside: `billing/invoice-pdf.ts`, not `utils/helpers2.ts`.
- Never name a place `misc`, `common`, `shared`, `utils`, `util`, `helpers`, `stuff`, `tmp`, `new`, `old`. Put the file
  with the feature that uses it. When two features really share it, name it for what it does (`money-format.ts`).

## Structure
- Follow the standard layout of the ecosystem (Next.js `app/`, Django apps, Maven `src/main/java`, Go `cmd/` and
  `internal/`). Do not invent a layout when a standard one exists.
- Group by feature or domain (`billing/`, `accounts/`), not by technical kind (`controllers/`, `models/` for everything).
- Keep trees shallow: five levels under the project root at most.
- Tests sit beside the code (`invoice.ts`, `invoice.test.ts`) or in a folder that mirrors it. Say which in the README.
- One entry point, named in the README (`npm start`, `python manage.py runserver`, `node src/main.mjs`).
- A folder with three or more source files has a README that says what the folder is for.

## Abstraction
Wait for the second real use before you build a shared thing. The plain form first:

| Smell | Plain alternative |
| ----- | ----------------- |
| Interface with one implementation | Use the class or function directly |
| Wrapper that only calls through | Call the inner thing |
| Factory that builds one kind of object | Call the constructor |
| Generic layer "so we can swap the database later" | Write the query for the database you have |
| Option or parameter nobody passes | Remove it; add it when someone needs it |
| Base class with one child | Put the code in the child |
| Config for something that never changes | A named constant |

A test fake counts as a second use only when the boundary is real (network, disk, clock, payment provider).

## Comments
- Say why, not what. `// Retry once: the bank API drops the first call after midnight.` is good.
  `// increment i` is noise.
- State invariants and units: `// timeoutMs`, `// always sorted by date, newest first`.
- Link the decision when there is one: `// See docs/decisions/0004-use-sqlite.md`.
- Never restate the code, and delete commented-out code (git remembers it).
- Every source file opens with a short header: purpose, what it exports, what must stay true (C26).

## Documents
Write for a human reading cold. Never mention AI tools or sessions in project documents. Follow the repo's existing
format and folders first; create a new place only when there is none.

| Document | What goes in it | When |
| -------- | --------------- | ---- |
| README | what it is, how to run, test, change and undo | root, and any folder with 3+ source files |
| Decision record | the choice, why, what you rejected | a non-obvious choice another developer would question |
| Changelog | one line per user-visible change | only if the repo already keeps one |
| Runbook | steps to operate or recover, with commands | anything that runs in production |

Proportion: a one-line fix needs a good commit message and nothing else. A new module needs its README section. A new
service needs a README, a decision record and a runbook.

## Configs
- A comment says why a value is what it is (`# 30 s: the vendor times out at 45 s`).
- Put units in the name or the comment (`timeoutMs`, `cacheTtlSeconds`).
- One place per setting. If two files hold the same value, one of them is wrong.
- Local values go in a git-ignored file with a committed example (`.env.example`, `local.json.example`).
- Never commit secrets (C15).

## When complexity is required
A hard algorithm, a concurrency fix, a performance trick or a legal rule can be complex. Do not simplify it away.
1. Keep it, in one file or function with a clear name.
2. Explain it where it lives: what it does, why the simple version is not enough, what must stay true.
3. Test it, including the edge that forced the complexity.
4. Record the reason in a decision record if a later developer might "clean it up".

## Project layers
These rules belong in the team's repo and must stand alone: they name no personal tools, paths on someone's machine or
AI products. Anything a human needs to work on the project is in the project.

## Checking
`node ~/.claude/tools/readable/readable.mjs check <dir> --changed` finds the mechanical problems (missing README, a
dumping-ground name, deep nesting, a missing file header, an uncommented config key). It cannot judge names,
needless abstraction or whether a document is clear. A reviewer reads for those.
