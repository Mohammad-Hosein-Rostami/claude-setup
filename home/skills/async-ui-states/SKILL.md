---
name: async-ui-states
description: Use for a screen that loads or changes server data, or whose first screen depends on sign-in, role or saved progress - loading, empty, error, offline, stale responses, pagination, search-as-you-type.
---

1. Every data view has five states, all designed and tested: loading (skeleton the size of the real content), empty (says what to do next), error (says what failed, with Retry), partial/stale, success. Offline shows a clear message (`navigator.onLine` plus failed fetch) and retries.
2. Use a server-state library (TanStack Query, SWR, RTK Query) or one wrapper: stable keys, `staleTime`/`gcTime`, invalidation after mutations, request de-duplication. Do not copy server data into local state.
3. Cancel or ignore stale requests: `AbortController` or key-based caching so a late response A never overwrites newer B. Debounce search input (about 250-300 ms) together with cancellation.
4. Lists: cursor pagination, "Load more" button as the accessible default, infinite scroll only as an enhancement, preserve scroll and filters on back navigation, virtualize beyond a few hundred rows.
5. Every promise is awaited or caught; no unhandled rejections; errors from `fetch` include non-2xx statuses; show problem-details messages when the API sends them.
6. Mutations: disable repeat actions, optimistic update with rollback, refetch to confirm.
7. Entry screens: while the answer that picks the screen is still unknown (session, role, saved step of a flow, feature flag), show only a neutral loader, never a screen the user may not belong on. No sign-in form before the session check ends, no dashboard before the role is known, no step 1 before the saved step loads. Decide the destination before the first content paint (route loader or guard, or a server redirect), not in an effect after a screen has rendered.
8. Verify: e2e with mocked delayed, empty, 500, offline, and out-of-order responses; fail the test on console errors and unhandled rejections. For each entry URL and user state (signed out, signed in, mid-flow, expired session), delay the deciding response, cold-load the URL and record the screens in order: the loader, then the one right screen, nothing in between.

Done-gate: five states reachable in tests; out-of-order test passes; cold-load sequence per entry URL and user state shows no other screen; no console errors.
