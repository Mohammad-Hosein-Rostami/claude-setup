# home/tools/recall/lib

The parts of `recall`, the search over past sessions and notes. The commands are `../recall.mjs` (search, index, status,
backfill, eval) and `../checkpoint-job.mjs` (the background note writer). `../README.md` explains the whole design, the
settings and the fallbacks. Needs Node 22.13 or newer (`node:sqlite`). No npm dependencies.

## Files by job

- Storing: `store.mjs` (SQLite schema, locking, writes), `private-fs.mjs` (owner-only files), `paths.mjs` (where state lives), `quiet-sqlite-warning.mjs` (hides Node 22's "SQLite is experimental" notice, nothing else).
- Reading sources: `extract.mjs` (parse transcripts and docs, chunk), `redact.mjs` (replace secrets), `indexer.mjs` (find files, index only what changed).
- Searching: `search.mjs` (queries, ranking, output), `rank.mjs` (snippets), `merge.mjs` (join word and vector hits), `pipeline.mjs` (one search from query to final hits).
- Vectors: `vectors.mjs` (local Ollama embeddings, cosine), `models.mjs` (the embedding models and their query prefixes).
- Reranking: `rerank.mjs` (client), `rerank-server.mjs` (starts the local `llama-server` on demand), `rerank-watch.mjs` (stops it when idle).
- Checkpoints: `checkpoint.mjs` (the job), `checkpoint-state.mjs` (trigger rule and lock), `slice.mjs` (reads a part of a transcript), `notes.mjs` (the prompt and the JSON check), `claude-call.mjs` (one `claude -p` call), `usage.mjs` (logs each call).
- After compaction: `digest.mjs` (the short block of notes), `owner-messages.mjs` (`recall --owner`: the owner's own typed messages of one session) and `owner-mask.mjs` (its credential masking).
- Commands and scoring: `cli-admin.mjs` (`status`, `backfill`), `eval.mjs` (hit@k scoring).

## Test

From the repo root:

    node --test tests/recall-*.test.mjs

`tests/recall-helpers.mjs` and `tests/recall-fakes.mjs` are shared test helpers, not tests. They put a fake `claude`, a fake `llama-server` and a fake Ollama on a private path, so no test calls Haiku or touches your real index.

## Watch out for

- A file that loads `node:sqlite` imports `quiet-sqlite-warning.mjs` first and loads sqlite with `process.getBuiltinModule('node:sqlite')` in its body, never a static `import`: Node loads a static builtin import (and prints its warning) before any module body runs. `tests/quiet-sqlite-warning.test.mjs` checks this for every such file.
- `checkpoint-state.mjs` is imported by a hook that must return in well under 50 ms. Keep it to Node built-ins.
- Secrets are redacted when indexing and again on output; keep both.
- State files are mode 0600 and folders 0700 on purpose.
