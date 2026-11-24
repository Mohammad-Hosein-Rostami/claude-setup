---
name: datetime-handling
description: Use when code stores, parses, compares, shows or schedules dates and times, in the UI or the backend - time zones, DST, date-only values, formats.
---

1. Instants (when something happened) are stored and sent as UTC ISO 8601 with `Z` or an offset; the database type is `timestamptz`, never naive `timestamp`. Date-only values (birthday, due date) are `YYYY-MM-DD` strings or date types and never pass through `Date`/timezone conversion.
2. Convert to the user's zone only at the edge, with `Intl.DateTimeFormat(locale, { timeZone, dateStyle, timeStyle })`; never hand-format (`getMonth()+1`, string slicing). Relative times use `Intl.RelativeTimeFormat`. Week start comes from the locale.
3. `new Date("2026-03-01")` is UTC midnight, `new Date("2026-03-01T00:00")` is local: parse explicitly. Temporal ships in Firefox and Chromium but not Safari or Node 22: use `temporal-polyfill` (prefer `PlainDate`, `ZonedDateTime`, `Instant`) or date-fns/Luxon, wrapped in one module.
4. Do not add 24 h for "tomorrow"; add a calendar day in the zone. Recurring events store an IANA zone id (`Europe/Berlin`), not an offset. Local times can be skipped or repeated on DST days: decide and test both.
5. Backend: take "now" from an injectable clock; compare ranges with `>= start AND < end` (not `BETWEEN`); cron and schedules run in UTC unless a user-facing local time is required, then store zone + local time and test DST days.
6. Tests run under several zones: `TZ=Pacific/Kiritimati`, `TZ=America/Los_Angeles`, `TZ=UTC`, plus DST transition dates and a leap day. Freeze time with fake timers / a clock.
7. Grep for smells before finishing: `new Date(` with strings, `toLocaleString()` with no arguments, `getTimezoneOffset`, `Date.now()` in domain code, `timestamp without time zone`.

Done-gate: tests pass under three zones including a DST date; no naive timestamps; one place formats dates.
