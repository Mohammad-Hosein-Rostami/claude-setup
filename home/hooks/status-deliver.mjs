// Stop: records the hand-over by itself. When the lead's turn ends, runs `status.mjs deliver --auto` on the STATUS.md this session
// last edited (its link in ~/.claude/state/estimate/session/), so a job handed over with nothing open gets its `deliver:N` row and
// the estimator can score its commitment (0 of 16 old commitments were scored: nobody wrote the rows).
// Exports: deliverAtStop(input, { stateDir, now, projectDir }) -> { code, message } | null (null: no usable session id or no link).
// Invariants: never blocks a stop and never prints a decision: stdout stays empty, exit is always 0, a refusal or error is one
// stderr line. deliver --auto itself writes only when no work row is open and one was done after the last hand-over. The hand-over
// goes to the STATUS.md this session last edited with status.mjs, and only when it is inside the Stop input's cwd or
// CLAUDE_PROJECT_DIR (each side resolved with realpathSync.native, the case on disk; outside both: exit 0, no stderr line). That narrows a wrong target, it does not
// rule one out: a subagent shares the session id, so its status.mjs edit moves the link, and a cwd or project dir high up (such
// as ~) holds every project below it.
// Safety (the hook edits a file named in a state file): the stdin JSON is read up to MAX_INPUT_BYTES; the linked path must be
// absolute and named STATUS.md, its folder must be its own real path (no link anywhere in the chain), the file a regular file
// (lstat, never followed) of at most MAX_STATUS_BYTES; status.mjs then edits it under its lock with its own link refusal.
// Stop hooks of one group run side by side, so this one assumes nothing about the others.
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isSessionId } from './lib/session-store.mjs';
import { linkedStatusPath, stateDir as defaultStateDir } from '../tools/estimate/lib/table-store.mjs';
import { runStatus } from '../tools/status/status.mjs';
import { MAX_STATUS_BYTES } from '../tools/status/status-file.mjs';

const MAX_INPUT_BYTES = 1 << 20; // 1 MiB: the Stop JSON carries the last reply; a larger input is not a normal stop and is skipped
const STATUS_NAME = 'STATUS.md';

/** Why the linked path may not be edited, or null when it is a plain STATUS.md in a folder reached without links. */
function unsafeReason(path) {
  if (basename(path) !== STATUS_NAME) return 'is not a STATUS.md';
  let stats;
  try {
    if (realpathSync(dirname(path)) !== dirname(path)) return 'sits behind a link in its folder path';
    stats = lstatSync(path);
  } catch (error) {
    return `cannot be read (${error.code ?? error.message})`;
  }
  if (!stats.isFile()) return 'is a link or not a regular file';
  if (stats.size > MAX_STATUS_BYTES) return `is over ${MAX_STATUS_BYTES} bytes`;
  return null;
}

/**
 * True when folder is root or below it, both resolved with realpathSync.native: it returns the case stored on disk, while the JS
 * realpath keeps the typed case, so on a case-insensitive disk (macOS, Windows) a cwd typed in another case still matches.
 * False for a root that is not a string or does not resolve.
 */
function isWithin(folder, root) {
  if (typeof root !== 'string' || root === '') return false;
  let real;
  let realFolder;
  try {
    real = realpathSync.native(root);
    realFolder = realpathSync.native(folder);
  } catch {
    return false; // a cwd or project dir that does not resolve holds nothing
  }
  return realFolder === real || realFolder.startsWith(real.endsWith(sep) ? real : `${real}${sep}`);
}

/**
 * Runs `deliver --auto` on the session's linked STATUS.md when it lies inside the Stop input's cwd or the project dir.
 * @param {{session_id?: string, cwd?: string} | null} input the Stop hook JSON
 * @param {{stateDir: string, now: Date, projectDir?: string}} options the estimator's store, the clock and CLAUDE_PROJECT_DIR
 * @returns {{code: number, message: string} | null} the status edit's outcome (code 0 also when nothing was due, and when the
 *   STATUS.md is outside both folders: then nothing is written), code 1 when the linked path is refused; null
 *   when the input has no usable session id or the session linked no STATUS.md
 */
export function deliverAtStop(input, { stateDir, now, projectDir }) {
  const sessionId = input?.session_id;
  if (!isSessionId(sessionId)) return null;
  const path = linkedStatusPath(stateDir, sessionId);
  if (path === null) return null;
  const unsafe = unsafeReason(path);
  if (unsafe !== null) return { code: 1, message: `the linked ${path} ${unsafe}: refused` };
  if (!isWithin(dirname(path), input.cwd) && !isWithin(dirname(path), projectDir)) {
    return { code: 0, message: `the linked ${path} is outside this session's cwd and project dir: no hand-over written` };
  }
  return runStatus(['--file', path, 'deliver', '--auto'], { cwd: dirname(path), now, sessionId, stateDir });
}

/** The stdin text, or null when it is longer than MAX_INPUT_BYTES. */
async function boundedStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const text = await boundedStdin();
  if (text === null) return; // not a normal Stop input: nothing to do, and nothing to say
  const outcome = deliverAtStop(JSON.parse(text), { stateDir: defaultStateDir(), now: new Date(), projectDir: process.env.CLAUDE_PROJECT_DIR });
  if (outcome !== null && outcome.code !== 0) process.stderr.write(`status-deliver: ${outcome.message}\n`);
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`status-deliver: ${error.message}\n`); // never trap a session
  }
  process.exitCode = 0;
}
