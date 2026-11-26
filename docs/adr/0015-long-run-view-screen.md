# 0015: long-run gets a browser screen of its own, not LangGraph Studio

- Status: accepted. Date: 2026-11-27.

## Context

Runs can only be seen as text (`status`, `live`, `events --follow`, logs). The owner wants a screen with the graph, which
step runs, is done, failed, waits for a retry or a limit, or is held, with attempts, times and recent events, live, for
several runs, on macOS (and fine on Windows and Linux).

## Drivers

1. No account, no cloud, no data leaving the machine.
2. It shows our runs while their drivers run.
3. Fewest new dependencies.
4. Read-only and bound to 127.0.0.1.
5. Simple code, low upkeep.

## Options

- A. LangGraph Studio with `langgraph dev`: the UI is the hosted smith.langchain.com page; the dev server runs graphs itself
  with its own store and ignores a compiled checkpointer, so it cannot watch a running driver and would start steps itself;
  21 + 21 direct dependencies; analytics on by default.
- B. Our own page: `long-run view` serves one page on 127.0.0.1 that polls the same reads as `live` every 2 s.
- C. A static HTML file rewritten every 2 s with a meta refresh: no port, but the page reloads every 2 s and loses its place.

## Decision

B. A loses on drivers 1, 2 and 4; C loses on driver 2 (a reloading page is not a live screen). The screen draws the job's
routes, not `getGraph().drawMermaid()`: our graph gives every node a conditional edge to every target (77 edges for a
4-step job), which is unreadable.

## Consequences

- Good: no new dependency, no write, no SQLite read; the same data as `status --json`; works on every OS with a browser.
- Bad: a loopback port (guarded by a Host check, GET only, a strict CSP, no CORS); another local user could read it; the
  graph is our drawing of the job, so a routing change in graph.mjs must be mirrored in `flowOf`.
- Reversal: watching one machine's runs from another; a review finding the loopback port exposed; `events.jsonl` big
  enough to slow the poll.

## Sources

- docs.langchain.com/oss/javascript/langchain/studio and docs.langchain.com/langsmith/local-server (read 2026-11-27).
- github.com/langchain-ai/langgraph/issues/5790 (dev server ignores a compiled checkpointer, Oct 2025).
- docs.langchain.com/langsmith/data-storage-and-privacy (CLI analytics, LANGGRAPH_CLI_NO_ANALYTICS).
- registry.npmjs.org/@langchain/langgraph-cli and /@langchain/langgraph-api (1.8.1, direct dependencies).
- Local probe: drawMermaid of the example job, 12 nodes and 77 edges (in memory, scratch folder).
