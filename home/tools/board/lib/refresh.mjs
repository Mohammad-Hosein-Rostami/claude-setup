// The board file of a session: which agents work on what, what waits on the owner, and the git state of every worktree, for the
// status line (spec-p5 `r9-board`, spec-tui "Data and speed"). A detached refresh
// writes it, one at a time, at most every LIVE_EVERY_MS while an agent is live and every IDLE_EVERY_MS when idle; a refresh
// over BUDGET_MS keeps the old data and marks the board stale (the agent cursors and git cache it read are kept all the same).
// Exports: boardDir(env), readBoard(session, env), buildBoard(source, deps), collectBoard(source, deps) -> { board,
// cache }, refreshBoard(source, deps) -> boolean, claimBoardRefresh(session, deps) -> boolean, startBoardRefresh(session, deps) ->
// boolean, findTranscript(session, projectsDir); MAX_BOARD_BYTES.
// File: ~/.claude/state/board/<session>.json = { session, at, stale, refreshStartedAt, asking,
// agents: [agents.mjs entries plus repo (its repository's name), wt, branch, unplaced (repos.mjs placeAgents)], repo: git-state.mjs repo plus { name }
// (repos.mjs) and { tip, landed } (repo-stats.mjs) | null, repos: the other used repositories (same shape without the stats), git: { branch, ahead, behind, changed } | null }
// (<= MAX_BOARD_BYTES: done agents go first, then the oldest, until it fits). Cache (cache-file.mjs, <session>.json): { cursors, git,
// stats, lead, used }. The repositories (repos.mjs, owner decisions RC15 and RC19): the session folder's, then those holding a
// folder this session used, newest use first: `used` = [{ dir, atMs }] (at most MAX_USED_DIRS) of the agents' edited folders,
// launch worktrees and cwds (live or done) and the lead's Edit/Write folders (`lead`: an agent-transcript.mjs cursor on the main
// transcript that starts at its end, so only new bytes are read); each with the worktrees the repository records
// (trusted-repos.mjs worktreeRecords, passed to git as `--git-dir=`/`--work-tree=`, never the used folder itself); agents are
// matched to those worktrees by path prefix (repos.mjs placeAgents). One refresh at a time per session: an O_EXCL lock file
// (disk-free/lib/lock-file.mjs, review L1), broken once it is LOCK_STALE_MS old (review SEC-2: a hung refresh must not be
// joined by a new one every IN_FLIGHT_MS).
// `needs you` is the session's asking marker.
// Invariants: agent transcripts are an internal format: every parser fails soft, so an unreadable part never throws; written
// through session-store.mjs (no links, 0600, temp file and rename); git runs only in git-state.mjs, with fixed flags and its own
// timeouts; `git-tidy check` never runs here; nothing here throws.
import { spawn } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { advanceCursor, emptyCursor } from './agent-transcript.mjs';
import { releaseLock, takeLock } from '../../disk-free/lib/lock-file.mjs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAsking } from '../../../hooks/lib/asking-marker.mjs';
import { isSessionId, readSessionFile, writeSessionFile } from '../../../hooks/lib/session-store.mjs';
import { sessionAgents } from './agents.mjs';
import { readCacheFile, writeCacheFile } from './cache-file.mjs';
import { GIT_REFRESH_MAX_MS } from './git-call.mjs';
import { repoStats } from './repo-stats.mjs';
import { placeAgents, sessionRepos } from './repos.mjs';
import { REMOTE_PATH } from './trusted-repos.mjs';

export const MAX_BOARD_BYTES = 48 * 1024;
const MAX_CACHE_BYTES = 512 * 1024;
const LIVE_EVERY_MS = 5_000; // the settings' refreshInterval: agent rows and a question's countdown move every 5 s
const IDLE_EVERY_MS = 60_000;
// A refresh over this keeps the old board, marked stale: the longest git may take, plus the 300 ms the rest (transcripts) had before
// git got loaded-machine limits; a refresh that kept to git's limits is never thrown away for being slow.
const BUDGET_MS = GIT_REFRESH_MAX_MS + 300;
const IN_FLIGHT_MS = 30_000; // a claimed refresh that wrote nothing for this long is taken as dead
const MAX_USED_DIRS = 16; // folders this session used, kept newest first (repos.mjs places at most 12 of them per refresh)
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

const isUsableDir = (dir) => typeof dir === 'string' && isAbsolute(dir) && !REMOTE_PATH.test(dir);

/**
 * The lead's cursor on the main transcript: a new one starts at the file's end (only Edit/Write calls from then on count, and a long
 * transcript is never read from its start inside the refresh budget). null when there is no plain transcript file.
 */
function leadCursor(cached, transcriptPath) {
  try {
    if (typeof transcriptPath !== 'string') return null;
    const info = lstatSync(transcriptPath, { throwIfNoEntry: false });
    if (!info?.isFile()) return null;
    const fresh = cached === null || typeof cached !== 'object' || cached.ino !== info.ino || !(info.size >= cached.offset);
    return advanceCursor(fresh ? { ...emptyCursor(info.ino), offset: info.size } : cached, transcriptPath);
  } catch {
    return null; // an unreadable transcript: no lead folders this time
  }
}

/** The folders each source used now, with when: agents (now while live, else when done), writer launches, the lead's new edit folders. */
function usesNow({ agents, launchDirs, lead, oldLead, nowMs }) {
  const uses = agents.flatMap((agent) => {
    const atMs = agent.state === 'done' ? (agent.doneMs ?? nowMs) : nowMs;
    const places = agent.places ?? {};
    return [...(places.changed ?? []), places.worktree, places.cwd].map((dir, at) => ({ dir, atMs: atMs - at }));
  });
  uses.push(...launchDirs.map((dir) => ({ dir, atMs: nowMs })));
  // the lead's folders get a time only when its list of edit folders changed: the newest first, so the order holds
  const leadDirs = lead?.changedDirs ?? [];
  if (leadDirs.join('\n') !== (oldLead?.changedDirs ?? []).join('\n')) uses.push(...leadDirs.map((dir, at) => ({ dir, atMs: (lead.lastMs ?? nowMs) - at })));
  return uses;
}

/** The folders this session used, newest use first, at most MAX_USED_DIRS: the cached list (checked) with this refresh's uses merged in. */
function usedDirsOf(cachedUsed, uses) {
  const newest = new Map();
  for (const use of [...(Array.isArray(cachedUsed) ? cachedUsed : []), ...uses]) {
    if (!isUsableDir(use?.dir) || !Number.isFinite(use.atMs)) continue;
    newest.set(use.dir, Math.max(newest.get(use.dir) ?? -Infinity, use.atMs));
  }
  return [...newest].map(([dir, atMs]) => ({ dir, atMs })).sort((a, b) => b.atMs - a.atMs).slice(0, MAX_USED_DIRS);
}

/**
 * The board of a session now and the cache it read through (no write).
 * @param {{ session: string, transcriptPath: string | null, cwd: string }} source the session, its transcript and its folder
 * @param {{ env?: object, nowMs?: number, cache?: object | null }} [deps] tests pass env and nowMs
 * @returns {{ board: object, cache: { cursors: object, git: object, stats: object, lead: object | null, used: object[] } }}
 *   the board and the cache to store
 */
export function collectBoard({ session, transcriptPath, cwd }, { env = process.env, nowMs = Date.now(), cache = null } = {}) {
  const sessionFolder = typeof transcriptPath === 'string' ? join(dirname(transcriptPath), basename(transcriptPath, '.jsonl')) : null;
  const found = sessionFolder === null ? { agents: [], cursors: {} }
    : sessionAgents({ session, sessionFolder, cursors: cache?.cursors ?? {}, env, nowMs });
  const launchDirs = found.launchDirs ?? [];
  const lead = leadCursor(cache?.lead ?? null, transcriptPath);
  const used = usedDirsOf(cache?.used, usesNow({ agents: found.agents, launchDirs, lead, oldLead: cache?.lead ?? null, nowMs }));
  const liveDirs = [...launchDirs, ...found.agents.filter((agent) => agent.state !== 'done')
    .flatMap((agent) => [...(agent.places?.changed ?? []), agent.places?.worktree, agent.places?.cwd])].filter(isUsableDir);
  const gitStartMs = Date.now(); // one git budget for the whole refresh (git-call.mjs GIT_BUDGET_MS), repo-stats included
  const git = sessionRepos({ sessionFolder: cwd, usedDirs: used.map(({ dir }) => dir), liveDirs, cache: cache?.git ?? null, nowMs, startMs: gitStartMs, env });
  const placed = placeAgents(found.agents, git.repos);
  const [primary = null, ...others] = placed.repos;
  // repo-stats runs on the trusted shared git folder, never on a worktree path a stale cached state shows (review SEC-10)
  const stats = repoStats({ common: git.common, base: primary?.base ?? null, cache: cache?.stats ?? null, nowMs, startMs: gitStartMs });
  const repo = primary === null ? null : { ...primary, tip: stats.stats?.tip ?? null, landed: stats.stats?.landed ?? null };
  const marker = readAsking(session, env, nowMs);
  const asking = marker === null ? null : { kind: marker.kind, count: marker.count, expiresAt: marker.expiresAt };
  const board = {
    session, at: nowMs, stale: null, refreshStartedAt: null, asking, agents: placed.agents, repo,
    repos: others, git: git.git,
  };
  return { board: fitted(board), cache: { cursors: found.cursors, git: git.cache, stats: stats.cache, lead, used } };
}

/** @returns {object} the board of a session now (no write; see collectBoard) */
export const buildBoard = (source, deps = {}) => collectBoard(source, deps).board;

const isLive = (board) => board?.agents?.some((agent) => agent.state !== 'done') ?? false;

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
    const base = old ?? { session, at: 0, stale: null, refreshStartedAt: null, asking: null, agents: [], repo: null, git: null };
    return writeSessionFile(boardDir(env), session, JSON.stringify({ ...base, refreshStartedAt: nowMs }));
  } catch {
    return false; // no claim, no spawn: a broken board folder never causes a refresh storm
  }
}

const LOCK_STALE_MS = 20_000; // a refresh runs under 5 s; one this old was killed or is stuck (review F3)

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
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lock = join(dir, `${source.session}.lock`);
    if (!takeLock(lock, startMs, LOCK_STALE_MS)) return false; // another refresh holds it (O_EXCL, disk-free/lib/lock-file.mjs)
    try {
      return refreshLocked(source, { env, now, dir, old, startMs });
    } finally {
      releaseLock(lock);
    }
  } catch {
    return false; // the old board stays; the next refresh tries again
  }
}

/** The refresh itself, under the lock. */
function refreshLocked(source, { env, now, dir, old, startMs }) {
  if (old !== null) writeSessionFile(dir, source.session, JSON.stringify({ ...old, refreshStartedAt: startMs }));
  const { board: fresh, cache } = collectBoard(source, { env, nowMs: startMs, cache: readCacheFile(source.session, env, MAX_CACHE_BYTES) });
  const tookMs = now() - startMs;
  writeCacheFile(source.session, cache, env, MAX_CACHE_BYTES); // kept also when over budget: the next refresh reads only new bytes
  const board = tookMs > BUDGET_MS && old !== null && old.at > 0 ? { ...old, stale: { sinceMs: old.at, tookMs }, refreshStartedAt: null } : fresh;
  const text = JSON.stringify(board);
  return text.length <= MAX_BOARD_BYTES && writeSessionFile(dir, source.session, text);
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
 * Starts a detached `board.mjs refresh` for the session (the status line, after claimBoardRefresh); never waits, never throws.
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
