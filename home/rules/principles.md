---
paths: ["**/*.mjs","**/*.cjs","**/*.sh","**/.githooks/**","**/workflows/**","**/settings/*.json"]
---
# Principles for tools, hooks, CI and settings: P1-P16

The lessons of the 85 defects found in earlier review rounds, one row each, so a writer meets them while building. A brief names the
ids that fit its files. They are plain design guidance: ask each question of your own change while you build; nothing is
answered back at hand-off.

id | areas | principle | question to ask yourself
P1 | hooks, guards, anything run by a timeout | One total deadline below the hook timeout; every subprocess has its own timeout; a hostile file system (FIFO, link, /dev/zero, short read) fails closed | Does every read and subprocess end before the hook timeout, and does a FIFO, link or short read deny instead of hang or allow?
P2 | git in hooks and tools | Hardened plumbing commands with pinned output flags; copy proof is a verbatim patch-id plus merge-tree; land the tested sha, never a moving ref | Does every git call use plumbing with fixed flags and a sha, and is the landed sha the tested one?
P3 | gates and land | Fail closed on empty, missing or writer-reported gate input; a missing or failed agent report is incomplete; the aggregate status lists failed members; no ignored result (C9) | If this input is empty, missing or supplied by the writer, does the gate stop instead of pass, and does the aggregate still show a failed member?
P4 | guards and permission exemptions | An exemption is a small allowlist grammar matched on the raw undecoded text; anything else asks | Is every exemption an allowlist on the raw text, so anything unlisted asks?
P5 | any code reading branch names, subjects, headers, file names or other untrusted text | Untrusted text is quoted, refused or capped before it reaches a command, a dialog or the context | Is every untrusted string quoted, refused or length-capped before it is used in a command, dialog or prompt?
P6 | writers and readers of one store | The writer's size cap equals the reader's size cap | Do the writer and the reader of this store use one named cap?
P7 | locks, shared stores, temp names | Own namespace: lock names, shared store keys and temp names are unique per run | Is every lock, key and temp name unique to this run, so two runs cannot collide?
P8 | tools with state or logs | Every write honours the --state-dir or --projects overrides; probes and tests never touch real state | Does every write go through the override, and does the test run under a temp HOME?
P9 | retry loops, timers, nested waits | A retry on a timer backs off on any failure; nested waits sum to less than every outer timeout | Does each retry back off on any failure, and do the nested waits fit inside the outer timeout?
P10 | dialogs, prompts, defaults | Enter never acts as a click and a timeout is reported as a timeout; the owner's timed defaults go ahead marked as timed out; any other default taken for the owner is marked UNCONFIRMED | Does Enter refuse, is a timeout reported as one, and is each default taken marked UNCONFIRMED or timed out?
P11 | paths, branches, platforms | Environment facts: leads start in ~, Windows is primary (drive paths), agent worktree branches are `worktree-agent-*`, APFS paths are case-insensitive | Does the code hold for a start in ~, a drive path, a `worktree-agent-*` branch and a differently cased path?
P12 | parsers, input, tests | Reuse the existing parser (C2); validate input with a schema (C10); no wall-clock asserts in the suite | Is the existing parser reused, the input validated by a schema, and no test asserting elapsed time?
P13 | any lane relying on platform behaviour (hook events, CLI flags, git or shell semantics) | The behaviour is probed and cited in the spec | Is each platform behaviour this lane relies on probed, with the command and result cited?
P14 | trust boundary | Name the boundary each input crosses (owner, agent, repo text, network); a writer's value or repo text never reaches a gate input, command line or path unvalidated | which inputs cross a boundary here, and where is each validated?
P15 | lifecycle symmetry | What install or a run adds (link, lock, temp worktree, record), uninstall, upgrade and every exit path remove or migrate | for each thing this change creates, which code removes it on success, failure, crash and uninstall?
P16 | new state | New state reuses an existing primitive (session-store, session-lock, status rows) and names its stale, crash and old-reader cases | which primitive does it reuse, and what happens when the record is stale, half-written or read by an older reader?
