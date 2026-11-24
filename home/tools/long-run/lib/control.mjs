// Purpose: the owner's control of a run (spec 7.8, 19.2): the files in `<run>/control/` (PAUSE, STOP, <id>.pause, <id>.stop,
//   <id>.takeover, <id>.tell), the driver's reader of them, the check that a session is open in a terminal, and the lines that
//   open a step's session by hand.
// Exports: TELL_MAX_BYTES, OPEN_WINDOW_MS, requestControl, clearControl, queueTell, makeControl, hasTranscript, sessionLooksOpen,
//   takeoverLines.
// Invariants: control is files only, so any terminal (or a controller session) can steer a run without talking to the driver;
//   ids are checked before they become file names; a tell message is at most TELL_MAX_BYTES and is one file of its own
//   (`<id>.<time>-<count>-<random>.tell`, written whole by rename, so two `tell`s at once never mix; audit H14), taken in time order by
//   the next start; a `<id>.tell` file of JSON lines from an older runner is still read; printed commands quote the folder for the shell they are meant for, so a `'` or a space in a
//   path stays one argument.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PRIVATE_FILE_MODE, writeFileAtomic } from '../../account/lib/private-fs.mjs';
import { ID_PATTERN } from './job.mjs';

/** The largest owner message `tell` queues (spec 19.2). */
export const TELL_MAX_BYTES = 8 * 1024;
/** A transcript written to within this window counts as an open session (spec 7.8). */
export const OPEN_WINDOW_MS = 60 * 1000;
const RUN_FILES = { pause: 'PAUSE', stop: 'STOP' };
const UNIT_KINDS = ['pause', 'stop', 'takeover'];
const TELL_TIME_DIGITS = 15; // milliseconds since 1970, zero-padded so the names sort in time order
const TELL_SEQ_DIGITS = 6; // then this process's count, so two messages of one millisecond keep their order
let tellSeq = 0;

function checkId(unitId) {
  if (!ID_PATTERN.test(unitId)) throw new Error(`not a step id: ${String(unitId).slice(0, 60)}`);
}

const unitFile = (paths, unitId, kind) => {
  checkId(unitId);
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
 * Queues an owner message for a step, as one file of its own.
 * @param {Record<string, string>} paths runPaths().
 * @param {string} unitId the step or item.
 * @param {string} message the message, at most TELL_MAX_BYTES bytes.
 * @throws {Error} for an empty or too long message.
 */
export function queueTell(paths, unitId, message) {
  const text = String(message ?? '').trim();
  if (text === '') throw new Error('the message is empty');
  if (Buffer.byteLength(text) > TELL_MAX_BYTES) throw new Error(`the message is over ${TELL_MAX_BYTES} bytes`);
  tellSeq += 1;
  const name = `${String(Date.now()).padStart(TELL_TIME_DIGITS, '0')}-${String(tellSeq).padStart(TELL_SEQ_DIGITS, '0')}-${randomUUID()}`;
  writeFileAtomic(unitFile(paths, unitId, `${name}.tell`), `${JSON.stringify({ at: new Date().toISOString(), message: text })}\n`);
}

/** The tell files of a step, oldest first: its own message files and an older runner's `<id>.tell`. */
function tellFiles(paths, unitId) {
  checkId(unitId); // the id goes into a pattern below
  if (!existsSync(paths.control)) return [];
  const legacy = `${unitId}.tell`;
  const own = new RegExp(`^${unitId}\\.\\d{${TELL_TIME_DIGITS}}-\\d{${TELL_SEQ_DIGITS}}-[0-9a-f-]{36}\\.tell$`);
  const names = readdirSync(paths.control);
  const ordered = [...names.filter((name) => name === legacy), ...names.filter((name) => own.test(name)).sort()];
  return ordered.map((name) => join(paths.control, name));
}

function readTellFile(path) {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line).message];
    } catch {
      return []; // a line torn by a killed writer of an older runner's file
    }
  });
}

function takeTells(paths, unitId) {
  const messages = [];
  for (const path of tellFiles(paths, unitId)) {
    messages.push(...readTellFile(path));
    rmSync(path, { force: true });
  }
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
    hasTell: (unitId) => tellFiles(paths, unitId).length > 0,
    takeTells: (unitId) => takeTells(paths, unitId),
  };
}

const configDirOf = (env) => env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude');

/** The stats of every transcript of `sessionId` (Claude Code keeps it at `<config>/projects/<project>/<session>.jsonl`). */
function transcriptStats(configDir, sessionId) {
  const projects = join(configDir, 'projects');
  if (!existsSync(projects)) return [];
  return readdirSync(projects).flatMap((project) => statSync(join(projects, project, `${sessionId}.jsonl`), { throwIfNoEntry: false }) ?? []);
}

const transcriptFresh = (configDir, sessionId, now) => transcriptStats(configDir, sessionId).some((stat) => now.getTime() - stat.mtimeMs < OPEN_WINDOW_MS);

/**
 * Whether Claude Code has a transcript of `sessionId`, so `--resume` can find it (a crash before the spawn, or the 30-day
 * transcript cleanup, leaves none).
 * @param {{sessionId: string, env?: object}} session
 * @returns {boolean}
 */
export const hasTranscript = ({ sessionId, env = process.env }) => transcriptStats(configDirOf(env), sessionId).length > 0;

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
  if (transcriptFresh(configDirOf(env), sessionId, now)) return `its transcript changed in the last ${OPEN_WINDOW_MS / 1000} s`;
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
