# Backend / API (B1-B10)

- **B1** transport (routes) -> service -> repository/adapter. Domain code imports no framework or IO; dependencies point inward.
- **B2** A handler parses and validates, calls one service function, maps the result. No SQL or business rules inside.
- **B3** Plural nouns, correct verbs, 201/204/400/401/403/404/409/422. Never return 200 with an error body.
- **B4** Errors as RFC 9457 problem+json: `{"type":"...","status":409,"code":"plan_locked"}`. No internals.
- **B5** Cursor pagination, filter and sort on every list; no unbounded query.
- **B6** Additive changes; document breaking ones and version them.
- **B7** Config in env, stateless processes, logs to stdout, port binding.
- **B8** Idempotency keys for payments and jobs; every outbound call has a timeout and bounded retries with backoff.
- **B9** Name things in the domain's language; value objects for money, ids, emails; aggregates enforce invariants.
- **B10** Structured JSON logs with correlation id; health and readiness endpoint; RED metrics; no console.log on prod paths.
