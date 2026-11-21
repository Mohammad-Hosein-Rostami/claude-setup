// Text and JSON forms of the token view (summary.mjs) and the limit logs (limits.mjs).
// Exports: printView(view, limits, { detail }) -> string, viewJson(view, limits) -> object.
// Invariants: pure; shares are of the period's total, so they sum to about 100%; no dollar figure (the owner wants none outside a
// detail view, and the transcripts give tokens only).
import { WASTE_RULES } from './summary.mjs';

const TOP_LANES = 10; // the summary lists the ten heaviest lanes; --detail lists all
const thousands = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const share = (part, whole) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : '-');

/** Rows of a role or lane Map, heaviest first. */
const rowsOf = (map) => [...map.entries()].sort((a, b) => b[1].total - a[1].total);

function limitLines(limits) {
  if (!limits.length) return ['(a) limits: no limit log yet (the status line writes ~/.claude/state/limits/<account>.jsonl)'];
  const lines = ['(a) limits per account (highest 7-day / 5-hour use per day):'];
  for (const { account, days } of limits) {
    const cells = days.map((d) => `${d.day.slice(5)} ${d.sevenDayMax ?? '-'}%/${d.fiveHourMax ?? '-'}%`);
    lines.push(`  ${account}: ${cells.join('  ') || 'no sample in the period'}`);
  }
  return lines;
}

function useLines(view, detail) {
  const lines = ['(b) use per role (share of all tokens; start = context of the first request, averaged):'];
  for (const [role, row] of rowsOf(view.roles)) {
    lines.push(`  ${role.padEnd(18)} ${share(row.total, view.total).padStart(6)}  ${thousands(row.total).padStart(7)}  runs ${row.runs}  start ~${thousands(Math.round(row.start / row.runs))}`);
  }
  lines.push('    per lane (git branch, else working folder):');
  for (const [lane, row] of rowsOf(view.lanes).slice(0, detail ? undefined : TOP_LANES)) {
    lines.push(`  ${lane.slice(0, 40).padEnd(40)} ${share(row.total, view.total).padStart(6)}  ${thousands(row.total).padStart(7)}  runs ${row.runs}`);
  }
  return lines;
}

function cacheLines(view, detail) {
  const { cache, context } = view;
  const lines = [`(c) cache: reads ${thousands(cache.reads)}, writes ${thousands(cache.writes)}, rebuilds after an idle gap ${cache.rebuilds} (${thousands(cache.rebuildTokens)} written again)`];
  const window = context.window ? `compaction point ~${thousands(context.window)} (largest preTokens seen)` : 'no compaction seen, so no fill figure';
  lines.push(`    context: ${window}`);
  const sessions = [...context.sessions].sort((a, b) => b.peak - a.peak).slice(0, detail ? undefined : TOP_LANES);
  for (const s of sessions) {
    const fill = s.fill === null ? '' : `  fill ${share(s.fill, 1)}`;
    lines.push(`  ${s.session.slice(0, 8)} ${s.project.slice(-30).padEnd(30)} peak ${thousands(s.peak)}  compactions ${s.compactions}${fill}`);
  }
  return lines;
}

function wasteLines(view, detail) {
  const { waste } = view;
  const lines = [`(d) waste: ${thousands(waste.tokens)} (${share(waste.tokens, view.total)} of all tokens; a run counts once)`];
  for (const [reason, rule] of Object.entries(WASTE_RULES)) {
    const row = waste.byReason[reason];
    lines.push(`  ${reason.padEnd(12)} runs ${row.runs}  ${thousands(row.tokens)}  - ${rule}`);
  }
  if (detail) for (const run of waste.runs) lines.push(`    ${run.role}: ${run.description.slice(0, 60)} [${run.reasons.join(', ')}] ${thousands(run.tokens)}`);
  return lines;
}

/**
 * The view as text.
 * @param {object} view - summarise() result.
 * @param {object[]} limits - readLimitLogs() result.
 * @param {{detail?: boolean}} [options] - detail lists every lane, session and wasted run.
 * @returns {string} the printed view.
 */
export function printView(view, limits, { detail = false } = {}) {
  const spawns = [...view.generalPurposePerDay.entries()].sort().map(([day, n]) => `${day.slice(5)} ${n}`);
  return [
    `token view: ${thousands(view.total)} tokens in the period`,
    ...limitLines(limits),
    ...useLines(view, detail),
    ...cacheLines(view, detail),
    ...wasteLines(view, detail),
    `(e) general-purpose spawns per day: ${spawns.join('  ') || 'none'}`,
  ].join('\n');
}

/** The view as plain JSON (Maps become objects). */
export function viewJson(view, limits) {
  return {
    total: view.total, roles: Object.fromEntries(view.roles), lanes: Object.fromEntries(view.lanes), cache: view.cache,
    context: view.context, waste: view.waste, generalPurposePerDay: Object.fromEntries(view.generalPurposePerDay), limits,
  };
}
