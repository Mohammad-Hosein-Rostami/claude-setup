// Purpose: the owner's control of a run (spec 7.8, 19.2): the files in `<run>/control/` (PAUSE, STOP, <id>.pause, <id>.stop,
//   <id>.takeover, <id>.tell), the driver's reader of them, the check that a session is open in a terminal, and the lines that
//   open a step's session by hand.
// Exports: TELL_MAX_BYTES, OPEN_WINDOW_MS, requestControl, clearControl, queueTell, makeControl, sessionLooksOpen, takeoverLines.
// Invariants: control is files only, so any terminal (or a controller session) can steer a run without talking to the driver;
//   ids are checked before they become file names; a tell message is at most TELL_MAX_BYTES and is kept in order (one JSON line
//   each) until a start takes it; printed commands quote the folder for the shell they are meant for, so a `'` or a space in a
//   path stays one argument.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PRIVATE_FILE_MODE } from '../../account/lib/private-fs.mjs';
import { ID_PATTERN } from './job.mjs';

/** The largest owner message `tell` queues (spec 19.2). */
export const TELL_MAX_BYTES = 8 * 1024;
/** A transcript written to within this window counts as an open session (spec 7.8). */
export const OPEN_WINDOW_MS = 60 * 1000;
const RUN_FILES = { pause: 'PAUSE', stop: 'STOP' };
const UNIT_KINDS = ['pause', 'stop', 'takeover'];

const unitFile = (paths, unitId, kind) => {
  if (!ID_PATTERN.test(unitId)) throw new Error(`not a step id: ${String(unitId).slice(0, 60)}`);
  return join(paths.control, `${unitId}.${kind}`);
};

/**
 * Asks the driver to pause, stop or take over a run or one step.
 * @param {Record<string, string>} paths runPaths().
 * @param {'pause' | 'stop' | 'takeover'} kind what to do (takeover needs a step).
 * @param {string | null} unitId the step or item, or null for the whole run.
 */
export function requestControl(paths, kind, unitId) {
  const path = unitId === null ? join(paths.control, RUN_FILES[kind]) : unitFile(paths, unitId, kind);
  writeFileSync(path, `${new Date().toISOString()}\n`, { mode: PRIVATE_FILE_MODE });
}

/** Removes every pause, stop and takeover file (resume does this); queued messages stay. */
export function clearControl(paths) {
  if (!existsSync(paths.control)) return;
  for (const name of readdirSync(paths.control)) {
    if (!name.endsWith('.tell')) rmSync(join(paths.control, name), { force: true });
  }
}

/**
 * Queues an owner message for a step.
 * @param {Record<string, string>} paths runPaths().
 * @param {string} unitId the step or item.
 * @param {string} message the message, at most TELL_MAX_BYTES bytes.
 * @throws {Error} for an empty or too long message.
 */
export function queueTell(paths, unitId, message) {
  const text = String(message ?? '').trim();
  if (text === '') throw new Error('the message is empty');
  if (Buffer.byteLength(text) > TELL_MAX_BYTES) throw new Error(`the message is over ${TELL_MAX_BYTES} bytes`);
  appendFileSync(unitFile(paths, unitId, 'tell'), `${JSON.stringify({ at: new Date().toISOString(), message: text })}\n`, { mode: PRIVATE_FILE_MODE });
}

function takeTells(paths, unitId) {
  const path = unitFile(paths, unitId, 'tell');
  if (!existsSync(path)) return [];
  const taking = `${path}.taking`;
  renameSync(path, taking); // a message queued from now on goes into a new file for the next start
  const messages = readFileSync(taking, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line).message];
    } catch {
      return []; // a line torn by a killed writer
    }
  });
  rmSync(taking, { force: true });
  return messages.filter((message) => typeof message === 'string');
}

/**
 * The driver's view of the control files.
 * @param {Record<string, string>} paths runPaths().
 * @returns {{runSignal: () => 'pause' | 'stop' | null, unitSignal: (id: string) => 'pause' | 'stop' | 'takeover' | null,
 *   hasTell: (id: string) => boolean, takeTells: (id: string) => string[]}}
 */
export function makeControl(paths) {
  return {
    runSignal: () => (existsSync(join(paths.control, RUN_FILES.stop)) ? 'stop' : existsSync(join(paths.control, RUN_FILES.pause)) ? 'pause' : null),
    unitSignal: (unitId) => UNIT_KINDS.find((kind) => existsSync(unitFile(paths, unitId, kind))) ?? null,
    hasTell: (unitId) => existsSync(unitFile(paths, unitId, 'tell')),
    takeTells: (unitId) => takeTells(paths, unitId),
  };
}

function transcriptFresh(configDir, sessionId, now) {
  const projects = join(configDir, 'projects');
  if (!existsSync(projects)) return false;
  return readdirSync(projects).some((project) => {
    const stat = statSync(join(projects, project, `${sessionId}.jsonl`), { throwIfNoEntry: false });
    return stat !== undefined && now.getTime() - stat.mtimeMs < OPEN_WINDOW_MS;
  });
}

function processHolds(sessionId, platform, runner) {
  const run = platform === 'win32'
    ? runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }'], { encoding: 'utf8', windowsHide: true })
    : runner('ps', ['-axo', 'pid,args'], { encoding: 'utf8' });
  if (run.status !== 0) return false;
  return String(run.stdout).split('\n').some((line) => line.includes(sessionId));
}

/**
 * Why a session looks open in a terminal (its transcript changed in the last minute, or a process names its id), or null.
 * @param {{sessionId: string, env?: object, now?: Date, platform?: string, runner?: Function}} check `runner` stands in for spawnSync.
 * @returns {string | null}
 */
export function sessionLooksOpen({ sessionId, env = process.env, now = new Date(), platform = process.platform, runner = spawnSync }) {
  const configDir = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude');
  if (transcriptFresh(configDir, sessionId, now)) return `its transcript changed in the last ${OPEN_WINDOW_MS / 1000} s`;
  if (processHolds(sessionId, platform, runner)) return 'a running process names its session id';
  return null;
}

const quoteZsh = (text) => `'${String(text).replace(/'/g, "'\\''")}'`;
const quotePowerShell = (text) => `'${String(text).replace(/'/g, "''")}'`;

/**
 * The lines that open a step's session by hand, with its account and folder.
 * @param {{account: string, folder: string, sessionId: string, model: string, platform?: string}} session
 * @returns {string[]} three zsh lines, or one PowerShell line on win32.
 */
export function takeoverLines({ account, folder, sessionId, model, platform = process.platform }) {
  const resume = `claude --resume ${sessionId} --model ${model}`;
  if (platform === 'win32') return [`claude-as ${account}; Set-Location -LiteralPath ${quotePowerShell(folder)}; ${resume}`];
  return [`claude-as ${account}`, `cd ${quoteZsh(folder)}`, resume];
}
