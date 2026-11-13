// Purpose: log every Haiku call of the checkpoint job to usage.jsonl and total it for `recall status`.
// Exports: logUsage, usageTotals, countedTokens.
// Invariants: one JSON row per call (ts, session, label, attempt, model, input, cache_creation, cache_read, output,
// cost_usd_list, ms, is_error); "counted" tokens = input + cache_creation + output (cache reads are logged separately,
// as in the study); a missing or partly unreadable log totals what can be read, it never throws.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { usageLogPath } from './paths.mjs';
import { PRIVATE_FILE_MODE, ensurePrivateDir } from './private-fs.mjs';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const WEEK_DAYS = 7;

/** Tokens that count against the subscription for one row. */
export const countedTokens = (row) => (row.input ?? 0) + (row.cache_creation ?? 0) + (row.output ?? 0);

/** Append one usage row ({ts} is added). */
export function logUsage(row, env = process.env) {
  const path = usageLogPath(env);
  ensurePrivateDir(dirname(path));
  appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...row })}\n`, { mode: PRIVATE_FILE_MODE });
}

/** Counted tokens and calls today (since local midnight) and in the last 7 days: { today: {calls, tokens}, week: {...} }. */
export function usageTotals(env = process.env, now = Date.now()) {
  const totals = { today: { calls: 0, tokens: 0 }, week: { calls: 0, tokens: 0 } };
  const path = usageLogPath(env);
  if (!existsSync(path)) return totals;
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const at = Date.parse(row.ts);
    if (!Number.isFinite(at)) continue;
    const tokens = countedTokens(row);
    if (at >= now - WEEK_DAYS * MS_PER_DAY) { totals.week.calls += 1; totals.week.tokens += tokens; }
    if (at >= midnight) { totals.today.calls += 1; totals.today.tokens += tokens; }
  }
  return totals;
}
