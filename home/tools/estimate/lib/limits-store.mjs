// The last-seen usage limits per account: the status line render writes a sample when the status input's `rate_limits` changed;
// the estimate (reset times beside a long job), the board and the pane read them. One format, one owner (display design 4.6 rows
// 1 and 11; spec-p5 `r9-board` "Limit samples per account").
// Exports: limitsDir(), isAccountName(name), readLimits(account, deps) -> { account, samples } | null, latestSample(file) -> sample | null,
// recordSample(account, rateLimits, deps) -> boolean; MAX_SAMPLES, LOG_KEEP_MS.
// Files: ~/.claude/state/limits/<account>.json = { account, samples: [{ t, five_hour, seven_day }] } (oldest first, at most
// MAX_SAMPLES; each window { used_percentage, resets_at } as the status input gives it, resets_at in epoch seconds, or null when the
// input had none), < 1 KB, temp file and rename; ~/.claude/state/limits/<account>.jsonl = one sample per line, lines older than
// LOG_KEEP_MS dropped at the next write (the 7-day time series of the token view).
// Invariants: no account name, no file (a sample with no account would mix accounts); a gap is never filled by a guess; a sample is
// stored only when a value changed; nothing here throws (any failure reads as no file, or a write that returns false).
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isPrivateFile, isSessionId, lstatOrNull, readSessionFile, writeSessionFile } from '../../../hooks/lib/session-store.mjs';

/** Samples kept per account: the pace needs two, twelve cover an hour of 5-minute changes. */
export const MAX_SAMPLES = 12;
/** The jsonl log keeps 7 days, the longest limit window. */
export const LOG_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** A limits file of 12 samples is about 1 KB; anything bigger was not written here. */
const MAX_FILE_BYTES = 8192;
/** The 7-day log at one change per 5 minutes is about 2016 lines of ~120 bytes. */
const MAX_LOG_BYTES = 1024 * 1024;
const WINDOWS = ['five_hour', 'seven_day'];
const MAX_PERCENT = 100;

/** @returns {string} the folder of the limits files */
export const limitsDir = () => join(homedir(), '.claude', 'state', 'limits');

/** @returns {boolean} true for a name usable as a file name (the account tool's names: letters, digits, `_` and `-`) */
export const isAccountName = (name) => isSessionId(name);

const isWindow = (value) => value === null || (typeof value === 'object' && Number.isFinite(value.used_percentage)
  && value.used_percentage >= 0 && value.used_percentage <= MAX_PERCENT && (value.resets_at === null || Number.isFinite(value.resets_at)));
const isSample = (value) => value !== null && typeof value === 'object' && Number.isFinite(value.t) && WINDOWS.every((name) => isWindow(value[name] ?? null));

/** One window of the status input as stored: { used_percentage, resets_at } or null (absent, or not a number). */
function windowOf(input) {
  if (!input || !Number.isFinite(input.used_percentage)) return null;
  return { used_percentage: input.used_percentage, resets_at: Number.isFinite(input.resets_at) ? input.resets_at : null };
}

/**
 * @param {string} account the account name (CLAUDE_ACCOUNT)
 * @param {{ dir?: string }} [deps] the limits folder (tests)
 * @returns {{ account: string, samples: object[] } | null} the file with its valid samples, oldest first; null when there is none or it is unusable
 */
export function readLimits(account, { dir = limitsDir() } = {}) {
  try {
    if (!isAccountName(account)) return null;
    const text = readSessionFile(dir, account, MAX_FILE_BYTES);
    if (typeof text !== 'string') return null;
    const file = JSON.parse(text);
    if (file?.account !== account || !Array.isArray(file.samples)) return null;
    return { account, samples: file.samples.filter(isSample).slice(-MAX_SAMPLES) };
  } catch {
    return null; // a half-written or foreign file reads as none: the next change writes it again
  }
}

/** @returns {object | null} the newest sample of a limits file */
export const latestSample = (file) => file?.samples.at(-1) ?? null;

const sameValues = (a, b) => a !== null && WINDOWS.every((name) => JSON.stringify(a[name] ?? null) === JSON.stringify(b[name] ?? null));

/** Appends one line to the account's 7-day log and drops lines older than LOG_KEEP_MS; a link or a foreign file is left alone. */
function appendLog(dir, account, sample) {
  const path = join(dir, `${account}.jsonl`);
  const existing = lstatOrNull(path);
  if (existing === undefined || (existing !== null && (!isPrivateFile(existing) || existing.size > MAX_LOG_BYTES))) return false;
  const old = existing === null ? [] : readFileSync(path, 'utf8').split('\n').filter((line) => {
    try {
      return Number.isFinite(JSON.parse(line).t) && sample.t - JSON.parse(line).t <= LOG_KEEP_MS;
    } catch {
      return false; // a broken line is dropped with the old ones
    }
  });
  writeFileSync(path, `${[...old, JSON.stringify(sample)].join('\n')}\n`, { mode: 0o600 });
  return true;
}

/**
 * Stores a sample when the status input's limits changed since the last one: the file (last MAX_SAMPLES) and one log line.
 * @param {string | undefined} account CLAUDE_ACCOUNT; without one nothing is written
 * @param {{ five_hour?: object, seven_day?: object } | undefined} rateLimits the status input's `rate_limits`
 * @param {{ dir?: string, now?: number }} [deps] the folder and the clock (epoch ms; tests)
 * @returns {boolean} true when a new sample was stored
 */
export function recordSample(account, rateLimits, { dir = limitsDir(), now = Date.now() } = {}) {
  try {
    if (!isAccountName(account) || !rateLimits || typeof rateLimits !== 'object') return false;
    const sample = { t: now, five_hour: windowOf(rateLimits.five_hour), seven_day: windowOf(rateLimits.seven_day) };
    if (sample.five_hour === null && sample.seven_day === null) return false;
    const samples = readLimits(account, { dir })?.samples ?? [];
    if (sameValues(samples.at(-1) ?? null, sample)) return false;
    const stored = writeSessionFile(dir, account, JSON.stringify({ account, samples: [...samples, sample].slice(-MAX_SAMPLES) }), { sweep: false });
    return stored && appendLog(dir, account, sample);
  } catch {
    return false; // the status line must render even when the state folder is unusable
  }
}
