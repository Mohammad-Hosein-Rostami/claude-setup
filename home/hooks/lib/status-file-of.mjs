// The STATUS.md a session's hooks work on: the one it last edited with `status.mjs` (its link under ~/.claude/state/estimate/session/),
// after the safety checks. Used by status-deliver.mjs (writes a hand-over) and git-tidy-gate.mjs (reads the open rows).
// Exports: statusFileOf(input, { stateDir, projectDir }) -> { path } | { code, message } | null (null: no usable session id or no link;
//   { code: 1 }: the linked path is refused; { code: 0 }: it lies outside the Stop input's cwd and the project dir).
// Invariants: reads only; the path is returned only when it is an absolute STATUS.md reached without links, a regular file of at most
//   MAX_STATUS_BYTES, inside the input's cwd or CLAUDE_PROJECT_DIR (each side resolved with realpathSync.native, the case on disk).
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, sep } from 'node:path';
import { isSessionId } from './session-store.mjs';
import { linkedStatusPath } from '../../tools/estimate/lib/table-store.mjs';
import { MAX_STATUS_BYTES } from '../../tools/status/status-file.mjs';

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
 * @param {{session_id?: string, cwd?: string} | null} input a hook JSON
 * @param {{stateDir: string, projectDir?: string}} options the estimator's store and CLAUDE_PROJECT_DIR
 * @returns {{path: string} | {code: number, message: string} | null} see the header
 */
export function statusFileOf(input, { stateDir, projectDir }) {
  const sessionId = input?.session_id;
  if (!isSessionId(sessionId)) return null;
  const path = linkedStatusPath(stateDir, sessionId);
  if (path === null) return null;
  const unsafe = unsafeReason(path);
  if (unsafe !== null) return { code: 1, message: `the linked ${path} ${unsafe}: refused` };
  if (!isWithin(dirname(path), input.cwd) && !isWithin(dirname(path), projectDir)) {
    return { code: 0, message: `the linked ${path} is outside this session's cwd and project dir: no hand-over written` };
  }
  return { path };
}
