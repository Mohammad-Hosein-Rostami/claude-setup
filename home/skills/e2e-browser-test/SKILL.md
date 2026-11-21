---
name: e2e-browser-test
description: Use when writing or fixing end-to-end or browser tests, or when verifying a UI in a real browser.
---

Writing or running these tests happens only when the owner turned `test` on with `/check` (a real-browser check also needs `ui`). Off: say `not checked: test`.

Rules: T1, T4, T8, U3-U5. Critical journeys only (T1).

1. Name the journey. Write steps as user actions, not implementation.
2. Locators by `getByRole`, `getByLabel`, `getByText`; `getByTestId` as fallback; no CSS, XPath or nth-child.
3. Web-first assertions (`await expect(locator).toBeVisible()`, not `expect(await locator.isVisible())`); zero fixed sleeps or `waitForTimeout` (T4).
4. Isolate state: seed own data and own user per test; tests are parallel-safe and order-independent.
5. Cover one happy path and one failure path per journey.
6. Run `@axe-core/playwright` on every page visited; fail on serious or critical violations.
7. Config: `trace: "retain-on-failure"`, `screenshot: "only-on-failure"`. On a failure, open the trace before editing anything.
8. Flaky: fix the wait or the isolation, never add retries as the fix. Run the test 10x (`--repeat-each=10`) before trusting it.
9. Use the project's configured `webServer`; start nothing else unless asked.
10. Pixel match to Figma or layout at several widths is not an e2e journey: use `figma-pixel-perfect` and `ui-check` (`responsive-ui`).

Done-gate (when asked to run): test passes 10x in a row (command and result quoted); no sleeps (grep); axe clean.
