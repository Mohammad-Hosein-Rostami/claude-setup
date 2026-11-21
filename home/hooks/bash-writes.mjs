// PreToolUse, PostToolUse and PostToolUseFailure (Bash): logs for the Stop typecheck gate the code files a Bash command changed.
// Before the command (PreToolUse) it names the candidates, the code files the command may write (lib/code-writes.mjs), and writes one
// before-record `<temp root>/bash-writes/<session>--<agent>--<tool_use_id>`: one JSON line [path, state] per candidate. After the
// command returned or failed it reads that record, takes each candidate's state again, and appends to the agent's edit log
// (lib/edit-log.mjs) the real path of each candidate whose state changed, that is a regular file now and whose real path is a code file;
// then it removes the record. A call that never ran (denied) gets no after-step, so nothing is logged; its record is left to disk-clean.
// Exports: recordBefore(input), logChanged(input), stateOf(path), MAX_BEFORE_RECORD_BYTES, MAX_CANDIDATES, MAX_HASHED_FILE_BYTES.
// State is content, not time: a regular file up to MAX_HASHED_FILE_BYTES is its sha256 (of the text as UTF-8: code files are text), a
// larger one its file-system fields; a link is its own fields plus its target's; anything else is `other` and is never opened.
// Invariants: it logs only content changes after the command ran, under the real path (a link never leads the gate to a named path);
// it never blocks a call, prints nothing and exits 0; every open goes through lib/plain-file.mjs (no link followed, no FIFO waited on);
// doubt logs nothing and writes one guard-log line (`bash-writes-unchecked`, `bash-writes-background`) with counts and ids only, and an
// exception writes `bash-writes-error` with its class. Not a boundary: a process of the same user can delete or rewrite the records.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bashCodeWrites } from './lib/code-writes.mjs';
import { CODE_FILE } from './lib/diagnostics.mjs';
import { checkedTempRoot, editLogPath, recordEdit, smartLogOf } from './lib/edit-log.mjs';
import { logDecision } from './lib/guard-log.mjs';
import { appendPlainFile, readPlainFile } from './lib/plain-file.mjs';
import { MAX_COMMAND_CHARS } from './lib/verdict.mjs';

/** The most a before-record holds, for its writer and its reader: 200 paths of up to 4 KB with their states. */
export const MAX_BEFORE_RECORD_BYTES = 1024 * 1024;
/** The most candidates one call records; the rest are counted as unchecked. */
export const MAX_CANDIDATES = 200;
/** Regular files up to this size are compared by content hash; larger ones by their file-system fields. */
export const MAX_HASHED_FILE_BYTES = 256 * 1024;

const SAFE_ID = /^[\w-]{1,128}$/;
const MAIN_AGENT = 'main';
const MISSING = 'missing';
const UNKNOWN = 'unknown';
const OTHER = 'other';
const AFTER_EVENTS = new Set(['PostToolUse', 'PostToolUseFailure']);

const fields = (s) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
const errorState = (error) => (error?.code === 'ENOENT' ? MISSING : UNKNOWN);

/** The state of a regular file: its content hash, or its fields when it is larger than MAX_HASHED_FILE_BYTES. */
function fileState(path, stat) {
  if (stat.size > BigInt(MAX_HASHED_FILE_BYTES)) return `file:${fields(stat)}`;
  try {
    return `file:${createHash('sha256').update(readPlainFile(path, MAX_HASHED_FILE_BYTES)).digest('hex')}`;
  } catch {
    return UNKNOWN; // swapped for a link, a FIFO or a larger file since the lstat, or unreadable
  }
}

/** The state of what a link points to, from stat (fields only: the target is never opened). */
function targetState(path) {
  try {
    const stat = statSync(path, { bigint: true });
    return stat.isFile() ? `file:${fields(stat)}` : OTHER;
  } catch (error) {
    return errorState(error);
  }
}

/**
 * What the lane compares for one path: `missing`, `unknown`, `other`, `file:<hash or fields>` or `link:<ino>:<ctime>><target state>`.
 * @param {string} path absolute path of a candidate
 * @returns {string} its state; never throws, never opens anything but a regular file
 */
export function stateOf(path) {
  let stat;
  try {
    stat = lstatSync(path, { bigint: true });
  } catch (error) {
    return errorState(error);
  }
  if (stat.isSymbolicLink()) return `link:${stat.ino}:${stat.ctimeNs}>${targetState(path)}`;
  return stat.isFile() ? fileState(path, stat) : OTHER;
}

const isFileNow = (state) => state.startsWith('file:') || /^link:[^>]*>file:/.test(state);

/** The ids of one call and its record path, or null when an id is missing or unsafe (an absent agent id is the main session) or the temp root is refused. */
function callIds(input) {
  const agent = input.agent_id ?? MAIN_AGENT;
  const ids = [input.session_id, agent, input.tool_use_id];
  if (!ids.every((id) => typeof id === 'string' && SAFE_ID.test(id))) return null;
  const root = checkedTempRoot();
  return root === null ? null : { session: input.session_id, agent: input.agent_id, record: join(root, 'bash-writes', ids.join('--')) };
}

/** The command of a Bash or PowerShell call this hook handles, or undefined (settings/base.json matches both shell tools). */
const bashCommand = (input) => (['Bash', 'PowerShell'].includes(input?.tool_name) && typeof input.tool_input?.command === 'string' ? input.tool_input.command : undefined);
const cwdOf = (input) => (typeof input.cwd === 'string' ? input.cwd : process.cwd());

/** Before the command: writes the before-record of its candidates. Writes nothing when it names none or cannot be checked. */
export function recordBefore(input) {
  const command = bashCommand(input);
  if (command === undefined || command.length > MAX_COMMAND_CHARS) return;
  const call = callIds(input);
  const candidates = call ? bashCodeWrites(command, cwdOf(input)) : [];
  if (candidates.length === 0) return;
  const lines = candidates.slice(0, MAX_CANDIDATES).map((path) => `${JSON.stringify([path, stateOf(path)])}\n`);
  mkdirSync(join(call.record, '..'), { recursive: true, mode: 0o700 });
  appendPlainFile(call.record, lines.join(''), { maxBytes: MAX_BEFORE_RECORD_BYTES });
}

/** One guard-log line for this hook; the reason holds counts and ids only. */
function report(outcome, reason, input) {
  logDecision({ hook: 'bash-writes', tool: 'Bash', decision: 'skip', outcome, reason, command: '', session: typeof input?.session_id === 'string' ? input.session_id : undefined });
}
const unchecked = (input, why) => report('bash-writes-unchecked', `${why}: those writes are not logged for the typecheck gate`, input);

/** The before-states of a record, first state per path; throws for anything but a plain file of JSON lines [string, string]. */
function readRecord(path) {
  const states = new Map();
  for (const line of readPlainFile(path, MAX_BEFORE_RECORD_BYTES).split('\n').filter(Boolean)) {
    const entry = JSON.parse(line);
    if (!Array.isArray(entry) || entry.length !== 2 || !entry.every((part) => typeof part === 'string')) throw new SyntaxError('not a [path, state] line');
    if (!states.has(entry[0])) states.set(entry[0], entry[1]);
  }
  return states;
}

/** Compares each recorded path with its state now; logs the changed code files. Returns the counts for the report lines. */
function compareAndLog(states, logPath) {
  const counts = { unchecked: 0, unchanged: 0 };
  for (const [path, before] of states) {
    const after = stateOf(path);
    if (before === UNKNOWN || after === UNKNOWN) counts.unchecked += 1;
    else if (after === before) counts.unchanged += 1;
    else if (isFileNow(after)) logRealPath(path, logPath, counts);
  }
  return counts;
}

/** Logs the real path of a changed file when it is a code file; a real path that cannot be taken is counted as unchecked. */
function logRealPath(path, logPath, counts) {
  let real;
  try {
    real = realpathSync(path);
  } catch {
    counts.unchecked += 1;
    return;
  }
  if (!CODE_FILE.test(real)) return;
  recordEdit(logPath, real);
  recordEdit(smartLogOf(logPath), real); // the smart check's own log (spec r9-smart-check 4)
}

/** After the command ran (PostToolUse) or failed (PostToolUseFailure): logs the candidates whose content changed. */
export function logChanged(input) {
  const command = bashCommand(input);
  if (command === undefined) return;
  if (command.length > MAX_COMMAND_CHARS) return void unchecked(input, `the command is over ${MAX_COMMAND_CHARS} characters`);
  const named = bashCodeWrites(command, cwdOf(input)).length;
  const call = callIds(input);
  const logPath = call && editLogPath(call.session, call.agent);
  if (named === 0) return;
  if (!call || !logPath) return void unchecked(input, `${named} code paths named, and the hook input has no usable session, agent or tool use id, or the temp root is refused`);
  let states;
  try {
    states = readRecord(call.record);
  } catch (error) {
    return void unchecked(input, `${named} code paths named, and the before-record of ${call.record.split('--').at(-1)} is ${error?.code === 'ENOENT' ? 'missing' : 'not usable'}`);
  }
  const counts = compareAndLog(states, logPath);
  counts.unchecked += Math.max(0, named - MAX_CANDIDATES);
  rmSync(call.record, { force: true }); // after the appends: an after-step cut short leaves its record for disk-clean
  if (counts.unchecked > 0) unchecked(input, `${counts.unchecked} of ${named} code paths could not be checked`);
  if (counts.unchanged > 0 && typeof input.tool_response?.backgroundTaskId === 'string') {
    report('bash-writes-background', `${counts.unchanged} code paths of a background command were unchanged when its call returned: its later writes are not logged`, input);
  }
}

/** The hook input, or undefined when stdin is not a JSON object. */
function parseInput(text) {
  try {
    const input = JSON.parse(text);
    return input !== null && typeof input === 'object' ? input : undefined;
  } catch {
    return undefined; // not hook JSON: nothing to record
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const input = parseInput(await readStdin());
  try {
    if (input?.hook_event_name === 'PreToolUse') recordBefore(input);
    else if (AFTER_EVENTS.has(input?.hook_event_name)) logChanged(input);
  } catch (error) {
    report('bash-writes-error', `${error instanceof Error ? error.name : typeof error}: this call's Bash writes are not logged`, input);
  }
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
