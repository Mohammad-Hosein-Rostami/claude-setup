# ask

Append-only JSONL queue that lets background agents hand owner decisions to the lead at once. Only the main session can
call AskUserQuestion; agents and workflows cannot, so they `post` and the lead `watch`es. Node 22, no dependencies.

Run: `node ~/.claude/tools/ask/ask.mjs <command>`. `--queue <path>` defaults to env `ASK_QUEUE`.

| Command | What it does |
| ------- | ------------ |
| `init` | Creates `~/.claude/ask/<UTC yyyymmdd-HHMMSS>-<6 hex>.jsonl` (dir 0700, file 0600), prints the path. |
| `post --json '<obj>'` | Validates `{question (>= 15 chars), why, options (2..4 of {label <= 40 chars, effect}), recommended (one label), blocks, from}`, appends `{type:"q", id:"q<n>", ts, ...}`, prints the id. Exit 2 on any violation. |
| `answer <id> (--option N \| --text-stdin \| <text>)` | Appends `{type:"a", id, ts, answer}` (answer <= 2000 chars). Exit 2 on an unknown id; the last answer wins. `--option N` stores the label of option N (no agent text reaches a shell); `--text-stdin` stores the owner's own words. An already-answered id exits 2 and prints the existing answer, so a forged one is noticed; `--force` appends a newer answer and the last answer wins. |
| `show <id>` | Prints the question as capped JSON marked `untrusted:true`, for the lead to build AskUserQuestion from. |
| `get <id>` | Prints the answer, sanitized (exit 0) or `open` (exit 3). |
| `list [--open]` | One line per question: `q3 [open\|answered] <from>: <question>`. |
| `watch [--interval-ms 1000]` | For the Monitor tool: one `ASK(untrusted) q3 from=<from> blocks=<blocks> :: <question>` line per new question, starting with those still open; a question that already has an answer line (written before it) is flagged ` (already answered)`. Reads only new bytes (an over-long line is dropped through its next newline), resets if the file shrinks, survives read errors. Never exits on its own. |

Caps: question 300, why 300, effect 200, label 40, from 60, blocks 120 chars. Ids are `q` plus 1 to 9 digits, 1 + the number of questions (then up while taken, so a planted `q999999999` is harmless; "queue full" past 9 digits), `post` re-reads to confirm the id parses, a line over 8192 chars once escaped is refused, assigned under an exclusive `<queue>.lock` directory (retry, stale after 10 s). `--` ends the flags; an unknown `--flag` is a usage error (exit 2).
Safety: the queue path must be a `~/.claude/ask/<init name>.jsonl` file (symlinks resolved; a file with more than one hard link is refused); `post` and `answer` append with O_APPEND|O_NOFOLLOW and never create a file; every printed field is stripped of control, newline and bidi characters so one record is one line. `init` deletes queue files older than 14 days. Never put secrets in questions.

Malformed queue lines are counted, skipped and reported on stderr; they never throw.
`lib/queue.mjs` holds the pure logic (parse, validate, nextId, openQuestions, answerFor, formatLine, formatWatchLine, formatShow); `lib/store.mjs` the file I/O (confinement, lock, append, incremental read).

Residual risk: agents run as the same OS user, so a hostile agent can still append to the queue. The queue is a convenience channel, not a security boundary; the owner's AskUserQuestion answer, relayed with SendMessage, is authoritative.
