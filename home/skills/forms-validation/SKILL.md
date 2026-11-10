---
name: forms-validation
description: Use when building or changing a form or any user input flow - validation, errors, autofill, double submit, optimistic UI.
---

Pairs with `accessibility-build` (labels, error linking, focus).

1. Validate on the server always; validate on the client for speed, from one shared schema (Zod/Valibot/JSON Schema). The API test must work without the UI.
2. Correct input `type` (`email`, `tel`, `url`, `number`), `inputmode`, and `autocomplete` tokens (`given-name`, `email`, `current-password`, `new-password`, `one-time-code`). Allow paste. Use the Constraint Validation API as the base.
3. Errors: specific and fixable ("Enter an email like name@example.com"), shown on blur or submit, not on each keystroke; after a failed submit focus the first invalid field; keep the user's input.
4. Submit: disable the button while pending and send an idempotency key; a double click makes one request. Show progress and the result; a failed optimistic update rolls back and says so.
5. Long forms warn before leaving with unsaved changes; drafts survive refresh when the data is valuable.
6. Dates and numbers: native pickers or an accessible calendar; accept locale formats; never silently change the value.
7. Verify: e2e double-click test, server-only validation test, failure mocked, keyboard completion, screen-reader label check.

Done-gate: server rejects bad input on its own; one request per submit; errors reachable by keyboard and screen reader.
