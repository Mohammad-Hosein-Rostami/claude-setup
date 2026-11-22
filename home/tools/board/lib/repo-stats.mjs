// Two facts of the base branch for the status line (spec-tui-2 stats 4 and 5): its tip commit and the commits landed on it today
// (count and the newest one's time).
// Run only by the detached board refresh (refresh.mjs), never by the status line.
// Exports: repoStats({ common, base, cache, nowMs, startMs }) -> { stats, cache }.
// Commands (git-state.mjs gitIn: fixed flags, GIT_COMMON_DIR pinned, a timeout each, inside the refresh's one git budget `startMs`), at most every
// STATS_EVERY_MS, all on the trusted repository's shared git folder (`--git-dir=<common>`, from trusted-repos.mjs, never a path from
// the cache: review SEC-10): `rev-parse --verify --end-of-options <base>^{commit}` and `log --first-parent
// --format=%ct --since=<local midnight> -n MAX_LANDED --end-of-options <base> --`. `base` comes from git-state.mjs and must pass
// SAFE_REF (no leading `-`).
// Landed today = commits on the base's first-parent line with a committer time since local midnight (lands are fast-forward, so a
// landed commit keeps the time it was committed or rebased).
// Invariants: never throws (a failure keeps the cached stats); no text from a file reaches a command.
import { gitIn } from './git-state.mjs';

const STATS_EVERY_MS = 60_000;
const MAX_LANDED = 500;
const MS_PER_S = 1000;
const GIT_BUDGET_MS = 250; // git-state.mjs GIT_BUDGET_MS: one budget for all git of a refresh
const SAFE_REF = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/;
const SHA = /^[0-9a-f]{40,64}$/;

/** The commits landed on the base since local midnight: { count, lastMs }. */
function landedToday(common, base, nowMs) {
  const midnight = new Date(nowMs);
  midnight.setHours(0, 0, 0, 0);
  const text = gitIn(common, [`--git-dir=${common}`, 'log', '--first-parent', '--format=%ct', `--since=${midnight.toISOString()}`, '-n', String(MAX_LANDED), '--end-of-options', base, '--']);
  if (text === null) return null;
  const times = text.split('\n').map(Number).filter((t) => Number.isInteger(t) && t > 0);
  return { count: times.length, lastMs: times.length > 0 ? Math.max(...times) * MS_PER_S : null };
}

/**
 * @param {{ common: string | null, base: string | null, cache: object | null, nowMs: number, startMs?: number }} source the trusted
 *   repository's shared git folder, its base branch (git-state.mjs repo.base), the last stats cache and when the refresh's git budget started
 * @returns {{ stats: { tip: string, landed: { count: number, lastMs: number | null } | null } | null,
 *   cache: object }} stats null outside a repository or without a base
 */
export function repoStats({ common, base, cache, nowMs, startMs = Date.now() }) {
  const old = cache ?? {};
  try {
    if (typeof common !== 'string' || typeof base !== 'string' || !SAFE_REF.test(base)) return { stats: null, cache: {} };
    const same = old.common === common && old.base === base;
    if (same && (nowMs - (old.at ?? 0) < STATS_EVERY_MS || Date.now() - startMs > GIT_BUDGET_MS)) return { stats: old.stats ?? null, cache: old };
    const tip = gitIn(common, [`--git-dir=${common}`, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${base}^{commit}`])?.trim() ?? '';
    if (!SHA.test(tip)) return { stats: same ? (old.stats ?? null) : null, cache: same ? old : {} };
    const stats = { tip, landed: landedToday(common, base, nowMs) ?? (same ? old.stats?.landed ?? null : null) };
    return { stats, cache: { common, base, at: nowMs, stats } };
  } catch {
    return { stats: old.stats ?? null, cache: old };
  }
}
