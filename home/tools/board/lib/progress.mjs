// How far a running subagent is, honestly (research-tui 3.4, spec-tui "Agent progress"): a blend of the evidence its transcript
// shows (the brief's numbered steps done by commits, or generic milestones) and its elapsed time against the run times of finished
// agents of its type, judged only against runs that lasted longer than it has so far (survival conditioning). The agent's own
// words are never the bar.
// Exports: agentProgress(facts, pool, nowMs) -> progress; quantile(sorted, q).
// Formula: t = e / Dmed(e) with Dmed(e), Dp85(e) the median and 85th percentile of the pool's runs longer than e; m = steps done /
// steps when the brief has 3 or more numbered steps (a step counts done when commits >= its number), else the generic writer or
// reader milestones; p = clamp(w_m * m + (1 - w_m) * min(t, 1), 0, 0.95) with w_m 0.7 (steps), 0.5 (milestones), and m alone
// when the type has no pool; never lower than the last shown value unless steps were added (tag `+steps`); 1 only when done.
// Confidence: high (3+ steps, 1+ done, pool >= MIN_CONFIDENT_RUNS) shows `62%`; medium (pool >= MIN_CONFIDENT_RUNS with
// Dp85/Dmed <= 3, or 2+ milestones done) shows `~60%`; low (the rest, and the first minute of any agent) shows `est…`.
// Time: left = Dmed(e) - e (median) up to Dp85(e) - e; over usual = e - p85 of the whole pool when positive.
// Invariants: pure (no I/O, no clock of its own); every number returned is finite or null.

const MS_PER_MIN = 60_000;
const PERCENT = 100;
const MAX_SHOWN = 0.95;
const STEPS_WEIGHT = 0.7;
const MILESTONE_WEIGHT = 0.5;
const MIN_STEPS = 3;
const MIN_POOL_RUNS = 5; // fewer finished runs than this: the type counts as unknown
const MIN_CONFIDENT_RUNS = 20;
const MAX_SPREAD = 3; // Dp85 / Dmed above this: time alone says little
const LOW_FIRST_MIN = 1;
const P50 = 0.5;
const P85 = 0.85;
const LONG_TEXT_CHARS = 500;
const QUIET_AFTER_TEXT_MS = 30_000;
// Writer milestones (research-tui 3.4 step 3): first Read, first Edit/Write, first test or check run, first commit, report written.
const WRITER_MILESTONES = [['reads', 0.05], ['edits', 0.25], ['checks', 0.15], ['commits', 0.3], ['reports', 0.25]];
// Reader milestones: calls past the type's usual first quarter, a file written, a long answer with no call after it.
const READER_WEIGHTS = { calls: 0.3, writes: 0.5, answer: 0.2 };
// Tool calls at the 25th percentile per type, measured on this machine (research-tui 3.3); other types use DEFAULT_CALLS_P25.
const CALLS_P25 = { implementer: 12, 'general-purpose': 4, 'workflow-subagent': 5, architect: 24, 'deep-debugger': 27, runner: 2 };
const DEFAULT_CALLS_P25 = 5;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/**
 * @param {number[]} sorted ascending numbers
 * @param {number} q the share, 0..1
 * @returns {number | null} the q-quantile (nearest rank), null for an empty list
 */
export function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  return sorted[clamp(Math.ceil(q * sorted.length) - 1, 0, sorted.length - 1)];
}

/** The evidence share m and how many milestones are done; steps when the brief has enough of them. */
function evidenceOf(facts, nowMs) {
  const steps = facts.steps ?? 0;
  if (steps >= MIN_STEPS) {
    const done = Math.min(facts.commits, steps);
    return { m: done / steps, done, steps: true };
  }
  if (facts.writer) {
    const reached = WRITER_MILESTONES.filter(([key]) => facts[key] > 0);
    return { m: reached.reduce((sum, [, weight]) => sum + weight, 0), done: reached.length, steps: false };
  }
  const answered = facts.lastTextChars > LONG_TEXT_CHARS && !facts.pending && nowMs - (facts.lastMs ?? nowMs) > QUIET_AFTER_TEXT_MS;
  const reached = [
    facts.calls >= (CALLS_P25[facts.type] ?? DEFAULT_CALLS_P25) ? READER_WEIGHTS.calls : 0,
    facts.writes > 0 ? READER_WEIGHTS.writes : 0,
    answered ? READER_WEIGHTS.answer : 0,
  ].filter((weight) => weight > 0);
  return { m: reached.reduce((sum, weight) => sum + weight, 0), done: reached.length, steps: false };
}

/** The pool's view of an agent running for `e` minutes: conditioned median and 85th percentile, usual times, over usual. */
function timeOf(pool, e) {
  const usable = Array.isArray(pool) && pool.length >= MIN_POOL_RUNS ? pool : [];
  const longer = usable.filter((minutes) => minutes > e);
  const usual = usable.length > 0 ? [quantile(usable, P50), quantile(usable, P85)] : null;
  return {
    runs: usable.length, usual,
    med: quantile(longer, P50), p85: quantile(longer, P85),
    overMin: usual !== null && e > usual[1] ? e - usual[1] : 0,
  };
}

function confidenceOf(facts, evidence, time, elapsedMin) {
  if (elapsedMin < LOW_FIRST_MIN) return 'low';
  if (evidence.steps && evidence.done >= 1 && time.runs >= MIN_CONFIDENT_RUNS) return 'high';
  const steady = time.runs >= MIN_CONFIDENT_RUNS && time.med !== null && time.p85 / time.med <= MAX_SPREAD;
  return steady || evidence.done >= 2 ? 'medium' : 'low';
}

/**
 * @param {object} facts the agent's cursor (agent-transcript.mjs) plus { type, writer, done, doneMs }
 * @param {number[] | undefined} pool the sorted run minutes of finished agents of its type (pools.mjs)
 * @param {number} nowMs now
 * @returns {{ pct: number, conf: 'high' | 'medium' | 'low', elapsedMin: number, leftMin: number | null, highLeftMin: number | null,
 *   overMin: number, usual: [number, number] | null, tag: string | null, shownPct: number, stepsSeen: number }} pct 0..100; shownPct
 *   and stepsSeen are stored back into the cursor
 */
export function agentProgress(facts, pool, nowMs) {
  const endMs = facts.done && Number.isFinite(facts.doneMs) ? facts.doneMs : nowMs;
  const elapsedMin = Math.max(0, (endMs - (facts.startMs ?? endMs)) / MS_PER_MIN);
  const time = timeOf(pool, elapsedMin);
  const evidence = evidenceOf(facts, nowMs);
  const steps = facts.steps ?? 0;
  const tag = steps > (facts.stepsSeen ?? 0) && (facts.stepsSeen ?? 0) > 0 ? '+steps' : null;
  if (facts.done) {
    return { pct: PERCENT, conf: 'high', elapsedMin, leftMin: 0, highLeftMin: 0, overMin: time.overMin, usual: time.usual, tag: null, shownPct: 1, stepsSeen: steps };
  }
  const share = time.med === null ? 1 : Math.min(elapsedMin / time.med, 1);
  const weight = evidence.steps ? STEPS_WEIGHT : MILESTONE_WEIGHT;
  const raw = time.runs === 0 ? evidence.m : weight * evidence.m + (1 - weight) * share;
  const fresh = clamp(raw, 0, MAX_SHOWN);
  const shown = tag === null ? Math.max(fresh, facts.shownPct ?? 0) : fresh;
  return {
    pct: Math.round(shown * PERCENT), conf: confidenceOf(facts, evidence, time, elapsedMin), elapsedMin,
    leftMin: time.med === null ? null : Math.max(0, time.med - elapsedMin),
    highLeftMin: time.p85 === null ? null : Math.max(0, time.p85 - elapsedMin),
    overMin: time.overMin, usual: time.usual, tag, shownPct: shown, stepsSeen: Math.max(steps, facts.stepsSeen ?? 0),
  };
}
