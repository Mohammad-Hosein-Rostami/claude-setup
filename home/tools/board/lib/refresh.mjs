// The board file of a session: what runs, what waits on the owner, and the git state, for the status line, `/where` and the pane
// (spec-p5 `r9-board`). A detached refresh writes it, one at a time, at most every LIVE_EVERY_MS while a run is live and every
// IDLE_EVERY_MS when idle; a refresh over BUDGET_MS keeps the old data and marks the board stale.
// Exports: boardDir(env), readBoard(session, env), runState(run), buildBoard(source, deps), refreshBoard(source, deps) -> boolean,
// startBoardRefresh(session, deps) -> boolean, findTranscript(session, projectsDir); MAX_BOARD_BYTES.
// File: ~/.claude/state/board/<session>.json = { session, at, stale, refreshStartedAt, asking, runs: [{ runId, name, phase,
// phaseIndex, phaseTotal, started, done, lanes, state, quietMin }], git: { branch, ahead, behind, changed } | null } (<= 16 KB).
// States: `run` (journal written in the last QUIET_MIN), `quiet` (QUIET_MIN to STOPPED_MIN), `stopped?` (longer: a killed run has no
// summary json, so it would read live for ever); `needs you` is the session's asking marker. `failed` and `done, not landed`
// need the launch records of phase 3 (`r9-resume`), not on this branch: not shown yet.
// Invariants: journals and transcripts are internal formats: every parser fails soft (workflow-runs.mjs returns [] on anything
// unreadable), so an unreadable part never throws; written through session-store.mjs (no links, 0600, temp file and rename);
// git runs with fixed flags and its own timeout; `git-tidy check` never runs here; nothing here throws.
import { execFileSync, spawn } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAsking } from '../../../hooks/lib/asking-marker.mjs';
import { isSessionId, readSessionFile, writeSessionFile } from '../../../hooks/lib/session-store.mjs';
import { boardRuns } from '../../estimate/lib/workflow-runs.mjs';

export const MAX_BOARD_BYTES = 16 * 1024;
const MS_PER_MIN = 60_000;
const LIVE_EVERY_MS = 10_000;
const IDLE_EVERY_MS = 60_000;
const BUDGET_MS = 300;
const IN_FLIGHT_MS = 30_000; // a claimed refresh that wrote nothing for this long is taken as dead
const QUIET_MIN = 2;
const STOPPED_MIN = 30;
const GIT_TIMEOUT_MS = 250;
const MAX_RUNS = 8;
const BOARD_SCRIPT = fileURLToPath(new URL('../board.mjs', import.meta.url));

/** @returns {string} the folder of the board files (HOME from env, so tests run under a temp home) */
export const boardDir = (env = process.env) => join(env.HOME || homedir(), '.claude', 'state', 'board');

/** @returns {object | null} the session's board, or null when there is none or it cannot be read */
export function readBoard(session, env = process.env) {
  try {
    const text = readSessionFile(boardDir(env), session, MAX_BOARD_BYTES);
    const board = typeof text === 'string' ? JSON.parse(text) : null;
    return board?.session === session ? board : null;
  } catch {
    return null;
  }
}

/** @returns {{ state: 'run' | 'quiet' | 'stopped?', quietMin: number }} a run's state from how long its journal has been quiet */
export function runState(run) {
  const quietMin = Math.floor((run.quietMs ?? 0) / MS_PER_MIN);
  if (quietMin >= STOPPED_MIN) return { state: 'stopped?', quietMin };
  return { state: quietMin >= QUIET_MIN ? 'quiet' : 'run', quietMin };
}

/** The branch, ahead and behind counts and the number of changed paths of `cwd`, or null outside a repo or on any failure. */
function gitState(cwd) {
  try {
    const out = execFileSync('git', ['-C', cwd, 'status', '--porcelain=v2', '--branch'], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
    const lines = out.split('\n').filter(Boolean);
    const head = lines.find((line) => line.startsWith('# branch.head '))?.slice('# branch.head '.length) ?? null;
    const ab = /^# branch\.ab \+(\d+) -(\d+)$/.exec(lines.find((line) => line.startsWith('# branch.ab ')) ?? '');
    return { branch: head, ahead: ab ? Number(ab[1]) : null, behind: ab ? Number(ab[2]) : null, changed: lines.filter((line) => !line.startsWith('#')).length };
  } catch {
    return null;
  }
}

/**
 * The board of a session now (no write).
 * @param {{ session: string, transcriptPath: string | null, cwd: string }} source the session, its transcript and its folder
 * @param {{ env?: object, nowMs?: number }} [deps] tests pass both
 * @returns {object} the board
 */
export function buildBoard({ session, transcriptPath, cwd }, { env = process.env, nowMs = Date.now() } = {}) {
  const runs = boardRuns(transcriptPath, nowMs).slice(0, MAX_RUNS).map((run) => ({
    runId: run.runId, name: run.name, phase: run.phase, phaseIndex: run.phaseIndex, phaseTotal: run.phaseTotal,
    started: run.started, done: run.done, lanes: run.lanes, ...runState(run),
  }));
  const marker = readAsking(session, env, nowMs);
  const asking = marker === null ? null : { kind: marker.kind, count: marker.count, expiresAt: marker.expiresAt };
  return { session, at: nowMs, stale: null, refreshStartedAt: null, asking, runs, git: gitState(cwd) };
}

const isLive = (board) => board?.runs?.some((run) => run.state !== 'stopped?') ?? false;

/** True when a refresh is due: none yet, the last one older than its interval, and none in flight. */
function due(old, nowMs) {
  if (old === null) return true;
  if (old.refreshStartedAt && nowMs - old.refreshStartedAt < IN_FLIGHT_MS && old.refreshStartedAt > old.at) return false;
  return nowMs - old.at >= (isLive(old) ? LIVE_EVERY_MS : IDLE_EVERY_MS);
}

/**
 * One refresh of the session's board, when due: claims it, builds it, writes it; over BUDGET_MS the old data stays, marked stale.
 * @param {{ session: string, transcriptPath: string | null, cwd: string }} source see buildBoard
 * @param {{ env?: object, now?: () => number, force?: boolean }} [deps] force skips the interval (not the claim)
 * @returns {boolean} true when a board was written
 */
export function refreshBoard(source, { env = process.env, now = Date.now, force = false } = {}) {
  try {
    if (!isSessionId(source.session)) return false;
    const dir = boardDir(env);
    const old = readBoard(source.session, env);
    const startMs = now();
    if (!force && !due(old, startMs)) return false;
    if (old !== null) writeSessionFile(dir, source.session, JSON.stringify({ ...old, refreshStartedAt: startMs }));
    const fresh = buildBoard(source, { env, nowMs: startMs });
    const tookMs = now() - startMs;
    const board = tookMs > BUDGET_MS && old !== null ? { ...old, stale: { sinceMs: old.at, tookMs }, refreshStartedAt: null } : fresh;
    const text = JSON.stringify(board);
    return text.length <= MAX_BOARD_BYTES && writeSessionFile(dir, source.session, text);
  } catch {
    return false; // the old board stays; the next refresh tries again
  }
}

/** @returns {string | null} the session's transcript under projectsDir (`<project>/<session>.jsonl`, a plain file), or null */
export function findTranscript(session, projectsDir = join(homedir(), '.claude', 'projects')) {
  if (!isSessionId(session)) return null;
  try {
    for (const project of readdirSync(projectsDir)) {
      const path = join(projectsDir, project, `${session}.jsonl`);
      if (lstatSync(path, { throwIfNoEntry: false })?.isFile()) return path;
    }
  } catch {
    // no projects folder: no transcript
  }
  return null;
}

/**
 * Starts a detached `board.mjs refresh` for the session (status.mjs after a row edit); never waits, never throws.
 * @param {string | undefined} session the session id
 * @param {{ cwd?: string, spawnChild?: typeof spawn }} [deps] tests replace spawn
 * @returns {boolean} true when a child was started
 */
export function startBoardRefresh(session, { cwd = process.cwd(), spawnChild = spawn } = {}) {
  if (!isSessionId(session)) return false;
  try {
    const child = spawnChild(process.execPath, [BOARD_SCRIPT, 'refresh', '--session', session], { cwd, detached: true, stdio: 'ignore' });
    child.on?.('error', () => {}); // a failed start leaves the old board; the next edit or render tries again
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}
