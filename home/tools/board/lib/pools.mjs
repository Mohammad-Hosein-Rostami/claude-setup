// The run times of finished subagents per agent type on this machine (research-tui 3.3 and 3.4 step 1): the pool `D_T` the
// progress formula judges a running agent against. Rebuilt at most every REBUILD_EVERY_MS by the detached board refresh, after it
// wrote the board, so a slow scan never delays a board.
// Exports: readPools(env) -> pools | null, poolsDue(pools, nowMs) -> boolean, rebuildPools({ projectsDir, env, nowMs }) -> pools | null.
// File: ~/.claude/state/board-cache/pools.json = { at, types: { [agentType]: minutes[] } } (sorted ascending, newest MAX_PER_TYPE
// runs per type, 0.1 min steps).
// Source (Claude Code internal, observed 2.1.329): <projects>/<project>/<session>/subagents/agent-<id>.meta.json (`agentType`) and
// .../subagents/workflows/<run>/agent-<id>.meta.json, each next to its transcript agent-<id>.jsonl. A run's time is its transcript's
// last `"timestamp"` minus its first (wall minutes; the live agent's elapsed time is wall minutes too, so the two compare).
// Bounds: sessions changed in the last MAX_AGE_DAYS, newest MAX_SESSIONS first, at most MAX_FILES transcripts and SCAN_BUDGET_MS of
// work; a transcript changed in the last LIVE_MS is skipped (it may still run). Only the first and last HEAD_BYTES / TAIL_BYTES of a
// transcript are read.
// Invariants: never throws; reads plain files only (no links); writes only through cache-file.mjs.
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readPart } from '../../estimate/lib/workflow-runs.mjs';
import { readCacheFile, writeCacheFile } from './cache-file.mjs';

const POOLS_NAME = 'pools';
const MAX_POOLS_BYTES = 128 * 1024;
const MS_PER_MIN = 60_000;
const REBUILD_EVERY_MS = 60 * MS_PER_MIN;
const MAX_AGE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * MS_PER_MIN;
const MAX_SESSIONS = 80;
const MAX_FILES = 4000;
const MAX_PER_TYPE = 300;
const SCAN_BUDGET_MS = 4000;
const LIVE_MS = 30 * MS_PER_MIN;
const HEAD_BYTES = 4096;
const TAIL_BYTES = 16 * 1024;
const META_BYTES = 4096;
const META_FILE = /^agent-([A-Za-z0-9]+)\.meta\.json$/;
const AGENT_TYPE = /^[A-Za-z0-9:_.-]{1,64}$/;
const TIMESTAMP = /"timestamp":"([0-9T:.\-]+Z?)"/g;
const TENTHS = 10;

const namesIn = (folder) => { try { return readdirSync(folder); } catch { return []; } };
const statOf = (path) => { try { return lstatSync(path, { throwIfNoEntry: false }) ?? null; } catch { return null; } };

/** @returns {{ at: number, types: Record<string, number[]> } | null} the stored pools, or null when none is usable */
export function readPools(env = process.env) {
  const pools = readCacheFile(POOLS_NAME, env, MAX_POOLS_BYTES);
  return pools !== null && Number.isFinite(pools.at) && pools.types !== null && typeof pools.types === 'object' ? pools : null;
}

/** @returns {boolean} true when the pools are missing or older than REBUILD_EVERY_MS */
export const poolsDue = (pools, nowMs) => pools === null || nowMs - pools.at >= REBUILD_EVERY_MS;

/** The session folders that hold subagents, newest first, changed in the last MAX_AGE_DAYS. */
function sessionFolders(projectsDir, nowMs) {
  const found = [];
  for (const project of namesIn(projectsDir)) {
    for (const name of namesIn(join(projectsDir, project))) {
      const subagents = join(projectsDir, project, name, 'subagents');
      const info = statOf(subagents);
      if (info?.isDirectory() && nowMs - info.mtimeMs < MAX_AGE_DAYS * MS_PER_DAY) found.push({ subagents, mtimeMs: info.mtimeMs });
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_SESSIONS).map((entry) => entry.subagents);
}

/** Every folder of one session that holds agent files: subagents itself and each workflow run folder. */
const agentFolders = (subagents) => [subagents, ...namesIn(join(subagents, 'workflows')).map((run) => join(subagents, 'workflows', run))];

/** The wall minutes from a transcript's first to its last timestamp; null when it cannot be told. */
function runMinutes(transcript) {
  const head = readPart(transcript, HEAD_BYTES, false)?.text ?? '';
  const tail = readPart(transcript, TAIL_BYTES, true)?.text ?? '';
  const first = Date.parse([...head.matchAll(TIMESTAMP)][0]?.[1] ?? '');
  const last = Date.parse([...tail.matchAll(TIMESTAMP)].at(-1)?.[1] ?? '');
  const minutes = (last - first) / MS_PER_MIN;
  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * TENTHS) / TENTHS : null;
}

/** One finished agent as [type, minutes, mtime], or null. */
function agentRun(folder, metaName, nowMs) {
  const transcript = join(folder, metaName.replace(/\.meta\.json$/, '.jsonl'));
  const info = statOf(transcript);
  if (!info?.isFile() || nowMs - info.mtimeMs < LIVE_MS) return null;
  const meta = JSON.parse(readPart(join(folder, metaName), META_BYTES, false)?.text ?? 'null');
  const type = meta?.agentType;
  if (typeof type !== 'string' || !AGENT_TYPE.test(type)) return null;
  const minutes = runMinutes(transcript);
  return minutes === null ? null : [type, minutes, info.mtimeMs];
}

/** Every finished run found within the bounds, as [type, minutes, mtime]. */
function scanRuns(projectsDir, nowMs) {
  const started = Date.now();
  const runs = [];
  let files = 0;
  for (const subagents of sessionFolders(projectsDir, nowMs)) {
    for (const folder of agentFolders(subagents)) {
      for (const name of namesIn(folder).filter((entry) => META_FILE.test(entry))) {
        if ((files += 1) > MAX_FILES || Date.now() - started > SCAN_BUDGET_MS) return runs;
        try {
          const run = agentRun(folder, name, nowMs);
          if (run !== null) runs.push(run);
        } catch {
          // a meta file half-written or not JSON: that run is left out
        }
      }
    }
  }
  return runs;
}

/**
 * Scans the transcripts and stores the pools.
 * @param {{ projectsDir: string, env?: object, nowMs?: number }} source the projects folder of this account
 * @returns {{ at: number, types: Record<string, number[]> } | null} the new pools (also when the write failed), null on failure
 */
export function rebuildPools({ projectsDir, env = process.env, nowMs = Date.now() }) {
  try {
    const byType = new Map();
    for (const [type, minutes, mtimeMs] of scanRuns(projectsDir, nowMs)) {
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type).push([mtimeMs, minutes]);
    }
    const types = {};
    for (const [type, runs] of byType) {
      types[type] = runs.sort((a, b) => b[0] - a[0]).slice(0, MAX_PER_TYPE).map((run) => run[1]).sort((a, b) => a - b);
    }
    const pools = { at: nowMs, types };
    writeCacheFile(POOLS_NAME, pools, env, MAX_POOLS_BYTES);
    return pools;
  } catch {
    return null;
  }
}
