// The files a session or one of its agents changed with Edit, Write, MultiEdit or NotebookEdit, for commit-gate.mjs: it records them on
// PostToolUse and at a stop gates only those still dirty. Exports: LEAD, realPathOf(file), recordEditedFile(input, env) -> boolean,
// recordedPaths(env, session, agent) -> Set, recordedEntries(status, top, recorded) -> string[].
// Store: ~/.claude/state/commit-gate/edits/<session>.json through lib/session-store.mjs (lstat-checked, locked, 0600):
// {"edits": [[agent id ('' for the lead), real path], ...]}, the newest EDITS_KEPT pairs within MAX_EDITS_BYTES.
// Limit: what a Bash command changes is unknowable here and is never recorded. Invariants: never throws; a failed record is lost (the
// gate then passes that file).
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { readSessionFile, withSessionLock, writeSessionFile } from './session-store.mjs';

export const LEAD = ''; // the agent key of the main session
const STATUS_PATH_AT = 3; // a porcelain entry is `XY <path>`
const RENAME_OR_COPY = /^[RC]|^.[RC]/; // in -z output such an entry is followed by its old path as one more field
const EDITS_KEPT = 2000; // recorded files per session (newest kept); a long lead with many agents changes a few hundred
const MAX_EDITS_BYTES = 1024 * 1024;

const editsDir = (env) => join(env.HOME || env.USERPROFILE || homedir(), '.claude', 'state', 'commit-gate', 'edits');

/** The real path of a file (of its folder when the file is gone), so it compares with git's real worktree path. */
export function realPathOf(file) {
  try {
    return realpathSync(file);
  } catch {
    try {
      return join(realpathSync(dirname(file)), basename(file));
    } catch {
      return resolve(file); // folder gone too: the path as given
    }
  }
}

/** The [agent, path] pairs of a stored edit record; a corrupt or odd record reads as empty. */
function parseEdits(text) {
  try {
    const edits = text === null ? [] : JSON.parse(text)?.edits;
    return (Array.isArray(edits) ? edits : []).filter((edit) => Array.isArray(edit) && edit.every((part) => typeof part === 'string'));
  } catch {
    return [];
  }
}

/** The record as stored text: the newest EDITS_KEPT pairs, fewer when they would pass MAX_EDITS_BYTES. */
function editsText(edits) {
  let kept = edits.slice(-EDITS_KEPT);
  let text = JSON.stringify({ edits: kept });
  while (Buffer.byteLength(text) > MAX_EDITS_BYTES && kept.length > 1) {
    kept = kept.slice(Math.ceil(kept.length / 4));
    text = JSON.stringify({ edits: kept });
  }
  return text;
}

/**
 * Records the file one Edit, Write, MultiEdit or NotebookEdit call changed, for this session and agent.
 * @param {{session_id?: string, agent_id?: string, tool_input?: {file_path?: unknown, notebook_path?: unknown}}} input PostToolUse JSON
 * @param {Record<string, string | undefined>} [env] HOME (the state folder)
 * @returns {boolean} true when recorded; false for no absolute path, a bad session id, an unusable store or a failed write
 */
export function recordEditedFile(input, env = process.env) {
  const toolInput = input?.tool_input ?? {};
  const file = typeof toolInput.file_path === 'string' ? toolInput.file_path : toolInput.notebook_path;
  if (typeof file !== 'string' || !isAbsolute(file)) return false;
  const edit = [typeof input.agent_id === 'string' ? input.agent_id : LEAD, realPathOf(file)];
  const dir = editsDir(env);
  return withSessionLock(dir, input.session_id, () => {
    const text = readSessionFile(dir, input.session_id, MAX_EDITS_BYTES);
    if (text === undefined) return false;
    const others = parseEdits(text).filter(([agent, path]) => agent !== edit[0] || path !== edit[1]);
    return writeSessionFile(dir, input.session_id, editsText([...others, edit]));
  }) === true;
}

/** The real paths recorded for this stop: the agent's own, or every one of the session for the lead. */
export function recordedPaths(env, session, agent) {
  const edits = parseEdits(readSessionFile(editsDir(env), session, MAX_EDITS_BYTES) ?? null);
  return new Set(edits.filter(([by]) => agent === LEAD || by === agent).map(([, path]) => path));
}

/**
 * The `git status --porcelain=v1 -z` entries of recorded files: a file listed itself, or an untracked folder (`dir/`) holding one.
 * @param {string} status the raw output
 * @param {string} top the worktree's real path
 * @param {Set<string>} recorded real paths
 * @returns {string[]} the entries (`XY path`), a rename once
 */
export function recordedEntries(status, top, recorded) {
  const fields = status.split('\0').filter((field) => field !== '');
  const entries = [];
  for (let i = 0; i < fields.length; i += 1) {
    const listed = fields[i].slice(STATUS_PATH_AT);
    const path = join(top, listed);
    const own = listed.endsWith('/') ? [...recorded].some((file) => file.startsWith(path.endsWith(sep) ? path : `${path}${sep}`)) : recorded.has(path);
    if (own) entries.push(fields[i]);
    if (RENAME_OR_COPY.test(fields[i])) i += 1;
  }
  return entries;
}
