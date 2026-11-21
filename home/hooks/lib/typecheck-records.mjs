// What the typecheck gate writes down: the run log for the owner, and the small records beside a session's edit log that
// one stop leaves for the next. Split from typecheck-gate.mjs, which would pass 300 lines with it.
// Exports: MAX_RUN_LOG_BYTES, runLogPath(env), runLogWriter(session, agent), lastPath(logPath), shownPath(logPath),
// firstLine(path), replaceRecord(path, text, maxBytes), readTimeouts(logPath), keepRecords(logPath, {keep, timeouts}).
// Run log: one JSON line per check in ~/.claude/logs/typecheck-gate.jsonl (override: CLAUDE_TYPECHECK_LOG). At
// MAX_RUN_LOG_BYTES it takes one last line, `"outcome":"log full"`, padded to the cap so that nothing fits after it. A path
// that holds a link, a FIFO or a folder is never written and is reported once per stop in the guard log
// (`run-log-unwritable`). The log is best effort: a failure here never changes the gate's decision.
// Records (`<edit log>.last`, `.shown`, `.timeouts`, and the edit log itself when the gate rewrites it): they sit in the
// shared temp folder, so every one is read and written through lib/plain-file.mjs (no link followed, no wait on a FIFO,
// regular files only, a size cap) and is replaced by removing the name first, which never touches a link's target.
import { lstatSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { MAX_EDIT_LOG_BYTES } from './edit-log.mjs';
import { logDecision } from './guard-log.mjs';
import { appendPlainFile, readPlainFile } from './plain-file.mjs';

/** The most the run log holds: 1 MB is about 3,000 lines; the log cannot fill the disk. */
export const MAX_RUN_LOG_BYTES = 1024 * 1024;
const RUN_LOG_FILE = join(homedir(), '.claude', 'logs', 'typecheck-gate.jsonl');
const RUN_LOG_DIR_MODE = 0o700; // the log names project folders: only the owner reads it
const MAX_PADDING_BYTES = 4096; // a line is far shorter; more room than this means the line was not refused for the cap
const MAX_RECORD_BYTES = 64 * 1024; // `.last` holds at most 15 lines of 400 characters, `.timeouts` one 64-character id per check
const LOG_FULL = 'log full';

/** @returns {string} where the run log is: CLAUDE_TYPECHECK_LOG or ~/.claude/logs/typecheck-gate.jsonl */
export const runLogPath = (env = process.env) => env.CLAUDE_TYPECHECK_LOG || RUN_LOG_FILE;

let reported = false;

// One guard-log line per stop for a run log that cannot be written: a gate whose runs leave no trace must not pass unseen.
function reportUnwritable(why) {
  if (reported) return;
  reported = true;
  const reason = `the typecheck run log is not a plain file that can be written (${why}): this stop's checks are not recorded`;
  logDecision({ hook: 'typecheck-gate', tool: 'run-log', decision: 'skip', outcome: 'run-log-unwritable', reason, command: '' });
}

// A line was refused: at the cap, say so once in the file itself; anything but a regular file is reported.
function markFull(path) {
  const stat = lstatSync(path);
  if (!stat.isFile()) return reportUnwritable('not a regular file');
  const room = MAX_RUN_LOG_BYTES - stat.size;
  const mark = JSON.stringify({ ts: new Date().toISOString(), outcome: LOG_FULL });
  if (room > mark.length && room <= MAX_PADDING_BYTES) appendPlainFile(path, `${mark.padEnd(room - 1)}\n`, { maxBytes: MAX_RUN_LOG_BYTES });
}

/**
 * The writer of this stop's run-log lines.
 * @param {string} session hook input `session_id`, already checked as a safe id
 * @param {string} agent the agent id, or `main`
 * @returns {(entry: {dir: string, outcome: string, exit: number | string | null, ms: number}) => void} appends one line; never throws
 */
export function runLogWriter(session, agent) {
  return (entry) => {
    try {
      const path = runLogPath();
      mkdirSync(dirname(path), { recursive: true, mode: RUN_LOG_DIR_MODE });
      const line = `${JSON.stringify({ ts: new Date().toISOString(), session, agent, ...entry })}\n`;
      if (!appendPlainFile(path, line, { maxBytes: MAX_RUN_LOG_BYTES })) markFull(path);
    } catch (error) {
      reportUnwritable(error?.code ?? 'unwritable'); // a link (ELOOP), a FIFO nobody reads (ENXIO), a folder (EISDIR)
    }
  };
}

/** Record of the failure that last blocked a stop: its hash, then its lines. */
export const lastPath = (logPath) => `${logPath}.last`;
/** Record of a failure the user was already shown: its hash. */
export const shownPath = (logPath) => `${logPath}.shown`;
const timeoutsPath = (logPath) => `${logPath}.timeouts`; // ids of the checks that timed out at the last stop

// The text of a record; '' when there is none or the name holds anything but a plain file within the cap.
function readRecord(path) {
  try {
    return readPlainFile(path, MAX_RECORD_BYTES);
  } catch {
    return ''; // nothing recorded, or not a record this hook wrote
  }
}

/** The first line of a record (the hash in `.last` and `.shown`), or null when nothing is recorded there. */
export const firstLine = (path) => readRecord(path).split('\n', 1)[0] || null;

/**
 * Replaces a record with `text` (an empty text only removes it). Never throws: a record that cannot be written costs the
 * repeat guard or one more check, and the decision of this stop stands.
 * @param {string} path the record
 * @param {string} text its new content
 * @param {number} [maxBytes] the most it may hold
 */
export function replaceRecord(path, text, maxBytes = MAX_RECORD_BYTES) {
  try {
    rmSync(path, { force: true }); // removes a link or a FIFO planted at the name, never what it points at
    if (text) appendPlainFile(path, text, { maxBytes });
  } catch {
    // see above
  }
}

/** The ids of the checks that timed out at the last stop of this agent. */
export const readTimeouts = (logPath) => new Set(readRecord(timeoutsPath(logPath)).split('\n').filter(Boolean));

/**
 * Leaves for the next stop what this one could not finish: the edit log holds only the files still to check, and the
 * timeouts record the checks that timed out now.
 * @param {string} logPath edit log of this agent
 * @param {{keep: string[], timeouts: string[]}} left files whose entries stay, and ids of the checks that timed out
 */
export function keepRecords(logPath, { keep, timeouts }) {
  const lines = (items) => [...new Set(items)].map((item) => `${item}\n`).join('');
  replaceRecord(logPath, lines(keep), MAX_EDIT_LOG_BYTES);
  replaceRecord(timeoutsPath(logPath), lines(timeouts));
}
