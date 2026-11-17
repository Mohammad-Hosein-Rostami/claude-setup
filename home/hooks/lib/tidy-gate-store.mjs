// The state file of git-tidy-gate.mjs: ~/.claude/state/git-tidy-gate/<session>.json, one per session (lib/session-store.mjs, taken in turns
// with lib/session-lock.mjs).
// Exports: cachedVerdict(env, session, top, fingerprint) -> verdict | undefined, storeVerdict(env, session, top, fingerprint, verdict),
//   recordOnce(env, session, { agent, state, continued }) -> boolean.
// Invariants: the file holds the check verdict of the last REPOS_KEPT repos (one fingerprint each), the STATES_KEPT states already blocked and
//   the length of each agent's chain of blocks. recordOnce is true only for a new state within MAX_CHAINED_BLOCKS blocks in a row, so a gate
//   built on it blocks once per state and never loops; a store that cannot be read or written gives undefined / false (nothing is blocked).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { withSessionLock } from './session-lock.mjs';
import { readSessionFile, writeSessionFile } from './session-store.mjs';

const STATES_KEPT = 50;
const REPOS_KEPT = 5;
const MAX_STORE_BYTES = 64 * 1024;
const MAX_CHAINED_BLOCKS = 2; // as commit-gate: blocks given to continued stops in a row

const stateDir = (env) => join(env.HOME || env.USERPROFILE || homedir(), '.claude', 'state', 'git-tidy-gate');

/** The stored record of a session: {checks: {[repo]: {fingerprint, verdict}}, states, chained}; empty when missing or odd. */
function parseRecord(text) {
  try {
    const record = text === null ? {} : JSON.parse(text);
    const isObject = (value) => value !== null && typeof value === 'object';
    return {
      checks: isObject(record?.checks) ? record.checks : {},
      states: Array.isArray(record?.states) ? record.states : [],
      chained: isObject(record?.chained) ? record.chained : {},
    };
  } catch {
    return { checks: {}, states: [], chained: {} };
  }
}

/** Reads the record, lets `change(record)` edit it and stores it; returns what `change` returned, or undefined when nothing was stored. */
function updateRecord(env, session, change) {
  const dir = stateDir(env);
  return withSessionLock(dir, session, () => {
    const text = readSessionFile(dir, session, MAX_STORE_BYTES);
    if (text === undefined) return undefined;
    const record = parseRecord(text);
    const outcome = change(record);
    const kept = Object.fromEntries(Object.entries(record.checks).slice(-REPOS_KEPT));
    const stored = { checks: kept, states: record.states.slice(-STATES_KEPT), chained: record.chained };
    return writeSessionFile(dir, session, JSON.stringify(stored)) ? outcome : undefined;
  });
}

export const cachedVerdict = (env, session, top, fingerprint) => {
  const entry = parseRecord(readSessionFile(stateDir(env), session, MAX_STORE_BYTES) ?? null).checks[top];
  return entry?.fingerprint === fingerprint ? entry.verdict : undefined;
};

export const storeVerdict = (env, session, top, fingerprint, verdict) => updateRecord(env, session, (record) => {
  delete record.checks[top]; // re-added last: the newest repo is the one kept longest
  record.checks[top] = { fingerprint, verdict };
});

/** Records `state` as blocked; true only when this stop may block (a new state, within the chain bound, and stored). */
export function recordOnce(env, session, { agent, state, continued }) {
  return updateRecord(env, session, (record) => {
    if (record.states.includes(state)) return false;
    const inChain = continued ? Number(record.chained[agent]) || 0 : 0;
    if (inChain >= MAX_CHAINED_BLOCKS) return false;
    record.states.push(state);
    record.chained[agent] = continued ? inChain + 1 : 0;
    return true;
  }) === true;
}
