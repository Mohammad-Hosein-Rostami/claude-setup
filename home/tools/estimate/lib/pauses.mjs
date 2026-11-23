// The pauses of a job and why they happened (estimate spec R11, owner decision E3): the clocks assume no pause ("13:20 if no
// pause"); a pause moves them hour for hour, and its reason is shown.
// Exports: pausesOf(intervals, asks, limits, sinceMs, nowMs) -> pauses, PAUSE_REASONS, LIMIT_END_SLACK_MIN.
// Rules:
// - A pause is a silence of more than IDLE_GAP_MIN minutes in all of the job's transcripts together (the activity runs of every
//   session linked to the table): between two runs, or from the last run to now (a pause still going on). Shorter silences are
//   working time (worked.mjs bridges them). Before the first run nothing is known, so nothing is claimed: no activity at all
//   gives no pause, never one as long as the job (a pause excuses time, so missing data must not invent one).
// - Each pause is clipped to [sinceMs, nowMs]; it qualifies by its whole length.
// - Its reason, first match: `waiting for you` when an owner wait overlaps it (an AskUserQuestion from tool_use to tool_result,
//   transcript-facts.mjs asksOf, or a `waiting:` row from its start to now, both passed in `asks`); `usage limit` when it ends
//   within LIMIT_END_SLACK_MIN after a 5-hour reset that a sample of the job's own account recorded at 100 % (a pause still going
//   on also counts while that reset is still ahead); else `no activity`.
// - Two machines (F4): only the record of the job's account is read; a record of any other account is never used.
// Invariants: pure (no I/O, no clock); runs are epoch minutes, everything else epoch ms; malformed runs, asks and samples are
// skipped (a skipped sample can only turn `usage limit` into `no activity`, never invent a pause).
import { IDLE_GAP_MIN } from './worked.mjs';

/** The reasons a pause can have, in the order they are tried. */
export const PAUSE_REASONS = Object.freeze(['waiting for you', 'usage limit', 'no activity']);
/** Minutes after a 5-hour reset within which the end of a pause is put down to the usage limit (spec R11). */
export const LIMIT_END_SLACK_MIN = 10;
const [WAITING, LIMIT, IDLE] = PAUSE_REASONS;
const MS_PER_MIN = 60_000;
const MS_PER_S = 1000;
const FULL_PERCENT = 100;

const isMs = (value) => Number.isFinite(value) && value >= 0;
const isRun = (run) => Array.isArray(run) && run.length === 2 && run.every(Number.isFinite) && run[0] < run[1];
const isWait = (ask) => ask !== null && typeof ask === 'object' && isMs(ask.fromMs) && isMs(ask.toMs) && ask.toMs >= ask.fromMs;

/** The silences over IDLE_GAP_MIN minutes as { fromMs, toMs, open } (open: still going on at now), oldest first. */
function silencesOf(intervals, nowMs) {
  const runs = intervals.filter(isRun).filter(([start]) => start * MS_PER_MIN <= nowMs).sort((a, b) => a[0] - b[0]);
  const silences = [];
  let lastEndMs = null;
  for (const [start, end] of runs) {
    const startMs = start * MS_PER_MIN;
    if (lastEndMs !== null && startMs - lastEndMs > IDLE_GAP_MIN * MS_PER_MIN) silences.push({ fromMs: lastEndMs, toMs: startMs, open: false });
    lastEndMs = Math.max(lastEndMs ?? 0, Math.min(end * MS_PER_MIN, nowMs));
  }
  if (lastEndMs !== null && nowMs - lastEndMs > IDLE_GAP_MIN * MS_PER_MIN) silences.push({ fromMs: lastEndMs, toMs: nowMs, open: true });
  return silences;
}

/** The 5-hour resets (epoch ms) that the job's own account recorded at 100 % use. */
function fullResetsOf(limits) {
  const account = typeof limits?.account === 'string' ? limits.account : null;
  const records = Array.isArray(limits?.records) ? limits.records : [];
  return records.filter((record) => account !== null && record?.account === account && Array.isArray(record.samples))
    .flatMap((record) => record.samples)
    .filter((sample) => isMs(sample?.t) && sample.five_hour?.used_percentage >= FULL_PERCENT && isMs(sample.five_hour.resets_at))
    .filter((sample) => sample.t <= sample.five_hour.resets_at * MS_PER_S) // recorded before its reset
    .map((sample) => sample.five_hour.resets_at * MS_PER_S);
}

/** Why one silence happened (see the header for the order). */
function reasonOf(silence, waits, resets) {
  if (waits.some((wait) => wait.fromMs < silence.toMs && wait.toMs > silence.fromMs)) return WAITING;
  const slackMs = LIMIT_END_SLACK_MIN * MS_PER_MIN;
  const limited = resets.some((resetMs) => {
    const endsAfterReset = resetMs <= silence.toMs && silence.toMs <= resetMs + slackMs;
    const resetStillAhead = silence.open && resetMs > silence.toMs;
    return endsAfterReset || resetStillAhead;
  });
  return limited ? LIMIT : IDLE;
}

/**
 * The job's pauses since sinceMs (R11, E3).
 * @param {[number, number][]} intervals the activity runs (or working intervals) of all the job's sessions, epoch minutes
 * @param {{ fromMs: number, toMs: number }[]} asks the owner waits: AskUserQuestion intervals of the main transcripts (asksOf),
 *   the live asking marker to now, and each `waiting:` row from its start to now
 * @param {{ account: string | null, records: ({ account: string, samples: object[] } | null)[] }} limits the job's account and the
 *   limits records read (limits-store.mjs readLimits); records of another account are not used (F4)
 * @param {number} sinceMs the start of the counted time (the promise), epoch ms
 * @param {number} nowMs now, epoch ms
 * @returns {{ fromMs: number, toMs: number, reason: 'waiting for you'|'usage limit'|'no activity' }[]} oldest first; the pauses over
 *   IDLE_GAP_MIN minutes, clipped to [sinceMs, nowMs]
 * @throws {TypeError} when intervals or asks is not an array, or sinceMs or nowMs is not a time (a caller's mistake, not data)
 */
export function pausesOf(intervals, asks, limits, sinceMs, nowMs) {
  if (!Array.isArray(intervals) || !Array.isArray(asks) || !isMs(sinceMs) || !isMs(nowMs)) {
    throw new TypeError('pausesOf(intervals[], asks[], limits, sinceMs, nowMs): intervals and asks must be arrays, the times epoch ms');
  }
  const waits = asks.filter(isWait);
  const resets = fullResetsOf(limits);
  return silencesOf(intervals, nowMs).flatMap((silence) => {
    const fromMs = Math.max(silence.fromMs, sinceMs);
    const toMs = Math.min(silence.toMs, nowMs);
    return toMs > fromMs ? [{ fromMs, toMs, reason: reasonOf(silence, waits, resets) }] : [];
  });
}
