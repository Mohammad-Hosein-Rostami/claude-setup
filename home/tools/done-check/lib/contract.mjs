// The shared vocabulary of the done-check (design: docs of road `newchk`, section 6): check kinds, results, why a check did not
// run, the time and size caps, and the JSDoc types every lib passes around. It holds data only and imports nothing, so any lib,
// the CLI, the hook and the tests can load it without side effects.
// Exports: CHECK_KINDS, RESULTS, NOT_RUN_WHY, STOP_DEADLINE_MS, BASE_DEADLINE_MS, LAND_DEADLINE_MS, MAX_BLOCKS_IN_A_ROW,
//   MAX_REASON_LINES_PER_CHECK, MAX_NODE_RELATED, POOL_SIZE, LEDGER_MAX_BYTES, MODEL_PATTERN, EFFORT_PATTERN; types CheckKind,
//   Result, NotRunWhy, Scope, Cmd, Plan, Failure, CheckResult, RunRow, LabelRow, Verdict.
// Invariants: every name is defined here once and nowhere else; the arrays are frozen, so no lib can add a kind or a reason on its own.

const BYTES_PER_MIB = 1024 * 1024;

/** The checks one run can do, in the order the line shows them. */
export const CHECK_KINDS = Object.freeze(['types', 'lint', 'tests', 'tests-weakened']);

/** What one check ends with: `none` = no related test existed (never `ok`), `not-run` = it could not run (see NOT_RUN_WHY). */
export const RESULTS = Object.freeze(['ok', 'fail', 'none', 'not-run']);

/** Why a check did not run. A not-run check never blocks and is never shown as ok. */
export const NOT_RUN_WHY = Object.freeze(['time', 'error', 'no-command', 'no-config', 'no-related', 'skipped-env', 'not-supported', 'e2e-or-live']);

/** Wall-clock cap of all checks together at one stop (ms). */
export const STOP_DEADLINE_MS = 90_000;

/** Wall-clock cap of the base run that finds which failures are old (ms). */
export const BASE_DEADLINE_MS = 30_000;

/** Wall-clock cap of all checks together at a land (ms). */
export const LAND_DEADLINE_MS = 240_000;

/** A stop is blocked at most this many times in a row for one agent; the next stop passes as `left-open`. */
export const MAX_BLOCKS_IN_A_ROW = 2;

/** Lines of one check in the block reason (the rest is counted, not listed). */
export const MAX_REASON_LINES_PER_CHECK = 15;

/** Most node:test files run for one change. */
export const MAX_NODE_RELATED = 40;

/** Most check processes that run at once. */
export const POOL_SIZE = 4;

/** Size cap of the ledger file, shared by the writer and the reader (bytes). */
export const LEDGER_MAX_BYTES = 16 * BYTES_PER_MIB;

/** A model id the ledger stores (`claude-opus-5-5`, `claude-opus-5-5[1m]`, a Bedrock id with `.` and `:`): one short token, never free text. */
export const MODEL_PATTERN = /^[\w.:[\]-]{1,80}$/;

/** An effort level the ledger stores (`low` ... `max`): one short lower-case word. */
export const EFFORT_PATTERN = /^[a-z]{1,16}$/;

/** @typedef {'types'|'lint'|'tests'|'tests-weakened'} CheckKind one of CHECK_KINDS */
/** @typedef {'ok'|'fail'|'none'|'not-run'} Result one of RESULTS */
/** @typedef {'time'|'error'|'no-command'|'no-config'|'no-related'|'skipped-env'|'not-supported'|'e2e-or-live'} NotRunWhy one of NOT_RUN_WHY */

/**
 * The files one agent (or one manual run) changed in one worktree, and the base they are compared with.
 * @typedef {object} Scope
 * @property {string|null} top the git top folder (absolute), or the folder itself when it is not git
 * @property {boolean} git true when `top` is a git worktree
 * @property {string|null} base the base commit (40 hex), or null when there is none and no base compare is possible
 * @property {string[]} files changed code files, repo-relative with `/` separators
 * @property {string[]} named changed non-code files (markdown, json, ...) that a test file names; they only feed the related-test search
 * @property {string[]} wide changed files that widen the check (package.json, lockfiles, tsconfig, test and eslint config), repo-relative
 * @property {string} key the change key: sha256 of the base, the sorted paths with their blob hashes, and the plan fingerprint
 */

/**
 * One command a check runs. It runs as `argv` without a shell, except where `shell` is true (a package-manager script on Windows).
 * @typedef {object} Cmd
 * @property {CheckKind} kind which check it belongs to
 * @property {string[]} argv program and arguments, the program first
 * @property {string} cwd absolute folder to run in (the package root)
 * @property {boolean} shell true only for `<pm> run <script>` on Windows
 * @property {string} label the name shown in the line, for example `vitest` or `tsc -p tsconfig.json`
 * @property {string} [outputFile] where the tool writes its JSON result, when it does not print it
 */

/**
 * What to run for one change.
 * @typedef {object} Plan
 * @property {{ root: string, pm: string, cmds: Cmd[] }[]} packages one entry per package that has changed files
 * @property {{ kind: CheckKind, why: NotRunWhy, label: string }[]} skipped checks that cannot run, named in the line
 * @property {string} fingerprint hash of the commands, so a changed plan gives a changed key
 */

/**
 * One problem a check found.
 * @typedef {object} Failure
 * @property {CheckKind} kind the check that found it
 * @property {string} id the key compared with the base: `file|TScode|message` for types, `test file|full name` for tests
 * @property {string} file repo-relative path with `/` separators
 * @property {number} [line] 1-based line, when the tool gave one
 * @property {string} text the one-line message shown to the agent
 */

/**
 * The outcome of one check.
 * @typedef {object} CheckResult
 * @property {CheckKind} kind which check
 * @property {string} label what ran, for the line
 * @property {Result} result ok, fail, none or not-run
 * @property {number} ms how long it took
 * @property {Failure[]} failures what it found (empty unless `fail`, or `ok` with old failures)
 * @property {number} [total] how many tests or diagnostics the tool reported
 * @property {NotRunWhy} [why] set when the result is `not-run`
 */

/**
 * One line of the ledger for one run of the checks.
 * @typedef {object} RunRow
 * @property {1} v row format version
 * @property {string} id run id
 * @property {string} at ISO time
 * @property {'stop'|'land'|'manual'} where
 * @property {string} session session id ('' when none)
 * @property {string} agent agent id ('' for the lead)
 * @property {string} repo hashed repo id (never a path)
 * @property {string|null} base base commit
 * @property {string} key the change key
 * @property {number} files number of changed files (never their names)
 * @property {Record<string, { result: Result, new: number, old: number, ms: number, flaky?: number, why?: NotRunWhy }>} checks one entry per check kind (`flaky`: new test failures that passed on a rerun at head, left out when 0)
 * @property {Verdict['verdict']} verdict
 * @property {string[]} risk risk classes found
 * @property {number} ms total time
 * @property {string|null} [model] the model of the stopping agent's last reply (from its transcript), null when not known; absent in rows
 *   written before the field existed (both read as `unknown`)
 * @property {string|null} [effort] the effort level of the stopping turn (hook input `effort.level`), null when not known; absent in old rows
 */

/**
 * One owner label on a check of a run.
 * @typedef {object} LabelRow
 * @property {1} v row format version
 * @property {'false-alarm'|'real'|'missed'} label what the owner decided
 * @property {string} run the RunRow id
 * @property {CheckKind} check the check labelled
 * @property {string} at ISO time
 * @property {string} note at most 200 characters, no code
 */

/**
 * What checkChange decides for one change.
 * @typedef {object} Verdict
 * @property {'ok'|'block'|'left-open'|'reused'|'skipped'} verdict
 * @property {string} line the one line the owner sees
 * @property {string|null} reason the text that tells the agent what failed (only for `block`)
 * @property {string[]} risk risk classes of the change
 * @property {RunRow} row the ledger row of this run
 */
