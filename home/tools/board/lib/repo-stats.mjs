// Two facts of the base branch for the status line (spec-tui-2 stats 4 and 5): the suite state at its tip (the newest test-pass
// `suite` proof record of exactly that commit) and the commits landed on it today (count and the newest one's time).
// Run only by the detached board refresh (refresh.mjs), never by the status line.
// Exports: repoStats({ repoDir, base, cache, nowMs }) -> { stats, cache }.
// Commands (fixed flags, GIT_TIMEOUT_MS each), at most every STATS_EVERY_MS: `rev-parse --verify <base>^{commit}`, `log
// --first-parent --format=%ct --since=<local midnight> -n MAX_LANDED <base>` and the proof records (test-pass proof-store.mjs
// proofsOf, one more git call). `base` comes from git-state.mjs (a name read from refs/heads, SAFE_REF).
// Landed today = commits on the base's first-parent line with a committer time since local midnight (lands are fast-forward, so a
// landed commit keeps the time it was committed or rebased).
// Invariants: never throws (a failure keeps the cached stats); no text from a file reaches a command.
import { execFileSync } from 'node:child_process';
import { proofsOf } from '../../test-pass/lib/proof-store.mjs';

const GIT_TIMEOUT_MS = 250;
const STATS_EVERY_MS = 60_000;
const MAX_LANDED = 500;
const MS_PER_S = 1000;
const SAFE_REF = /^[A-Za-z0-9._/-]{1,200}$/;
const SHA = /^[0-9a-f]{40,64}$/;

/** One git call with fixed flags; null on any failure or timeout. */
function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  } catch {
    return null;
  }
}

/** The commits landed on the base since local midnight: { count, lastMs }. */
function landedToday(repoDir, base, nowMs) {
  const midnight = new Date(nowMs);
  midnight.setHours(0, 0, 0, 0);
  const text = git(['-C', repoDir, 'log', '--first-parent', '--format=%ct', `--since=${midnight.toISOString()}`, '-n', String(MAX_LANDED), base, '--']);
  if (text === null) return null;
  const times = text.split('\n').map(Number).filter((t) => Number.isInteger(t) && t > 0);
  return { count: times.length, lastMs: times.length > 0 ? Math.max(...times) * MS_PER_S : null };
}

/** The newest `suite` proof record of the tip: { tests, failed, verdict }, or null when the tip has none. */
function suiteAt(repoDir, tip) {
  const record = proofsOf(repoDir).filter((row) => row.role === 'suite' && row.sha === tip).at(-1);
  if (record === undefined) return null;
  const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
  return { tests: count(record.selected), failed: count(record.failed), verdict: record.verdict === 'PASS' ? 'PASS' : 'FAIL' };
}

/**
 * @param {{ repoDir: string | null, base: string | null, cache: object | null, nowMs: number }} source a folder in the repository,
 *   its base branch (git-state.mjs repo.base) and the last stats cache
 * @returns {{ stats: { tip: string, suite: object | null, landed: { count: number, lastMs: number | null } | null } | null,
 *   cache: object }} stats null outside a repository or without a base
 */
export function repoStats({ repoDir, base, cache, nowMs }) {
  const old = cache ?? {};
  try {
    if (typeof repoDir !== 'string' || typeof base !== 'string' || !SAFE_REF.test(base)) return { stats: null, cache: {} };
    const same = old.repoDir === repoDir && old.base === base;
    if (same && nowMs - (old.at ?? 0) < STATS_EVERY_MS) return { stats: old.stats ?? null, cache: old };
    const tip = git(['-C', repoDir, 'rev-parse', '--verify', '--quiet', `${base}^{commit}`])?.trim() ?? '';
    if (!SHA.test(tip)) return { stats: same ? (old.stats ?? null) : null, cache: same ? old : {} };
    const stats = { tip, suite: suiteAt(repoDir, tip), landed: landedToday(repoDir, base, nowMs) ?? (same ? old.stats?.landed ?? null : null) };
    return { stats, cache: { repoDir, base, at: nowMs, stats } };
  } catch {
    return { stats: old.stats ?? null, cache: old };
  }
}
