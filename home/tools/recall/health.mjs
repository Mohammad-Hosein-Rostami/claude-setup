#!/usr/bin/env node
// Purpose: the two recall health lines doctor prints: is the search index current (its newest transcript chunk at most
// a day old), and did the last checkpoint calls work (not all of the last 10 failed). Usage: node health.mjs.
// Exports: indexFreshness, checkpointCalls. Prints one line per check, `ok    <message>` or `WARN  <message>`; exit 0.
// Invariants: no writes (the index opens through store.mjs, which loads node:sqlite, and only its existing schema is
// checked; the usage log is only read); a missing index or log is a WARN
// line, never a crash; the messages hold counts, ages and error classes, never a token or an error text.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { defaultDbPath, usageLogPath } from './lib/paths.mjs';
import { openStore } from './lib/store.mjs';

const MS_PER_HOUR = 60 * 60 * 1000;
const STALE_AFTER_MS = 24 * MS_PER_HOUR; // spec: warn when the newest chunk is over 1 day old
const LAST_CALLS = 10; // spec: warn when the last 10 checkpoint calls all failed
const CHECKPOINT_LABEL = 'checkpoint';

/**
 * How old the newest indexed transcript message is.
 * @param {object} [env] process env (RECALL_DB).
 * @param {number} [now] the clock (tests).
 * @returns {{level: 'ok' | 'WARN', message: string}}
 */
export function indexFreshness(env = process.env, now = Date.now()) {
  const path = defaultDbPath(env);
  if (!existsSync(path)) return { level: 'WARN', message: `recall: no index at ${path} yet (run: recall index)` };
  const store = openStore(path);
  let ts;
  try {
    // The newest row by id is the last one written: no scan of a 1 GB table for MAX(ts).
    ts = store.db.prepare("SELECT ts FROM chunks WHERE kind IN ('user', 'assistant') ORDER BY id DESC LIMIT 1").get()?.ts;
  } finally {
    store.close();
  }
  const at = Date.parse(ts ?? '');
  if (!Number.isFinite(at)) return { level: 'WARN', message: 'recall: the index holds no transcript message yet (run: recall index)' };
  const hours = Math.round((now - at) / MS_PER_HOUR);
  if (now - at > STALE_AFTER_MS) return { level: 'WARN', message: `recall: the newest indexed message is ${hours} h old; the checkpoint job did not bring the index up to date (run: recall index)` };
  return { level: 'ok', message: `recall: index current (newest message ${hours} h old)` };
}

/**
 * Whether the last LAST_CALLS checkpoint calls of usage.jsonl all failed.
 * @param {object} [env] process env (RECALL_USAGE_LOG, RECALL_STATE_DIR, RECALL_DB).
 * @returns {{level: 'ok' | 'WARN', message: string}}
 */
export function checkpointCalls(env = process.env) {
  const path = usageLogPath(env);
  if (!existsSync(path)) return { level: 'ok', message: 'recall: no checkpoint call yet' };
  const rows = readFileSync(path, 'utf8').split('\n').flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; } // a cut or empty line is not a call
  }).filter((row) => row?.label === CHECKPOINT_LABEL).slice(-LAST_CALLS);
  const failed = rows.filter((row) => row.is_error);
  if (rows.length < LAST_CALLS || failed.length < rows.length) return { level: 'ok', message: `recall: ${rows.length - failed.length} of the last ${rows.length} checkpoint calls worked` };
  const classes = {};
  for (const row of failed) classes[row.error ?? 'unknown'] = (classes[row.error ?? 'unknown'] ?? 0) + 1;
  const byClass = Object.entries(classes).map(([name, n]) => `${name} ${n}`).join(', ');
  return { level: 'WARN', message: `recall: the last ${LAST_CALLS} checkpoint calls all failed (${byClass}); auth means the hook job had no login (claude-as <name>, or set a default account)` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  for (const check of [indexFreshness, checkpointCalls]) {
    let result;
    try {
      result = check();
    } catch (error) {
      result = { level: 'WARN', message: `recall: health check ${check.name} could not run: ${error.message}` };
    }
    console.log(`${result.level === 'ok' ? 'ok   ' : 'WARN '} ${result.message}`);
  }
}
