// Sums agent runs (from transcripts.mjs) into the token view: use per role and per lane, cache reads, writes and rebuilds,
// context fill against the compaction point, waste, and general-purpose spawns per day.
// Exports: summarise(runs) -> TokenView, runTotals(run) -> totals, WASTE_RULES.
// Invariants: pure (no I/O); every token counted once, under one role and one lane; waste is a subset of the totals, never added
// to them; a figure with no source (no compaction seen, so no window) is null, never a guess.
import { CACHE_TTL_MS } from './transcripts.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const LEAD_ROLE = 'lead';
const REVIEW_ROLES = new Set(['reviewer', 'security-auditor']);
/** How a run counts as waste. The transcripts carry no lane verdict, so these read the Agent call's result and description. */
export const WASTE_RULES = {
  failed: 'the Agent call that started it returned an error (is_error in the parent transcript)',
  early: 'its last message stopped at max_tokens or refusal (a workflow agent ending on its output tool call is normal)',
  rework: 'its description starts with "rework" (a correction row of STATUS.md)',
  reviewRound: 'a reviewer or security-auditor run whose description names round 2 or later, a delta or a fix round',
  duplicate: 'the same role and description started again in the same session',
};
const EARLY_STOPS = new Set(['max_tokens', 'refusal']);
const LATER_ROUND = /\bround\s*(?:[2-9]|\d{2,})\b|\bdelta\b|\bfix round\b/i;

/** @returns {{input: number, cacheRead: number, cacheWrite: number, output: number, total: number}} one run's token sums. */
export function runTotals(run) {
  const sums = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 };
  for (const m of run.messages) {
    sums.input += m.input;
    sums.cacheRead += m.cacheRead;
    sums.cacheWrite += m.cacheWrite;
    sums.output += m.output;
  }
  sums.total = sums.input + sums.cacheRead + sums.cacheWrite + sums.output;
  return sums;
}

const roleOf = (run) => (run.meta ? run.meta.agentType || run.messages.find((m) => m.agent)?.agent || 'subagent' : LEAD_ROLE);

/** The most frequent value among the messages, or '' when none has one. */
function mostFrequent(values) {
  const counts = new Map();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

/** The lane of a run: its most frequent git branch other than HEAD, else its most frequent working folder (last two
 * parts of the path), else its project. */
function laneOf(run) {
  const branch = mostFrequent(run.messages.map((m) => (m.branch === 'HEAD' ? '' : m.branch)));
  const folder = mostFrequent(run.messages.map((m) => m.cwd.split(/[\\/]/).filter(Boolean).slice(-2).join('/')));
  return branch || folder || run.project;
}

/** Cache rebuilds: a message after an idle gap longer than its cache lifetime that wrote more than it read. */
function rebuildsOf(run) {
  let count = 0;
  let tokens = 0;
  for (let i = 1; i < run.messages.length; i++) {
    const [before, now] = [run.messages[i - 1], run.messages[i]];
    const ttl = CACHE_TTL_MS[now.ttl] ?? CACHE_TTL_MS['5m'];
    if (now.t - before.t > ttl && now.cacheWrite > now.cacheRead) {
      count += 1;
      tokens += now.cacheWrite;
    }
  }
  return { count, tokens };
}

/** The waste reasons of one run, given the failed Agent calls of its session and the starts seen so far. */
function wasteOf(run, failedCalls, seenStarts) {
  if (!run.meta) return [];
  const reasons = [];
  const description = run.meta.description ?? '';
  const last = run.messages.at(-1);
  if (run.meta.toolUseId && failedCalls.has(run.meta.toolUseId)) reasons.push('failed');
  if (last && EARLY_STOPS.has(last.stop)) reasons.push('early');
  if (/^\s*rework\b/i.test(description)) reasons.push('rework');
  if (REVIEW_ROLES.has(roleOf(run)) && LATER_ROUND.test(description)) reasons.push('reviewRound');
  const key = `${run.session}\u0000${roleOf(run)}\u0000${description}`;
  if (description && seenStarts.has(key)) reasons.push('duplicate');
  seenStarts.add(key);
  return reasons;
}

const addTo = (map, key, totals) => {
  const row = map.get(key) ?? { runs: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, start: 0 };
  for (const field of ['input', 'cacheRead', 'cacheWrite', 'output', 'total', 'start']) row[field] += totals[field] ?? 0;
  row.runs += 1;
  map.set(key, row);
};

/** Per session: the largest context seen, the compactions, and the compaction point (largest preTokens seen anywhere). */
function contextOf(runs) {
  const window = Math.max(0, ...runs.flatMap((run) => run.compactions)) || null;
  const sessions = runs
    .filter((run) => !run.meta && run.messages.length)
    .map((run) => {
      const peak = Math.max(0, ...run.messages.map((m) => m.context));
      return { session: run.session, project: run.project, peak, compactions: run.compactions.length, fill: window ? peak / window : null };
    });
  return { window, sessions };
}

/** An empty view: the shape summarise fills. */
function emptyView() {
  const byReason = Object.fromEntries(Object.keys(WASTE_RULES).map((key) => [key, { runs: 0, tokens: 0 }]));
  return {
    roles: new Map(), lanes: new Map(), total: 0, generalPurposePerDay: new Map(),
    cache: { reads: 0, writes: 0, rebuilds: 0, rebuildTokens: 0 }, waste: { tokens: 0, byReason, runs: [] },
  };
}

/** Adds one run to the view (totals, role, lane, cache, waste, general-purpose day). */
function countRun(view, run, failedCalls, seenStarts) {
  const role = roleOf(run);
  const totals = { ...runTotals(run), start: run.messages[0]?.context ?? 0 };
  view.total += totals.total;
  addTo(view.roles, role, totals);
  addTo(view.lanes, laneOf(run), totals);
  const rebuilds = rebuildsOf(run);
  view.cache.reads += totals.cacheRead;
  view.cache.writes += totals.cacheWrite;
  view.cache.rebuilds += rebuilds.count;
  view.cache.rebuildTokens += rebuilds.tokens;
  const reasons = wasteOf(run, failedCalls, seenStarts);
  for (const reason of reasons) {
    view.waste.byReason[reason].runs += 1;
    view.waste.byReason[reason].tokens += totals.total;
  }
  if (reasons.length) {
    view.waste.tokens += totals.total;
    view.waste.runs.push({ role, description: run.meta.description ?? '', reasons, tokens: totals.total });
  }
  if (role === 'general-purpose' && run.messages.length) {
    const day = new Date(Math.floor(run.messages[0].t / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
    view.generalPurposePerDay.set(day, (view.generalPurposePerDay.get(day) ?? 0) + 1);
  }
}

/**
 * The token view of a set of runs.
 * @param {object[]} runs - readRun results (lead files and subagent files of the same period).
 * @returns {object} { roles, lanes, cache, context, waste, generalPurposePerDay, total }; roles and lanes are Maps of sums.
 */
export function summarise(runs) {
  const failedBySession = new Map();
  for (const run of runs) if (!run.meta) failedBySession.set(run.session, run.failedCalls);
  const view = emptyView();
  const seenStarts = new Set();
  const inStartOrder = [...runs].sort((a, b) => (a.messages[0]?.t ?? 0) - (b.messages[0]?.t ?? 0));
  for (const run of inStartOrder) countRun(view, run, failedBySession.get(run.session) ?? new Set(), seenStarts);
  return { ...view, context: contextOf(runs) };
}
