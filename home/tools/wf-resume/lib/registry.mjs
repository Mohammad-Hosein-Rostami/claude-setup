// The workflow registry: one small private file per session listing the workflow runs that session launched, so a later session (after an
// exit, a usage-limit stop or an account switch) can find the runs that did not finish.
// Exports: launchRecord(hookInput, nowIso), saveRun(dir, record), runsOfSession(dir, session), latestOtherSession(dir, {cwd, exceptSession}),
//   findRun(dir, runId), launchedWithoutArgs(record), defaultRegistryDir(), MAX_RUNS_PER_SESSION, MAX_ARGS_BYTES.
// File: <dir>/<session>.json holds one JSON record per line (the `.json` name is the session store's, lib/session-store.mjs in the hooks:
// atomic write, 0600 file in a 0700 folder, never through a link). A record: { sessionId, runId, name, scriptPath, argsDigest, args?, started,
// lastLaunch, cwd, row, projectDir }. `projectDir` is the folder name under ~/.claude/projects, so the run folder is
// <projects>/<projectDir>/<sessionId>/subagents/workflows/<runId>; a path from this file is never followed, the folder is rebuilt from names.
// Invariants: a run is recorded only when the tool result names a run id (a refused launch leaves nothing); a resume of the same run id
// updates its record (first start time kept); at most MAX_RUNS_PER_SESSION records per file (oldest dropped); args are stored only up to
// MAX_ARGS_BYTES (a resume needs them, the registry file is as private as the transcript that holds them) and are never printed by the hooks.
// Completion is not stored: it is computed on read from the run folder (lib/run-state.mjs). Nothing here throws.
import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { isSessionId, readSessionFile, writeSessionFile } from '../../../hooks/lib/session-store.mjs';
import { withSessionLock } from '../../../hooks/lib/session-lock.mjs';

export const MAX_RUNS_PER_SESSION = 25;
export const MAX_ARGS_BYTES = 4096;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_SESSIONS_READ = 200; // newest files looked at when searching across sessions
const DIGEST_HEX = 12;
const digestOf = (argsText) => createHash('sha256').update(argsText).digest('hex').slice(0, DIGEST_HEX);
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PROJECT_DIR = /^(?!\.+$)[A-Za-z0-9._-]{1,255}$/;
const ROW_LABEL = /^[A-Za-z0-9._:-]{1,40}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const HAS_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/; // no g flag: a global regex keeps state between test() calls
const MAX_PATH_CHARS = 500;
const MAX_NAME_CHARS = 40;
const STORE_FILE = /^([A-Za-z0-9_-]{1,100})\.json$/;

/** True when the launch had no args at all (the digest of `null`): then there is nothing to pass again. */
export const launchedWithoutArgs = (record) => record.argsDigest === digestOf('null');

export const defaultRegistryDir = () => join(homedir(), '.claude', 'state', 'workflow-runs');

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const cleanText = (text, max) => text.replace(CONTROL_CHARS, '').slice(0, max);
const absolutePath = (value) => (typeof value === 'string' && isAbsolute(value) && value.length <= MAX_PATH_CHARS && !HAS_CONTROL_CHARS.test(value) ? value : null);

/** The run id, script path and workflow name a Workflow tool result names: its fields when it is an object, else its text lines. */
function launchedRun(response) {
  if (isPlainObject(response) && typeof response.runId === 'string') {
    return { runId: response.runId, scriptPath: response.scriptPath, name: response.workflowName };
  }
  const text = typeof response === 'string' ? response : '';
  return { runId: /^Run ID: (\S+)/m.exec(text)?.[1], scriptPath: /^Script file: (.+)$/m.exec(text)?.[1]?.trim(), name: /^Summary: (.+)$/m.exec(text)?.[1] };
}

/**
 * The registry record for a PostToolUse(Workflow) hook input; null when it is not a launch that got a run id.
 * @param {object | null} input the hook JSON (tool_name, tool_input, tool_response, session_id, cwd, transcript_path)
 * @param {string} nowIso the clock as an ISO string
 * @returns {object | null}
 */
export function launchRecord(input, nowIso) {
  if (!isPlainObject(input) || input.tool_name !== 'Workflow' || !isSessionId(input.session_id)) return null;
  const toolInput = isPlainObject(input.tool_input) ? input.tool_input : {};
  const launched = launchedRun(input.tool_response);
  const scriptPath = absolutePath(launched.scriptPath) ?? absolutePath(toolInput.scriptPath);
  if (typeof launched.runId !== 'string' || !RUN_ID.test(launched.runId) || scriptPath === null) return null;
  const argsText = JSON.stringify(toolInput.args ?? null);
  const projectDir = typeof input.transcript_path === 'string' ? basename(dirname(input.transcript_path)) : '';
  const row = toolInput.args?.row;
  return {
    sessionId: input.session_id,
    runId: launched.runId,
    name: cleanText(typeof launched.name === 'string' && launched.name !== '' ? launched.name : 'workflow', MAX_NAME_CHARS),
    scriptPath,
    argsDigest: digestOf(argsText),
    ...(toolInput.args !== undefined && Buffer.byteLength(argsText) <= MAX_ARGS_BYTES ? { args: toolInput.args } : {}),
    started: nowIso,
    lastLaunch: nowIso,
    cwd: absolutePath(input.cwd) ?? '',
    row: typeof row === 'string' && ROW_LABEL.test(row) ? row : null,
    projectDir: PROJECT_DIR.test(projectDir) ? projectDir : '',
  };
}

/** True for a record shaped by launchRecord: a line of a planted or damaged file that is not one is dropped. */
const isRecord = (value) => isPlainObject(value) && isSessionId(value.sessionId) && RUN_ID.test(String(value.runId)) && typeof value.scriptPath === 'string'
  && typeof value.started === 'string' && typeof value.cwd === 'string' && PROJECT_DIR.test(String(value.projectDir)) && typeof value.argsDigest === 'string';

function parseLine(line) {
  try {
    const value = JSON.parse(line);
    return isRecord(value) ? [value] : [];
  } catch {
    return [];
  }
}

/** @returns {object[]} the records of one session's file, oldest first; [] when there is none or it is unusable */
export function runsOfSession(dir, session) {
  const text = readSessionFile(dir, session, MAX_FILE_BYTES);
  return typeof text === 'string' ? text.split('\n').flatMap(parseLine) : [];
}

/**
 * Adds a record, or updates the one with the same run id (a resume): the first start time stays. Takes the session's lock, so two hooks
 * firing together drop nothing.
 * @returns {boolean} true when stored
 */
export function saveRun(dir, record) {
  const stored = withSessionLock(dir, record.sessionId, () => {
    const runs = runsOfSession(dir, record.sessionId);
    const before = runs.find((run) => run.runId === record.runId);
    const merged = before === undefined ? record : { ...record, started: before.started };
    const kept = [...runs.filter((run) => run.runId !== record.runId), merged].slice(-MAX_RUNS_PER_SESSION);
    return writeSessionFile(dir, record.sessionId, `${kept.map((run) => JSON.stringify(run)).join('\n')}\n`, { sweep: false });
  });
  return stored === true;
}

/** The newest session files of the registry folder, newest first: [{ sessionId, mtimeMs }]. */
function sessionFiles(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const session = STORE_FILE.exec(name)?.[1];
    try {
      return session === undefined ? [] : [{ sessionId: session, mtimeMs: statSync(join(dir, name)).mtimeMs }];
    } catch {
      return [];
    }
  }).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_SESSIONS_READ);
}

/**
 * The most recent other session that launched a run in this cwd (the one whose newest run started last).
 * @returns {{ sessionId: string, runs: object[] } | null}
 */
export function latestOtherSession(dir, { cwd, exceptSession }) {
  const candidates = sessionFiles(dir).filter((file) => file.sessionId !== exceptSession)
    .map((file) => ({ sessionId: file.sessionId, runs: runsOfSession(dir, file.sessionId).filter((run) => run.cwd === cwd) }))
    .filter((session) => session.runs.length > 0);
  const newest = (session) => session.runs.reduce((latest, run) => (run.started > latest ? run.started : latest), '');
  return candidates.sort((a, b) => newest(b).localeCompare(newest(a)))[0] ?? null;
}

/** @returns {object | null} the newest record with this run id in any session's file */
export function findRun(dir, runId) {
  for (const file of sessionFiles(dir)) {
    const run = runsOfSession(dir, file.sessionId).find((record) => record.runId === runId);
    if (run !== undefined) return run;
  }
  return null;
}
