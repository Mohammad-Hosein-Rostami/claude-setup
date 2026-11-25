# 0007: long-run's run lock: one holder rule, and the account as data

- Status: accepted. Date: 2026-11-25.

## Context

`long-run resume <run> --account <name>` (ADR 0006) first took the run's driver lock to write its switch. Six review rounds
each found a narrower edge where the switch's lock and a driver's lock met: a switch taking a starting driver's lock, a
driver after a sleep losing its lock, a refused switch that had already deleted a pause, a crashed run behind a reused pid
that could not be switched, and, where `ps` cannot tell a process's start (Windows, Git Bash), a plain resume's driver
breaking the switch's lock. The account was also read once per step visit, so a driver that started a moment too early kept
the old account.

Drivers: (D1) one live driver per run; (D2) a recorded switch reaches every live step; (D3) a crashed run can always be
resumed, with no refusal that points to another refusal (the old rule is the floor); (D4) a refused command changes nothing;
(D5) a rule a reviewer can check in one read.

## Options

| Option | D1 | D2 | D3 | D4 | D5 |
|---|---|---|---|---|---|
| A. The switch writes run.json and takes no lock; every driver reads the account where it uses it; one holder rule for the lock | ok: exact where ps runs | good | good | good | good |
| B. The switch keeps the lock; one holder rule with a 120 s young-lock clause for every caller | ok | ok: only while every lock edge is right | ok | ok | bad |
| C. The driver listens on a named pipe or unix socket named in the lock; the lock is held while it answers | good | only with A's reads | good | n/a | bad: async checks, socket path limits, a server per driver |

## Decision

A. The account in run.json is data: `start` and `resume --account` write it; a driver reads it at each attempt, in each
wait slice, and at each control poll, where a boss running on another account ends at its next safe point and continues its
own session on the recorded one. A resume runs every check first and its one liveness check last, then writes. The lock is
held while driver.json shows a fresh beat (the old rule), or while the lock's text names a live process on this host that
`ps` shows started when the lock says, or, where `ps` cannot tell, whose start is under 120 s ago; an empty lock under 120 s
old is being written. Anything else is broken by one breaker at a time (the claim file of disk-free's lock-file.mjs).

B loses on D2 and D5: the switch stays a third kind of lock holder, which is where the edges came from. C loses on D5 and
size.

## Consequences

- Good: a switch can no longer take, lose or block a lock; a driver that started early follows the switch within one
  control poll plus one safe point (at most 2 minutes), or one 30 s wait slice. The lock rule is the same for resume, the
  driver, pause, status and prune.
- Bad: one `ps` call per lock take. Where `ps` is missing (Windows, Git Bash), a driver that slept for more than 90 s can still
  lose its lock to a resume in the first 30 s after the wake, as before (two drivers until one ends; both on the recorded
  account). A crashed run whose pid is reused within 120 s of its start stays busy until that time passes.
- Reverse to C if double drivers are ever seen on Windows; drop the live refusal of `resume --account` if owners want to
  switch without a pause (the drivers already follow a switch).

## Sources

- Review history of the account-switch lane, rounds 1-6 (2026-11-25): eight repro tests under tests/long-run-account-switch*.
- Local probe, macOS, Node 26.5.0 (2026-11-25): `writeFileSync(..., { flag: 'wx' })` fails with EEXIST on an existing file and
  on a dangling symlink; `ps -o lstart=` of the own pid is 277 ms from `Date.now() - process.uptime()`; one ps call takes 4 ms.
- The single-breaker pattern already in use: home/tools/disk-free/lib/lock-file.mjs (breakStale).
