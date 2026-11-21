// Two facts of the base branch for the status line (spec-tui-2 stats 4 and 5): the suite state at its tip (the newest test-pass
// `suite` proof record of exactly that commit) and the commits landed on it today (count and the newest one's time).
// Run only by the detached board refresh (refresh.mjs), never by the status line.
// Exports: repoStats({ common, base, cache, nowMs, startMs }) -> { stats, cache }.
// Commands (fixed flags, git-state.mjs GIT_SAFETY, GIT_TIMEOUT_MS each, inside the refresh's one git budget `startMs`), at most every
// STATS_EVERY_MS, all on the trusted repository's shared git folder (`--git-dir=<common>`, from trusted-repos.mjs, never a path from
// the cache: review SEC-10): `rev-parse --verify --end-of-options <base>^{commit}` and `log --first-parent
// --format=%ct --since=<local midnight> -n MAX_LANDED --end-of-options <base> --`. `base` comes from git-state.mjs and must pass
// SAFE_REF (no leading `-`). The proof records are read here, bounded and without a link or a FIFO, from test-pass's file of the
// clone (`~/.claude/state/test-pass/<first 16 hex of sha256(real common dir)>.proof.jsonl`, the key of test-pass/lib/store.mjs
// recordFile), because its own reader starts a git call with no timeout (review SEC-3).
// Landed today = commits on the base's first-parent line with a committer time since local midnight (lands are fast-forward, so a
// landed commit keeps the time it was committed or rebased).
// Invariants: never throws (a failure keeps the cached stats); no text from a file reaches a command.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readPlainFile } from '../../../hooks/lib/plain-file.mjs';
import { GIT_SAFETY } from './git-state.mjs';

const GIT_TIMEOUT_MS = 250;
const STATS_EVERY_MS = 60_000;
const MAX_LANDED = 500;
const MS_PER_S = 1000;
const GIT_BUDGET_MS = 250; // git-state.mjs GIT_BUDGET_MS: one budget for all git of a refresh
const SAFE_REF = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/;
const PROOF_ID_HEX = 16; // test-pass/lib/store.mjs ID_LENGTH
const MAX_PROOF_BYTES = 1024 * 1024; // 200 rows of well under 1 KB
const SHA = /^[0-9a-f]{40,64}$/;

/** One git call with fixed flags; null on any failure or timeout. */
function git(args) {
  try {
    return execFileSync('git', [...GIT_SAFETY, ...args], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  } catch {
    return null;
  }
}

/** The commits landed on the base since local midnight: { count, lastMs }. */
function landedToday(common, base, nowMs) {
  const midnight = new Date(nowMs);
  midnight.setHours(0, 0, 0, 0);
  const text = git([`--git-dir=${common}`, 'log', '--first-parent', '--format=%ct', `--since=${midnight.toISOString()}`, '-n', String(MAX_LANDED), '--end-of-options', base, '--']);
  if (text === null) return null;
  const times = text.split('\n').map(Number).filter((t) => Number.isInteger(t) && t > 0);
  return { count: times.length, lastMs: times.length > 0 ? Math.max(...times) * MS_PER_S : null };
}

/** The clone's test-pass proof rows (newest last); [] when none can be read. */
function proofRows(common) {
  const id = createHash('sha256').update(realpathSync.native(common)).digest('hex').slice(0, PROOF_ID_HEX);
  const text = readPlainFile(join(process.env.HOME || homedir(), '.claude', 'state', 'test-pass', `${id}.proof.jsonl`), MAX_PROOF_BYTES);
  return text.split('\n').flatMap((line) => { try { const row = JSON.parse(line); return row?.kind === 'proof' ? [row] : []; } catch { return []; } });
}

/** The newest `suite` proof record of the tip: { tests, failed, verdict }, or null when the tip has none. */
function suiteAt(common, tip) {
  let rows = [];
  try { rows = proofRows(common); } catch { rows = []; } // no proof file yet, or one that is not a plain file: no record
  const record = rows.filter((row) => row.role === 'suite' && row.sha === tip).at(-1);
  if (record === undefined) return null;
  const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
  return { tests: count(record.selected), failed: count(record.failed), verdict: record.verdict === 'PASS' ? 'PASS' : 'FAIL' };
}

/**
 * @param {{ common: string | null, base: string | null, cache: object | null, nowMs: number, startMs?: number }} source the trusted
 *   repository's shared git folder, its base branch (git-state.mjs repo.base), the last stats cache and when the refresh's git budget started
 * @returns {{ stats: { tip: string, suite: object | null, landed: { count: number, lastMs: number | null } | null } | null,
 *   cache: object }} stats null outside a repository or without a base
 */
export function repoStats({ common, base, cache, nowMs, startMs = Date.now() }) {
  const old = cache ?? {};
  try {
    if (typeof common !== 'string' || typeof base !== 'string' || !SAFE_REF.test(base)) return { stats: null, cache: {} };
    const same = old.common === common && old.base === base;
    if (same && (nowMs - (old.at ?? 0) < STATS_EVERY_MS || Date.now() - startMs > GIT_BUDGET_MS)) return { stats: old.stats ?? null, cache: old };
    const tip = git([`--git-dir=${common}`, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${base}^{commit}`])?.trim() ?? '';
    if (!SHA.test(tip)) return { stats: same ? (old.stats ?? null) : null, cache: same ? old : {} };
    const stats = { tip, suite: suiteAt(common, tip), landed: landedToday(common, base, nowMs) ?? (same ? old.stats?.landed ?? null : null) };
    return { stats, cache: { common, base, at: nowMs, stats } };
  } catch {
    return { stats: old.stats ?? null, cache: old };
  }
}
