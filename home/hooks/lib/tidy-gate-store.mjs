// The state file of git-tidy-gate.mjs: ~/.claude/state/git-tidy-gate/<session>.json, one per session (lib/session-store.mjs, taken in turns
// with lib/session-lock.mjs).
// Exports: cachedVerdict(env, session, repoState, now?) -> verdict | undefined, storeVerdict(env, session, repoState, verdict).
//   A repoState is {top, fingerprint}.
// Invariants: the file holds the check verdict of the last REPOS_KEPT repos (one fingerprint and check time each; a verdict older than
//   VERDICT_MAX_AGE_MS is not served, since some findings depend on the clock); a store that cannot be read or written gives undefined.
//   A write that would pass MAX_STORE_BYTES (the read cap) first drops the oldest repos' verdicts, so the file can always be read back.
//   A file from an older release also holds `states` and `chained` (the removed stop gate's blocks): they are read past and dropped.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { withSessionLock } from './session-lock.mjs';
import { readSessionFile, writeSessionFile } from './session-store.mjs';

const REPOS_KEPT = 5;
const MAX_STORE_BYTES = 64 * 1024;
const VERDICT_MAX_AGE_MS = 10 * 60 * 1000; // an "unlanded for 2 h" finding or a 60-minute worktree rule changes with time alone

const stateDir = (env) => join(env.HOME || env.USERPROFILE || homedir(), '.claude', 'state', 'git-tidy-gate');

/** The stored record of a session: {checks: {[repo]: {fingerprint, checkedAtMs, verdict}}}; empty when missing or odd. */
function parseRecord(text) {
  try {
    const record = text === null ? {} : JSON.parse(text);
    return { checks: record?.checks !== null && typeof record?.checks === 'object' ? record.checks : {} };
  } catch {
    return { checks: {} };
  }
}

/** The record as text with as many of the newest repos as fit under MAX_STORE_BYTES; null when even none fit. */
function withinStoreLimit(repos) {
  for (let keep = repos.length; keep >= 0; keep -= 1) {
    const text = JSON.stringify({ checks: Object.fromEntries(repos.slice(repos.length - keep)) });
    if (Buffer.byteLength(text) <= MAX_STORE_BYTES) return text;
  }
  return null;
}

/** Reads the record, lets `change(record)` edit it and stores it; returns what `change` returned, or undefined when nothing was stored. */
function updateRecord(env, session, change) {
  const dir = stateDir(env);
  return withSessionLock(dir, session, () => {
    const text = readSessionFile(dir, session, MAX_STORE_BYTES);
    if (text === undefined) return undefined;
    const record = parseRecord(text);
    const outcome = change(record);
    const stored = withinStoreLimit(Object.entries(record.checks).slice(-REPOS_KEPT));
    return stored !== null && writeSessionFile(dir, session, stored) ? outcome : undefined;
  });
}

/**
 * The stored check verdict of a repo when its refs and worktrees are unchanged and it was checked less than VERDICT_MAX_AGE_MS before `now`.
 * @param {{top: string, fingerprint: string}} repoState the worktree folder and the hash of its repository's refs and worktree list
 * @returns the verdict, or undefined (never stored, changed, expired or unreadable store)
 */
export const cachedVerdict = (env, session, { top, fingerprint }, now = Date.now()) => {
  const entry = parseRecord(readSessionFile(stateDir(env), session, MAX_STORE_BYTES) ?? null).checks[top];
  const fresh = entry?.checkedAtMs <= now && now - entry.checkedAtMs < VERDICT_MAX_AGE_MS;
  return fresh && entry.fingerprint === fingerprint ? entry.verdict : undefined;
};

/** Stores `verdict` as the check of `repoState` ({top, fingerprint}) made now; undefined when the store cannot be written. */
export const storeVerdict = (env, session, { top, fingerprint }, verdict) => updateRecord(env, session, (record) => {
  delete record.checks[top]; // re-added last: the newest repo is the one kept longest
  record.checks[top] = { fingerprint, checkedAtMs: Date.now(), verdict };
});
