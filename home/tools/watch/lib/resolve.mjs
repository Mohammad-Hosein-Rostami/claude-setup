// Finds what to watch. Exports: resolveTarget(arg, projectsDir) -> { path, sessionId, label }, findSessionPid(sessionId, sessionsDir),
// isProcessAlive(pid), SESSION_ID.
// A target is either a transcript path (contains a separator or ends in .jsonl; its directory must exist, the file may appear
// later) or a session id, looked up as ~/.claude/projects/*/<id>.jsonl. The id is validated before it touches a path (no globbing,
// no `..`). The label is the first 8 characters of the id. The sessions registry (~/.claude/sessions/<pid>.json) is how a
// session's end is detected: the process behind the id is no longer alive.
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { UsageError } from './args.mjs';

export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$/;
const LABEL_CHARS = 8;
const TRANSCRIPT_EXT = '.jsonl';

const isPath = (arg) => /[\\/]/.test(arg) || arg.endsWith(TRANSCRIPT_EXT);

async function isDirectory(path) {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

/**
 * @param {string} arg session id or transcript path from the command line
 * @param {string} projectsDir ~/.claude/projects
 * @returns {Promise<{ path: string, sessionId: string, label: string }>}
 * @throws {UsageError} when the id is malformed or no transcript carries it, or a path's directory is missing
 */
export async function resolveTarget(arg, projectsDir) {
  if (isPath(arg)) {
    const path = resolve(arg);
    if (!(await isDirectory(dirname(path)))) throw new UsageError(`directory of transcript "${arg}" does not exist`);
    const sessionId = basename(path, TRANSCRIPT_EXT);
    return { path, sessionId, label: sessionId.slice(0, LABEL_CHARS) };
  }
  if (!SESSION_ID.test(arg)) throw new UsageError(`"${arg}" is neither a transcript path nor a session id`);
  let projects = [];
  try { projects = await readdir(projectsDir); } catch { /* no projects folder: reported as not found below */ }
  for (const project of projects) {
    const path = join(projectsDir, project, `${arg}${TRANSCRIPT_EXT}`);
    try {
      if ((await stat(path)).isFile()) return { path, sessionId: arg, label: arg.slice(0, LABEL_CHARS) };
    } catch { /* not in this project folder */ }
  }
  throw new UsageError(`session id ${arg} not found under ${projectsDir}/*/${arg}${TRANSCRIPT_EXT}`);
}

/**
 * @param {string} sessionId the session to look for
 * @param {string} sessionsDir ~/.claude/sessions (one <pid>.json per running Claude Code process)
 * @returns {Promise<number | undefined>} the pid registered for that session, if any
 */
export async function findSessionPid(sessionId, sessionsDir) {
  let names = [];
  try { names = await readdir(sessionsDir); } catch { return undefined; }
  for (const name of names.filter((entry) => entry.endsWith('.json'))) {
    try {
      const record = JSON.parse(await readFile(join(sessionsDir, name), 'utf8'));
      if (record?.sessionId === sessionId && Number.isInteger(record.pid)) return record.pid;
    } catch { /* unreadable or half-written registry file: skip it */ }
  }
  return undefined;
}

/**
 * @param {number} pid process id
 * @returns {boolean} whether a process with that id exists (a process we may not signal still counts as alive)
 */
export function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
