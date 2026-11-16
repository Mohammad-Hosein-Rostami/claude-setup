// Tests for the estimate's printed text (home/tools/estimate/lib/report.mjs) and the local clock it uses: every line of the
// estimator design's sections 4.1 and 4.2 by exact string. The results are built by hand; the clocks are in Asia/Tehran (+03:30)
// like the design's examples, so the expected strings are the design's own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { clockText, dayText, gridded, offsetText } from '../home/tools/estimate/lib/local-clock.mjs';
import { formatEstimate, formatRefusal, hoursText, workText } from '../home/tools/estimate/lib/report.mjs';

const TZ = 'Asia/Tehran';
const INPUTS = { timeZone: TZ };
const at = (hour, minute, day = 16) => Date.UTC(2026, 10, day, hour, minute);
const NOW = at(15, 35); // 19:05 local
const STALE = { kind: 'stale', id: 'b12', size: 'M', elapsedMin: 190, longestMin: 139 };

/** A finish result as estimateFile returns it, with the design's example numbers. */
const finish = (fields = {}) => ({
  state: 'finish',
  nowMs: NOW,
  finish: { clockMs: at(18, 8), likelyMs: at(17, 17), lateMs: at(19, 36), ahead: false },
  commit: { atMs: at(14, 40), budgetMin: 300, leftMin: 155, pausedMin: 0, moved: null },
  covers: { open: 9, running: 2, sizes: { S: 5, M: 3, L: 1 }, growth: 0.42 },
  work: { p50: 105, p85: 155, p95: 241 },
  record: { met: 9, of: 10 },
  pool: { rows: 146, jobs: 10 },
  checks: [STALE],
  ...fields,
});
const lines = (result) => formatEstimate(result, INPUTS).split('\n');

test('the finish block: every line of design 4.1 in order', () => {
  assert.deepEqual(lines(finish()), [
    'Finish: Mon 16 Nov 21:40 (85% sure; likely 20:50, 95% by 23:10; local +03:30, now 19:05)',
    'Covers: 9 open rows (2 running; 5 S, 3 M, 1 L) and work not listed yet (usually 42% of what is left); 2 h 35 of work left in this time.',
    'Excludes: pauses (nights, usage limits, waiting for you) move the time hour for hour; rework after hand-over; new requests.',
    'Held: given Mon 16 Nov 18:10, unchanged since.',
    'Track record: 9 of the last 10 jobs were done by the first time given.',
    'Check: row b12 (M) has taken 3 h 10 of work, longer than every finished M row (2 h 19): finish it, or close it with evidence "dropped: <why>".',
  ]);
});

test('line 1 when the fresh p95 is earlier than the time given; a clock on another local day gets its weekday', () => {
  assert.equal(lines(finish({ finish: { clockMs: at(18, 8), likelyMs: at(16, 48), lateMs: at(17, 30), ahead: true } }))[0],
    'Finish: Mon 16 Nov 21:40 (likely 20:20, ahead of the time given; local +03:30, now 19:05)');
  const overnight = finish({ finish: { clockMs: at(20, 46), likelyMs: at(20, 16), lateMs: at(21, 6), ahead: false } }); // 00:20, 23:50, 00:40
  assert.equal(lines(overnight)[0], 'Finish: Tue 17 Nov 00:20 (85% sure; likely Mon 23:50, 95% by 00:40; local +03:30, now 19:05)');
});

test('Moved: each stored cause, with the pauses since the commitment from 5 minutes up', () => {
  const moved = (cause, ids, size = null, pausedMin = 0) => finish({ commit: { atMs: at(16, 10), budgetMin: 300, leftMin: 155, pausedMin, moved: { atMs: at(16, 10), wasClockMs: at(17, 33), cause, ids, size } } });
  assert.equal(lines(moved('rows-added', ['c7', 'c8', 'c9', 'c10', 'c11', 'c12']))[3], 'Moved: at 19:40 from 21:05, because 6 rows were added (c7, c8, c9, c10, c11 and 1 more); unchanged since.');
  assert.equal(lines(moved('rows-added', ['c7']))[3], 'Moved: at 19:40 from 21:05, because 1 row was added (c7); unchanged since.');
  assert.equal(lines(moved('slow-row', ['b12'], 'M'))[3], 'Moved: at 19:40 from 21:05, because row b12 is taking longer than 85% of M rows; unchanged since.');
  assert.equal(lines(moved('pace', [], null, 80))[3], 'Moved: at 19:40 from 21:05, because the open rows are taking longer than usual; unchanged since. Pauses since then: 1 h 20.');
  assert.equal(lines(moved('pace', [], null, 4))[3], 'Moved: at 19:40 from 21:05, because the open rows are taking longer than usual; unchanged since.');
  assert.equal(lines(finish({ commit: { atMs: at(14, 40), budgetMin: 300, leftMin: 155, pausedMin: 5, moved: null } }))[3], 'Held: given Mon 16 Nov 18:10, unchanged since. Pauses since then: 5 min.');
});

test('the track record before any score, the sizes with no open row left out, and one open row', () => {
  const first = lines(finish({ record: null, covers: { open: 1, running: 0, sizes: { S: 0, M: 1, L: 0 }, growth: 0 }, commit: { atMs: at(14, 40), budgetMin: 40, leftMin: 35, pausedMin: 0, moved: null }, checks: [] }));
  assert.equal(first[1], 'Covers: 1 open row (0 running; 1 M) and work not listed yet (usually 0% of what is left); 35 min of work left in this time.');
  assert.equal(first[4], 'Track record: no job scored yet; learned from 146 finished rows and 10 jobs.');
  assert.equal(first.length, 5);
  assert.equal(lines(finish({ record: { met: 1, of: 1 } }))[4], 'Track record: 1 of the last 1 job was done by the first time given.');
});

test('Check lines: at most 3 stale rows, longest first, then the rest counted; untracked work last', () => {
  const stale = [190, 400, 250, 300].map((elapsedMin, k) => ({ ...STALE, id: `b${k}`, elapsedMin })).sort((a, b) => b.elapsedMin - a.elapsedMin);
  const checks = lines(finish({ checks: [...stale, { kind: 'untracked', minutes: 45 }] })).slice(5);
  assert.deepEqual(checks.map((line) => line.slice(0, 22)), ['Check: row b1 (M) has ', 'Check: row b3 (M) has ', 'Check: row b2 (M) has ', 'Check: and 1 more.', 'Check: 45 min of work ']);
  assert.equal(checks[4], 'Check: 45 min of work in this job ran with no started row: start rows with status.mjs start <id>.');
});

test('all done and handed over', () => {
  assert.equal(formatEstimate({ state: 'all-done', nowMs: NOW, rows: 12 }, INPUTS), 'Finish: now (all 12 rows are done; the hand-over is recorded when this turn ends)');
  assert.equal(formatEstimate({ state: 'all-done', nowMs: NOW, rows: 1 }, INPUTS), 'Finish: now (all 1 row is done; the hand-over is recorded when this turn ends)');
  const handedOver = { state: 'handed-over', nowMs: NOW, handedOverMs: at(14, 24), rows: 12, workedMin: 185, record: null, pool: { rows: 146, jobs: 10 } };
  assert.equal(formatEstimate(handedOver, INPUTS), 'Finish: handed over Mon 16 Nov 17:54 (12 rows, 3 h 05 of work)\nTrack record: no job scored yet; learned from 146 finished rows and 10 jobs.');
});

test('refusals: No finish time and What to do of design 4.2, never a clock time; Check lines follow', () => {
  const refused = (refusal, checks = []) => formatRefusal({ state: 'refused', nowMs: NOW, refusal, checks });
  assert.equal(refused({ reason: 'no-rows' }), 'No finish time: the table has no work row.\nWhat to do: list the job\'s rows with `status.mjs add`.');
  assert.equal(refused({ reason: 'no-reference', size: 'L', rows: 4, needed: 5 }), 'No finish time: only 4 finished L rows to learn from (5 needed).\nWhat to do: finish rows of that size first, or split the L rows into M rows.');
  assert.equal(refused({ reason: 'no-reference', size: 'S', rows: 0, needed: 5 }), 'No finish time: only 0 finished S rows to learn from (5 needed).\nWhat to do: finish rows of that size first.');
  assert.equal(refused({ reason: 'growth', growth: 0.78 }), 'No finish time: in the recent jobs 78% of the work was not in the table when it was estimated.\nWhat to do: list the job\'s rows first (`status.mjs add`), then `status.mjs start` each as its work begins.');
  assert.equal(refused({ reason: 'horizon', longestJobMin: 355, work: { p50: 5400, p85: 5940, p95: 6300 } }, [STALE]), [
    'No finish time: this job is longer than any finished one (longest: 5 h 55 of work).',
    'Work left: likely 90 h, 85% sure within 99 h, of work (not clock time).',
    'What to do: quote the work left as hours of work; hand over in parts (`status.mjs deliver "<part>"`) so jobs of this length get scored.',
    'Check: row b12 (M) has taken 3 h 10 of work, longer than every finished M row (2 h 19): finish it, or close it with evidence "dropped: <why>".',
  ].join('\n'));
});

test('work and hours text: minutes under an hour, h mm above, whole hours from 10 h', () => {
  assert.deepEqual([0, 35, 59.4, 59.6, 185, 599].map(workText), ['0 min', '35 min', '59 min', '1 h 00', '3 h 05', '9 h 59']);
  assert.deepEqual([599, 600, 5940].map(hoursText), ['9 h 59', '10 h', '99 h']);
});

test('local clock: the zone is honoured, times round up to the 5-minute grid, a time on the grid stays', () => {
  assert.equal(clockText(at(15, 35), 'UTC'), '15:35');
  assert.equal(clockText(at(15, 35), TZ), '19:05');
  assert.equal(offsetText(NOW, TZ), '+03:30');
  assert.equal(offsetText(NOW, 'America/New_York'), '-05:00');
  assert.equal(dayText(at(20, 31), TZ), 'Tue 17 Nov');
  assert.equal(gridded(at(18, 6), TZ, true), at(18, 10));
  assert.equal(gridded(at(18, 10), TZ, true), at(18, 10));
  assert.equal(gridded(at(18, 9), TZ, false), at(18, 5));
  assert.equal(gridded(Date.UTC(2026, 10, 16, 5, 32), 'Asia/Kathmandu', true), Date.UTC(2026, 10, 16, 5, 35)); // +05:45: the grid is local
});
