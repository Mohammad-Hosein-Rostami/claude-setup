// The board file of a session: what runs, which agents work on what and how far they are, what waits on the owner, and the git state of
// every worktree, for the status line, `/where` and the pane (spec-p5 `r9-board`, spec-tui "Data and speed"). A detached refresh
// writes it, one at a time, at most every LIVE_EVERY_MS while a run or an agent is live and every IDLE_EVERY_MS when idle; a refresh
// over BUDGET_MS keeps the old data and marks the board stale (the agent cursors and git cache it read are kept all the same).
// Exports: boardDir(env), readBoard(session, env), runState(run), buildBoard(source, deps), collectBoard(source, deps) -> { board,
// cache }, refreshBoard(source, deps) -> boolean, claimBoardRefresh(session, deps) -> boolean, startBoardRefresh(session, deps) ->
// boolean, findTranscript(session, projectsDir); MAX_BOARD_BYTES.
// File: ~/.claude/state/board/<session>.json = { session, at, stale, refreshStartedAt, asking, runs: [{ runId, name, phase,
// phaseIndex, phaseTotal, started, done, lanes, state, quietMin, purpose, agentsTotal, agentsDone, pct, leftMin, running, quiet }],
// agents: [agents.mjs entries plus repo (its repository's name), wt, branch], repo: git-state.mjs repo plus { tip, suite, landed } (repo-stats.mjs) | null,
// repos: the other repositories with work (repos.mjs, same shape without the stats), git: { branch, ahead, behind, changed } | null,
// road: job-facts.mjs road | null, trend: { deltaMin, atMs } | null }
// (<= MAX_BOARD_BYTES: done agents go first, then the oldest, until it fits). Cache (cache-file.mjs, <session>.json): { cursors, git,
// job, stats }. The repositories (repos.mjs) are only those the setup vouches for: the session folder's, the STATUS.md folder's, the
// road's `repo`, each agent's `meta.worktreePath` and the writers' launch folders, with the worktrees their own `worktree list`
// names; agents are matched to those worktrees by the folders of the files they changed or read (owner report 2026-11-21: no git
// info at all; review SEC-1: git never runs where a tool call points). One refresh at a time per session: a lock file with the
// refresher's pid, taken over when that process is gone or the lock is LOCK_STALE_MS old (review SEC-2: a hung refresh must not
// be joined by a new one every IN_FLIGHT_MS).
// After the write, the agent-type pools (pools.mjs) are rebuilt when an hour old, outside the budget.
// States: `run` (journal written in the last QUIET_MIN), `quiet` (QUIET_MIN to STOPPED_MIN), `stopped?` (longer: a killed run has no
// summary json, so it would read live for ever); `needs you` is the session's asking marker. `failed` and `done, not landed`
// need the launch records of phase 3 (`r9-resume`), not on this branch: not shown yet.
// Invariants: journals and transcripts are internal formats: every parser fails soft, so an unreadable part never throws; written
// through session-store.mjs (no links, 0600, temp file and rename); git runs only in git-state.mjs, with fixed flags and its own
// timeouts; `git-tidy check` never runs here; nothing here throws.
import { spawn } from 'node:child_process';
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync, writeSync } from 'node:fs';
import { readPlainFile } from '../../../hooks/lib/plain-file.mjs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAsking } from '../../../hooks/lib/asking-marker.mjs';
import { isSessionId, readSessionFile, writeSessionFile } from '../../../hooks/lib/session-store.mjs';
import { boardRuns } from '../../estimate/lib/workflow-runs.mjs';
import { sessionAgents } from './agents.mjs';
import { readCacheFile, writeCacheFile } from './cache-file.mjs';
import { jobFacts } from './job-facts.mjs';
import { repoStats } from './repo-stats.mjs';
import { placeAgents, sessionRepos } from './repos.mjs';
import { poolsDue, readPools, rebuildPools } from './pools.mjs';

export const MAX_BOARD_BYTES = 48 * 1024;
const MAX_CACHE_BYTES = 512 * 1024;
const MS_PER_MIN = 60_000;
const LIVE_EVERY_MS = 5_000; // the settings' refreshInterval: agent rows and a question's countdown move every 5 s
const IDLE_EVERY_MS = 60_000;
const BUDGET_MS = 300;
const IN_FLIGHT_MS = 30_000; // a claimed refresh that wrote nothing for this long is taken as dead
const QUIET_MIN = 2;
const STOPPED_MIN = 30;
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

/** The board without its oldest or finished agents until it fits MAX_BOARD_BYTES. */
function fitted(board) {
  const agents = [...board.agents];
  let text = JSON.stringify({ ...board, agents });
  while (text.length > MAX_BOARD_BYTES && agents.length > 0) {
    const doneAt = agents.findLastIndex((agent) => agent.state === 'done');
    agents.splice(doneAt >= 0 ? doneAt : agents.length - 1, 1);
    text = JSON.stringify({ ...board, agents });
  }
  return { ...board, agents };
}

/**
 * The board of a session now and the cache it read through (no write).
 * @param {{ session: string, transcriptPath: string | null, cwd: string }} source the session, its transcript and its folder
 * @param {{ env?: object, nowMs?: number, cache?: object | null, pools?: object | null }} [deps] tests pass env and nowMs
 * @returns {{ board: object, cache: { cursors: object, git: object } }} the board and the cache to store
 */
export function collectBoard({ session, transcriptPath, cwd }, { env = process.env, nowMs = Date.now(), cache = null, pools = null } = {}) {
  const runs = boardRuns(transcriptPath, nowMs).slice(0, MAX_RUNS).map((run) => ({
    runId: run.runId, name: run.name, phase: run.phase, phaseIndex: run.phaseIndex, phaseTotal: run.phaseTotal,
    started: run.started, done: run.done, lanes: run.lanes, ...runState(run),
  }));
  const sessionFolder = typeof transcriptPath === 'string' ? join(dirname(transcriptPath), basename(transcriptPath, '.jsonl')) : null;
  const found = sessionFolder === null ? { agents: [], runs, cursors: {} }
    : sessionAgents({ session, sessionFolder, runs, cursors: cache?.cursors ?? {}, pools, env, nowMs });
  const job = jobFacts({ session, cwd, cache: cache?.job ?? null, nowMs });
  const statusDir = typeof job.cache?.path === 'string' ? dirname(job.cache.path) : null;
  // Trusted folders only (review SEC-1 of 9ac483c3): where the owner or the setup put the work, never a folder a tool call named.
  const trusted = [cwd, statusDir, job.repoDir, ...(found.launchDirs ?? []), ...found.agents.map((agent) => agent.places?.worktree)];
  const gitStartMs = Date.now(); // one git budget for the whole refresh (git-state.mjs GIT_BUDGET_MS), repo-stats included
  const git = sessionRepos({ folders: trusted, cache: cache?.git ?? null, nowMs, startMs: gitStartMs });
  const placed = placeAgents(found.agents, git.repos);
  const [primary = null, ...others] = placed.repos;
  const mainPath = primary?.worktrees.find((wt) => wt.main)?.path ?? null;
  const stats = repoStats({ repoDir: mainPath, base: primary?.base ?? null, cache: cache?.stats ?? null, nowMs, startMs: gitStartMs });
  const repo = primary === null ? null : { ...primary, tip: stats.stats?.tip ?? null, suite: stats.stats?.suite ?? null, landed: stats.stats?.landed ?? null };
  const marker = readAsking(session, env, nowMs);
  const asking = marker === null ? null : { kind: marker.kind, count: marker.count, expiresAt: marker.expiresAt };
  const board = {
    session, at: nowMs, stale: null, refreshStartedAt: null, asking, runs: found.runs, agents: placed.agents, repo,
    repos: others, git: git.git, road: job.road, trend: job.trend,
  };
  return { board: fitted(board), cache: { cursors: found.cursors, git: git.cache, job: job.cache, stats: stats.cache } };
}

/** @returns {object} the board of a session now (no write; see collectBoard) */
export const buildBoard = (source, deps = {}) => collectBoard(source, deps).board;

const isLive = (board) => (board?.runs?.some((run) => run.state !== 'stopped?') || board?.agents?.some((agent) => agent.state !== 'done')) ?? false;

/** True when a refresh is due: none yet, the last one older than its interval, and none in flight. */
function due(old, nowMs) {
  if (old === null) return true;
  if (old.refreshStartedAt && nowMs - old.refreshStartedAt < IN_FLIGHT_MS && old.refreshStartedAt > old.at) return false;
  return nowMs - old.at >= (isLive(old) ? LIVE_EVERY_MS : IDLE_EVERY_MS);
}

/**
 * The status line's claim of a board refresh: when one is due, the board file is marked `refreshStartedAt` now (a stub board when
 * there is none yet), so the next renders start no second one; the caller then starts the refresh with `force`.
 * @param {string | undefined} session the session id
 * @param {{ env?: object, nowMs?: number }} [deps] tests pass both
 * @returns {boolean} true when the claim was written and a refresh should start
 */
export function claimBoardRefresh(session, { env = process.env, nowMs = Date.now() } = {}) {
  try {
    if (!isSessionId(session)) return false;
    const old = readBoard(session, env);
    if (!due(old, nowMs)) return false;
    const base = old ?? { session, at: 0, stale: null, refreshStartedAt: null, asking: null, runs: [], agents: [], repo: null, git: null };
    return writeSessionFile(boardDir(env), session, JSON.stringify({ ...base, refreshStartedAt: nowMs }));
  } catch {
    return false; // no claim, no spawn: a broken board folder never causes a refresh storm
  }
}

const LOCK_STALE_MS = 2 * 60_000; // a refresh runs well under a second; one this old is stuck and is not waited for
const MAX_LOCK_BYTES = 64;

/** True when the refresh named in the lock file is alive and its lock younger than LOCK_STALE_MS. */
function lockHeld(path, nowMs) {
  try {
    const [pid, atMs] = readPlainFile(path, MAX_LOCK_BYTES).trim().split(' ').map(Number);
    if (!Number.isInteger(pid) || !(nowMs - atMs < LOCK_STALE_MS)) return false;
    process.kill(pid, 0); // throws when the process is gone
    return true;
  } catch (error) {
    return error?.code === 'EPERM'; // alive, owned by someone else: still held
  }
}

/** Takes the session's refresh lock (a file holding this pid and the time); null when another live refresh holds it. */
function takeLock(dir, session, nowMs) {
  const path = join(dir, `${session}.lock`);
  try {
    if (lockHeld(path, nowMs)) return null;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    rmSync(path, { force: true });
    const fd = openSync(path, 'wx', 0o600);
    try { writeSync(fd, `${process.pid} ${nowMs}`); } finally { closeSync(fd); }
    return path;
  } catch {
    return null; // another refresh took it between the check and the open
  }
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
    const lock = takeLock(dir, source.session, startMs);
    if (lock === null) return false;
    try {
      return refreshLocked(source, { env, now, dir, old, startMs });
    } finally {
      rmSync(lock, { force: true });
    }
  } catch {
    return false; // the old board stays; the next refresh tries again
  }
}

/** The refresh itself, under the lock. */
function refreshLocked(source, { env, now, dir, old, startMs }) {
  if (old !== null) writeSessionFile(dir, source.session, JSON.stringify({ ...old, refreshStartedAt: startMs }));
  const pools = readPools(env);
  const { board: fresh, cache } = collectBoard(source, { env, nowMs: startMs, cache: readCacheFile(source.session, env, MAX_CACHE_BYTES), pools });
  const tookMs = now() - startMs;
  writeCacheFile(source.session, cache, env, MAX_CACHE_BYTES); // kept also when over budget: the next refresh reads only new bytes
  const board = tookMs > BUDGET_MS && old !== null && old.at > 0 ? { ...old, stale: { sinceMs: old.at, tookMs }, refreshStartedAt: null } : fresh;
  const text = JSON.stringify(board);
  const written = text.length <= MAX_BOARD_BYTES && writeSessionFile(dir, source.session, text);
  if (typeof source.transcriptPath === 'string' && poolsDue(pools, startMs)) rebuildPools({ projectsDir: dirname(dirname(source.transcriptPath)), env, nowMs: startMs });
  return written;
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
 * @param {{ cwd?: string, spawnChild?: typeof spawn, force?: boolean }} [deps] tests replace spawn; force: after claimBoardRefresh
 * @returns {boolean} true when a child was started
 */
export function startBoardRefresh(session, { cwd = process.cwd(), spawnChild = spawn, force = false } = {}) {
  if (!isSessionId(session)) return false;
  try {
    const args = [BOARD_SCRIPT, 'refresh', '--session', session, ...(force ? ['--force'] : [])];
    const child = spawnChild(process.execPath, args, { cwd, detached: true, stdio: 'ignore', windowsHide: true });
    child.on?.('error', () => {}); // a failed start leaves the old board; the next edit or render tries again
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}
