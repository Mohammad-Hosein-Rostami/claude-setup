// The dirty files of a worktree at the first tool call of a session or agent, for commit-gate.mjs: files a Bash command makes or changes
// (heredoc, sed -i, codegen, a formatter, git mv) leave no Edit/Write record, so at a stop the gate compares the worktree with this baseline.
// Exports: hasBaseline(env, session, agent), saveBaseline(env, session, agent, top, entries, head) -> boolean,
// changedSinceBaseline(env, session, agent, top, entries) -> entries, baselineOf(env, session, agent) -> {top, head, takenMs} | null.
// Store: ~/.claude/state/commit-gate/baseline/<session>--<agent or "lead">.json through lib/session-store.mjs (lstat-checked, 0600):
// {"top": real worktree path or null (no worktree to gate), "files": {path: stamp}} or {"top", "overflow": true} past MAX_ENTRIES, plus
// "head" (the HEAD sha then, or null) and "takenMs" (the hook's clock then). A baseline written before round 9 has neither: the gate then
// treats every Bash-made entry as own and counts no committed file (commit-gate.mjs, lib/change-owner.mjs).
// A stamp is the sha256 of a regular file's first HASH_MAX_BYTES (read without following a link or blocking on a FIFO), "link:<target>",
// "dir" for an untracked folder git lists as one entry, "<size>:<mtime>" for anything else, or "gone".
// Invariants: never throws; the first baseline of a (session, agent) is kept, later calls change nothing; no baseline, another worktree
// or an overflowed one means "nothing changed by Bash" (the gate then counts only recorded files, as before).
// Limits: a file a Bash command adds inside a folder that was already untracked at the baseline is not seen (git lists the folder once).
import { createHash } from 'node:crypto';
import { constants, existsSync, lstatSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileHead } from './agent-brief.mjs';
import { isSessionId, readSessionFile, writeSessionFile } from './session-store.mjs';

const MAX_ENTRIES = 5000; // dirty entries kept; a worktree with more is not compared
const MAX_STORE_BYTES = 2 * 1024 * 1024;
const HASH_MAX_BYTES = 8 * 1024 * 1024;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
const LEAD_KEY = 'lead';

const baselineDir = (env) => join(env.HOME || env.USERPROFILE || homedir(), '.claude', 'state', 'commit-gate', 'baseline');
const baselineId = (session, agent) => `${session}--${agent || LEAD_KEY}`;

/** What a dirty entry's file is now (see the header); "gone" when it is missing or unreadable. */
function stampOf(path) {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return `link:${readlinkSync(path)}`;
    if (info.isDirectory()) return 'dir';
    const head = info.isFile() ? readFileHead(path, HASH_MAX_BYTES, READ_FLAGS) : undefined;
    return head === undefined ? `${info.size}:${info.mtimeMs}` : createHash('sha256').update(head).digest('hex');
  } catch {
    return 'gone';
  }
}

/**
 * @param {Record<string, string | undefined>} env HOME / USERPROFILE (the state folder)
 * @param {unknown} session hook input session_id
 * @param {string} agent the agent id, '' for the lead
 * @returns {boolean} true when this session or agent has a baseline (taken at its first tool call)
 */
export function hasBaseline(env, session, agent) {
  const id = baselineId(session, agent);
  return isSessionId(id) && existsSync(join(baselineDir(env), `${id}.json`));
}

/**
 * Stores the baseline once: the stamps of the dirty entries of worktree `top` (null: no worktree to gate, so nothing to compare).
 * @param {{path: string}[]} entries the dirty entries (real paths) from `git status`
 * @param {string | null} [head] the HEAD sha of the worktree now (null: none or unknown)
 * @returns {boolean} true when stored now; false when a baseline exists, the id is bad or the store is unusable
 */
export function saveBaseline(env, session, agent, top, entries, head = null) {
  const id = baselineId(session, agent);
  if (!isSessionId(id) || hasBaseline(env, session, agent)) return false;
  const stamp = { top, head: typeof head === 'string' && head !== '' ? head : null, takenMs: Date.now() };
  const record = entries.length > MAX_ENTRIES
    ? { ...stamp, overflow: true }
    : { ...stamp, files: Object.fromEntries(entries.map(({ path }) => [path, stampOf(path)])) };
  return writeSessionFile(baselineDir(env), id, JSON.stringify(record));
}

/**
 * The entries of worktree `top` that are new or different since the baseline of this session or agent.
 * @param {{path: string}[]} entries dirty entries not counted otherwise (not recorded by this agent, not another agent's)
 * @returns {{path: string}[]} those changed since the baseline; [] with no usable baseline for `top`
 */
export function changedSinceBaseline(env, session, agent, top, entries) {
  try {
    const id = baselineId(session, agent);
    const text = isSessionId(id) ? readSessionFile(baselineDir(env), id, MAX_STORE_BYTES) : null;
    const record = typeof text === 'string' ? JSON.parse(text) : null;
    if (record?.top !== top || record.overflow === true || record.files === null || typeof record.files !== 'object') return [];
    return entries.filter(({ path }) => !Object.hasOwn(record.files, path) || record.files[path] !== stampOf(path));
  } catch {
    return []; // a damaged baseline: only recorded files count
  }
}

/**
 * The baseline's worktree, HEAD sha and time, for the size check and the ownership rules of commit-gate.mjs.
 * @returns {{top: string | null, head: string | null, takenMs: number | null} | null} null with no readable baseline
 */
export function baselineOf(env, session, agent) {
  try {
    const id = baselineId(session, agent);
    const text = isSessionId(id) ? readSessionFile(baselineDir(env), id, MAX_STORE_BYTES) : null;
    const record = typeof text === 'string' ? JSON.parse(text) : null;
    if (record === null || typeof record !== 'object') return null;
    const head = typeof record.head === 'string' ? record.head : null;
    return { top: typeof record.top === 'string' ? record.top : null, head, takenMs: Number.isFinite(record.takenMs) ? record.takenMs : null };
  } catch {
    return null;
  }
}
