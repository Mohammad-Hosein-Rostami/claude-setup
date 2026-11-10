---
name: async-ui-states
description: Use for any screen that loads or changes server data - loading, empty, error, offline, stale responses, pagination, search-as-you-type.
---

1. Every data view has five states, all designed and tested: loading (skeleton the size of the real content), empty (says what to do next), error (says what failed, with Retry), partial/stale, success. Offline shows a clear message (`navigator.onLine` plus failed fetch) and retries.
2. Use a server-state library (TanStack Query, SWR, RTK Query) or one wrapper: stable keys, `staleTime`/`gcTime`, invalidation after mutations, request de-duplication. Do not copy server data into local state.
3. Cancel or ignore stale requests: `AbortController` or key-based caching so a late response A never overwrites newer B. Debounce search input (about 250-300 ms) together with cancellation.
4. Lists: cursor pagination, "Load more" button as the accessible default, infinite scroll only as an enhancement, preserve scroll and filters on back navigation, virtualize beyond a few hundred rows.
5. Every promise is awaited or caught; no unhandled rejections; errors from `fetch` include non-2xx statuses; show problem-details messages when the API sends them.
6. Mutations: disable repeat actions, optimistic update with rollback, refetch to confirm.
7. Verify: e2e with mocked delayed, empty, 500, offline, and out-of-order responses; fail the test on console errors and unhandled rejections.

Done-gate: five states reachable in tests; out-of-order test passes; no console errors.
