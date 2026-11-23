// The size cap of the call-window log (lib/call-windows.mjs) and the one report of a full log. Split from call-windows.mjs to keep
// each file under 300 lines (C4).
// Exports: MAX_WINDOW_LOG_BYTES, MAX_EDGE_LINE_BYTES, MAX_USABLE_LOG_BYTES, LOG_FULL_OUTCOME, reportFullLogOnce(env, dir, session).
// Why 32 MiB: the old 8 MiB cap filled in about 9 h of 5 agents (2026-11-22), and a full log reads as unusable, which makes every
//   change of the session "own" (lib/change-owner.mjs). Read time (P1, measured 2026-11-23 on a macOS laptop, a fresh node process,
//   5 runs): a full own log (251,315 lines) 157-171 ms, then a 32 MiB claim budget of other logs 173-211 ms, 338-376 ms in all, so
//   both stay well inside the 1.5 s verdict deadline (VERDICT_DEADLINE_MS); a slower read only reaches that deadline, which gives
//   "own", never "foreign". The slower machines are measured in phase 8.
// Invariants: one cap for the writer, the reader and the claim reader (P6). A log within MAX_EDGE_LINE_BYTES of the cap may have
//   refused a line, so it reads as unusable. A full log is reported in guard.jsonl at most once per session: the marker
//   <session>--log-full.json is written under the session lock (one try, never a wait) before the line, so a lost race, a killed
//   hook or an unusable store writes no line rather than one per call; the marker goes with the store's 7-day sweep (a session idle
//   that long may report once more), and an older reader never looks at it. Nothing here throws.
import { join } from 'node:path';
import { logDecision } from './guard-log.mjs';
import { withSessionLock } from './session-lock.mjs';
import { lstatOrNull, readSessionFile, writeSessionFile } from './session-store.mjs';

const MIB = 1024 * 1024;
export const MAX_WINDOW_LOG_BYTES = 32 * MIB;
export const MAX_EDGE_LINE_BYTES = 16 * 1024; // the longest line the writer sends (ids, types and paths are capped in call-windows.mjs)
export const MAX_USABLE_LOG_BYTES = MAX_WINDOW_LOG_BYTES - MAX_EDGE_LINE_BYTES; // a bigger log may have refused a line
export const LOG_FULL_OUTCOME = 'call-window-log-full'; // the guard.jsonl outcome of the one report
const MARKER_MAX_BYTES = 256;
const NO_WAIT = { waitMs: 0 }; // a hook never waits on a lock: a busy one means another hook of this session is reporting it

const markerId = (session) => `${session}--log-full`;
const markerAbsent = (dir, session) => readSessionFile(dir, markerId(session), MARKER_MAX_BYTES) === null; // undefined: unusable store

/**
 * Writes one `call-window-log-full` line to guard.jsonl the first time this session's log is past MAX_USABLE_LOG_BYTES.
 * Why: a full log silently turns every change of the session "own"; the owner should see it once, not on every tool call.
 * @param {Record<string, string | undefined>} env the hook's environment (CLAUDE_GUARD_LOG moves guard.jsonl)
 * @param {string} dir the call-window log folder (logFolderOf)
 * @param {string} session the session id
 * @returns {boolean} true only for the call that wrote the line
 */
export function reportFullLogOnce(env, dir, session) {
  try {
    const stats = lstatOrNull(join(dir, `${session}.jsonl`));
    if (!stats?.isFile() || stats.size <= MAX_USABLE_LOG_BYTES || !markerAbsent(dir, session)) return false;
    return withSessionLock(dir, markerId(session), () => {
      if (!markerAbsent(dir, session) || !writeSessionFile(dir, markerId(session), JSON.stringify({ bytes: stats.size, at: Date.now() }))) return false;
      const reason = `call-window log full (${stats.size} bytes, cap ${MAX_WINDOW_LOG_BYTES / MIB} MiB): every change of this session now counts as own`;
      logDecision({ hook: 'commit-gate', tool: 'call-windows', decision: 'skip', outcome: LOG_FULL_OUTCOME, reason, command: '', session }, env);
      return true;
    }, NO_WAIT) === true;
  } catch {
    return false; // lstat failed (no permission): no report, the next call tries again
  }
}
