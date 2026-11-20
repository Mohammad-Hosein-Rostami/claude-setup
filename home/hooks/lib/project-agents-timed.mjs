// The project-agents note for the SessionStart hook, computed in a child process with a hard timeout.
// Exports: timedProjectAgentNote(sessionDir, personalDir, options), childTimeoutMs(wantedMs, budgetLeftMs), NOTE_TIMEOUT_MS,
// MIN_CHILD_MS, CHILD_ENV_NAMES. Run as a command (no arguments; JSON on stdin:
// { sessionDir, personalDir }) this file is that child: it prints JSON { note } and exits 0.
// Why (review round 3 of p0-0.1: S1, R3-1, R3-7): the note reads folders of whatever repository the session opens, and every review
// round found another folder that cost the session its whole SessionStart output: a chain of folders deeper than the stack, a
// listing of 500,000 names (6.7 s), a link into an automounter. Claude Code drops the output of a hook that passes its timeout
// (2.1.329 bundle: `return zt=!0,{stdout:"",stderr:"Hook cancelled",output:"Hook cancelled",status:1,aborted:!0}`), so the lead
// rules and the playbook were lost together with the note. Now only the note can be lost, and then the hook says so.
// Invariants: never throws. Any failure of the child (timeout, crash, non-zero exit, no output, more output than
// CHILD_OUTPUT_MAX_BYTES, output that is not JSON of the shape { note }, a note that is not in the note's form or is longer than
// NOTE_MAX_CHARS) gives NOT_CHECKED_NOTE: fixed text with no advice to edit anything, never silence and never a guess. The child
// gets the two paths as data on stdin, never as arguments, an environment of CHILD_ENV_NAMES only (no token of the session), and
// its script's folder as working folder, never the session folder (a later node that reads a config file from the working folder
// would read the repository's). Its output is untrusted in form, since it comes from a process that read a repository: it is used
// only when it is '' or one line of at most NOTE_MAX_CHARS characters that starts with NOTE_START and is printable ASCII, which is
// all the child's own escaping lets through (a personal agent with a name outside ASCII would get the fixed text; the owner's set
// has none: tests/agent-files.test.mjs). NOTE_MAX_CHARS is the one cap
// of the writer (cappedNote) and of this reader; a note that is longer because the owner's own set of agents outgrew the cap
// (project-agents-text.mjs) is replaced by the fixed text too, so the SessionStart output keeps its size.
// Time: the hook's timeout is 5,000 ms (settings/base.json) and mode.mjs keeps one deadline below it (HOOK_BUDGET_MS, shared
// with its `ps` lookups). The child is killed (SIGKILL) after min(NOTE_TIMEOUT_MS = 2,000 ms, what is left of that budget); with
// less than MIN_CHILD_MS left it is not started and the note is NOT_CHECKED_NOTE. The rest of mode.mjs at SessionStart measured
// about 35 ms. Not covered: a child that cannot be killed because it hangs inside the kernel (a dead network mount).
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NOTE_MAX_CHARS, NOTE_START, NOT_CHECKED_NOTE } from './project-agents-text.mjs';

export const NOTE_TIMEOUT_MS = 2000;
// One JSON line: a note of NOTE_MAX_CHARS characters is at most 6 bytes each as JSON escapes, far below this.
const CHILD_OUTPUT_MAX_BYTES = 16 * 1024;
const CHILD_SCRIPT = fileURLToPath(import.meta.url);
export const MIN_CHILD_MS = 100; // a child given less time than this could not finish: node alone needs about 30 ms to start
export const CHILD_ENV_NAMES = ['PATH', 'SystemRoot']; // what node needs to start; nothing else of the hook's environment is passed on
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/; // all that the child's escaping of repository names lets through (shown-name.mjs)
const NOTE_KEY = 'note';

/** Whether a value is a note the hook's own code could have printed: nothing, or one line in the note's form within the cap. */
function isNote(value) {
  if (typeof value !== 'string') return false;
  return value === '' || (value.startsWith(NOTE_START) && value.length <= NOTE_MAX_CHARS && PRINTABLE_ASCII.test(value));
}

/** The note a finished child printed; undefined when the child failed or its output is not exactly { note: <a note> }. */
function noteFrom(result) {
  if (result.error || result.signal || result.status !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout);
    const keys = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : [];
    return keys.length === 1 && keys[0] === NOTE_KEY && isNote(parsed[NOTE_KEY]) ? parsed[NOTE_KEY] : undefined;
  } catch {
    return undefined; // not JSON
  }
}

/**
 * How long the child may run: its own limit or what is left of the hook's budget, whichever is less, in whole milliseconds.
 * @param {number} wantedMs - the child's own limit.
 * @param {number} budgetLeftMs - milliseconds left of the hook's budget (Infinity: no budget).
 * @returns {number | undefined} the timeout; undefined when less than MIN_CHILD_MS is left: the child is not started.
 */
export function childTimeoutMs(wantedMs, budgetLeftMs) {
  const timeoutMs = Math.floor(Math.min(wantedMs, budgetLeftMs));
  return timeoutMs >= MIN_CHILD_MS ? timeoutMs : undefined; // NaN compares false: not started
}

/**
 * The project-agents note (see project-agents.mjs), computed by a child process that is killed after a fixed time.
 * @param {string} sessionDir - the session's folder (the hook input's `cwd`).
 * @param {string} personalDir - the personal agents folder (`~/.claude/agents`).
 * @param {{ script?: string, timeoutMs?: number, budgetLeftMs?: number }} [options] - `budgetLeftMs`: milliseconds left of the
 *   hook's budget (mode.mjs); for tests: another child script, another limit for the child.
 * @returns {string} the child's note ('' when there is nothing to say or no session folder), or NOT_CHECKED_NOTE when the child
 *   failed in any way or the budget left no time to start it.
 */
export function timedProjectAgentNote(sessionDir, personalDir, { script = CHILD_SCRIPT, timeoutMs = NOTE_TIMEOUT_MS, budgetLeftMs = Infinity } = {}) {
  if (typeof sessionDir !== 'string' || sessionDir === '' || typeof personalDir !== 'string') return '';
  const timeout = childTimeoutMs(timeoutMs, budgetLeftMs);
  if (timeout === undefined) return NOT_CHECKED_NOTE;
  try {
    const env = Object.fromEntries(CHILD_ENV_NAMES.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
    const result = spawnSync(process.execPath, [script], {
      input: JSON.stringify({ sessionDir, personalDir }),
      encoding: 'utf8',
      env,
      cwd: dirname(script),
      timeout,
      killSignal: 'SIGKILL',
      maxBuffer: CHILD_OUTPUT_MAX_BYTES,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return noteFrom(result) ?? NOT_CHECKED_NOTE;
  } catch {
    return NOT_CHECKED_NOTE; // the child could not be started
  }
}

/** The child: reads { sessionDir, personalDir } from stdin and prints { note }. A throw ends it with a non-zero exit. */
async function runAsChild() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const { sessionDir, personalDir } = JSON.parse(raw);
  const { projectAgentNote } = await import('./project-agents.mjs'); // loaded here only: the hook's own process never runs the walk
  process.stdout.write(JSON.stringify({ [NOTE_KEY]: projectAgentNote(sessionDir, personalDir) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await runAsChild();
