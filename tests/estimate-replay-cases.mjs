// Replay fixtures for the finish estimate: two real work items tables of 14-15 Nov 2026 (an auth UI job and a restructure
// job), copied as ids, sizes and times only; the item text is neutral and only carries the kind prefix the L30 rule would
// have given (close: review, fixes, recheck, gate, landing, report; rework: an owner correction).
// Exports: TABLES (rows per table, with the time each row was written), CASES (the moments the owner asked, with the exact
// Finish line of the L30 spec and the true finish), statusAt(table, nowMs) -> STATUS.md text as it stood at that moment.
// Invariant: at a moment, rows written later are left out and later started/done cells are blank, as the session saw it.

const CLOSE_AUTH = ['F1', 'F3', 'F4', 'F5', 'F6', 'F14', 'F15', 'F16', 'F17', 'F18', 'F19', 'F20', 'F21', 'F22', 'F23', 'F24', 'F25', 'F26', 'G3', 'G4', 'G5', 'G6', 'H3', 'H5'];
const REWORK_AUTH = ['H1', 'H2', 'H4', 'H6', 'H7', 'H8', 'H9', 'H10'];
const CLOSE_RESTRUCTURE = ['W15', 'F4', 'F5', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6'];
const FIRST_AUTH_ROWS = 19; // F1-F19 were written together
const AUTH_WRITTEN = {
  F20: '2026-11-14T20:32:18Z', F21: '2026-11-14T20:55:32Z', F22: '2026-11-14T20:55:32Z', F23: '2026-11-14T21:23:11Z',
  F24: '2026-11-14T21:23:11Z', F25: '2026-11-14T21:37:16Z', F26: '2026-11-14T22:10:08Z',
  // H4-H10 (the 15 Nov follow-up round): when each row was written is not known, taken as its start; H5 as its predecessor's start
  H4: '2026-11-15T11:46:00Z', H5: '2026-11-15T11:46:00Z', H6: '2026-11-15T11:47:00Z', H7: '2026-11-15T11:52:00Z', H8: '2026-11-15T11:53:00Z',
  H9: '2026-11-15T13:00:00Z', H10: '2026-11-15T13:55:00Z',
};

// [id, size, started, done]; '-' = empty. Times from the two STATUS.md tables (read-only), UTC.
const AUTH_ROWS = [
  ['F1', 'M', '2026-11-14T18:16Z', '2026-11-14T18:38Z'], ['F2', 'M', '2026-11-14T18:18Z', '2026-11-14T18:44Z'],
  ['F3', 'M', '2026-11-14T18:39Z', '2026-11-14T19:09Z'], ['F4', 'M', '2026-11-14T18:45Z', '2026-11-14T19:02Z'],
  ['F5', 'M', '2026-11-14T18:45Z', '2026-11-14T19:12Z'], ['F6', 'M', '2026-11-14T18:46Z', '2026-11-14T19:01Z'],
  ['F7', 'S', '2026-11-14T18:46Z', '2026-11-14T18:50Z'], ['F8', 'M', '2026-11-14T18:53Z', '2026-11-14T19:20Z'],
  ['F9', 'M', '2026-11-14T19:01Z', '2026-11-14T19:14Z'], ['F10', 'M', '2026-11-14T19:03Z', '2026-11-14T19:24Z'],
  ['F11', 'M', '2026-11-14T19:24Z', '2026-11-14T19:52Z'], ['F12', 'S', '2026-11-14T19:21Z', '2026-11-14T19:50Z'],
  ['F13', 'L', '2026-11-14T19:30Z', '2026-11-14T20:06Z'], ['F14', 'M', '2026-11-14T20:06Z', '2026-11-14T21:23Z'],
  ['F15', 'M', '2026-11-14T19:52Z', '2026-11-14T20:13Z'], ['F16', 'M', '2026-11-14T20:13Z', '2026-11-14T20:32Z'],
  ['F17', 'S', '2026-11-14T20:06Z', '2026-11-14T20:08Z'], ['F18', 'M', '2026-11-14T20:56Z', '2026-11-14T22:30Z'],
  ['F19', 'S', '2026-11-14T22:20Z', '2026-11-14T22:30Z'], ['F20', 'M', '2026-11-14T20:32Z', '2026-11-14T20:55Z'],
  ['F21', 'M', '2026-11-14T20:55Z', '2026-11-14T21:25Z'], ['F22', 'M', '2026-11-14T20:55Z', '2026-11-14T21:23Z'],
  ['F23', 'M', '2026-11-14T21:23Z', '2026-11-14T21:26Z'], ['F24', 'S', '2026-11-14T21:23Z', '2026-11-14T21:37Z'],
  ['F25', 'M', '2026-11-14T21:37Z', '2026-11-14T22:10Z'], ['F26', 'M', '2026-11-14T22:10Z', '2026-11-14T22:30Z'],
  ['G1', 'S', '2026-11-15T06:20Z', '2026-11-15T06:39Z'], ['G2', 'M', '2026-11-15T06:22Z', '2026-11-15T06:41Z'],
  ['G3', 'L', '2026-11-15T06:39Z', '2026-11-15T08:10Z'], ['G4', 'M', '2026-11-15T07:25Z', '2026-11-15T08:02Z'],
  ['G5', 'S', '2026-11-15T08:02Z', '2026-11-15T08:10Z'], ['G6', 'S', '2026-11-15T08:05Z', '2026-11-15T08:10Z'],
  ['H1', 'M', '2026-11-15T08:29Z', '2026-11-15T09:18Z'], ['H2', 'L', '2026-11-15T09:18Z', '2026-11-15T10:43Z'],
  ['H3', 'M', '2026-11-15T10:43Z', '2026-11-15T11:46Z'],
  ['H4', 'M', '2026-11-15T11:46Z', '2026-11-15T13:36Z'], ['H5', 'M', '2026-11-15T13:36Z', '2026-11-15T14:24Z'],
  ['H6', 'M', '2026-11-15T11:47Z', '2026-11-15T13:05Z'], ['H7', 'M', '2026-11-15T11:52Z', '2026-11-15T12:17Z'],
  ['H8', 'M', '2026-11-15T11:53Z', '2026-11-15T12:29Z'], ['H9', 'M', '2026-11-15T13:00Z', '2026-11-15T13:36Z'],
  ['H10', 'S', '2026-11-15T13:55Z', '2026-11-15T14:24Z'],
];
const RESTRUCTURE_ROWS = [
  ['W1', 'S', '2026-11-15T06:00Z', '2026-11-15T06:20Z'], ['W2', 'S', '2026-11-15T06:06Z', '2026-11-15T06:11Z'],
  ['W3', 'M', '2026-11-15T06:05Z', '2026-11-15T06:08Z'], ['W4', 'M', '2026-11-15T06:06Z', '2026-11-15T06:08Z'],
  ['W5', 'M', '2026-11-15T06:06Z', '2026-11-15T06:09Z'], ['W6', 'M', '2026-11-15T06:06Z', '2026-11-15T06:14Z'],
  ['W7', 'S', '2026-11-15T06:06Z', '2026-11-15T06:08Z'], ['W8', 'L', '2026-11-15T06:20Z', '2026-11-15T07:59Z'],
  ['W8b', 'M', '2026-11-15T07:34Z', '2026-11-15T07:57Z'], ['W9', 'M', '2026-11-15T07:34Z', '2026-11-15T07:55Z'],
  ['W10', 'S', '2026-11-15T06:20Z', '2026-11-15T08:29Z'], ['W11', 'M', '2026-11-15T06:20Z', '2026-11-15T06:33Z'],
  ['W12', 'M', '2026-11-15T07:34Z', '2026-11-15T08:16Z'], ['W13', 'S', '2026-11-15T08:16Z', '2026-11-15T08:23Z'],
  ['W14', 'M', '2026-11-15T06:54Z', '2026-11-15T08:29Z'], ['W15', 'M', '2026-11-15T08:30Z', '2026-11-15T10:55Z'],
  ['F4', 'M', '2026-11-15T10:24Z', '2026-11-15T10:28Z'], ['F5', 'S', '2026-11-15T10:45Z', '2026-11-15T10:50Z'],
  // The follow-up round after the 10:55Z delivery (fixes after a verification), delivered 11:54Z.
  ['V1', 'S', '2026-11-15T11:25Z', '2026-11-15T11:27Z'], ['V2', 'S', '2026-11-15T11:25Z', '2026-11-15T11:37Z'],
  ['V3', 'S', '2026-11-15T11:27Z', '2026-11-15T11:33Z'], ['V4', 'S', '2026-11-15T11:28Z', '2026-11-15T11:29Z'],
  ['V5', 'S', '2026-11-15T11:37Z', '2026-11-15T11:54Z'], ['V6', 'S', '2026-11-15T11:45Z', '2026-11-15T11:53Z'],
];
// When the V rows were written is not known: taken as the round's first start (an approximation; the table copy at 11:39Z
// showed six open rows, here V1, V3 and V4 carry the done times recorded later).
const V_WRITTEN = '2026-11-15T11:25:00Z';

function authWritten(id, index) {
  if (Object.hasOwn(AUTH_WRITTEN, id)) return AUTH_WRITTEN[id];
  if (index < FIRST_AUTH_ROWS) return '2026-11-14T19:47:03Z';
  if (id.startsWith('G')) return '2026-11-15T06:39:38Z';
  if (id.startsWith('H')) return '2026-11-15T08:29:06Z';
  return AUTH_WRITTEN[id];
}

function restructureWritten(id, started) {
  if (id === 'W8b') return '2026-11-15T08:00:04Z';
  if (id.startsWith('V')) return V_WRITTEN;
  return id.startsWith('F') ? started : '2026-11-15T06:04:31Z';
}

const kindText = (id, close, rework) => (close.includes(id) ? 'close: row' : rework.includes(id) ? 'rework: row' : 'row');
const toRow = ([id, size, started, done], written, item) => ({ id, size, started, done, item, written: Date.parse(written) });

export const TABLES = {
  auth: AUTH_ROWS.map((cells, i) => toRow(cells, authWritten(cells[0], i), kindText(cells[0], CLOSE_AUTH, REWORK_AUTH))),
  restructure: RESTRUCTURE_ROWS.map((cells) => toRow(cells, restructureWritten(cells[0], cells[2]), kindText(cells[0], CLOSE_RESTRUCTURE, []))),
};

const AUTH_DONE_14 = '2026-11-14T22:30Z';
const AUTH_DONE_15 = '2026-11-15T08:10Z';
const RESTRUCTURE_DONE = '2026-11-15T10:55Z';
const RESTRUCTURE_ROUND_DONE = '2026-11-15T11:54Z';
const AUTH_ROUND_DONE = '2026-11-15T14:24Z';
/**
 * The owner's estimate requests; `finish` is the line the L30 spec's replay table gives, `truth` when the job was delivered.
 * A0 and A1 sit in the follow-up round after the 14 Nov 22:30Z delivery, so the follow-up round rule changed their lines (was
 * 11:30-12:50 and 11:35-12:45; real finish 11:40). V9 is the live 15:09 request in the round after the 10:55Z delivery
 * (real finish 15:24); its own 0.48 h round is one of the three behind the default round range. R3 printed 13:30 before
 * the low end was kept at or after now (13:31). V10 is the live 16:54 request in the auth round after the 08:10Z delivery (the round
 * had run 4.9 h, past its 0.4-2.6 h range; three rows open, two running): it prints `not before`, no upper end, and the job
 * was really done at 17:54 local (14:24Z). The old rule printed 17:10-17:35 there.
 */
export const CASES = [
  { name: 'E7', table: 'auth', now: '2026-11-14T19:47:03Z', truth: AUTH_DONE_14, finish: 'Finish: Sun 15 Nov 00:50-02:25 (local +03:30, now 23:17)' },
  { name: 'E8', table: 'auth', now: '2026-11-14T21:26:37Z', truth: AUTH_DONE_14, finish: 'Finish: Sun 15 Nov 01:00-02:10 (local +03:30, now 00:56)' },
  { name: 'A0', table: 'auth', now: '2026-11-15T06:39:43Z', truth: AUTH_DONE_15, finish: 'Finish: Sun 15 Nov 10:40-12:30 (local +03:30, now 10:09)' },
  { name: 'A1', table: 'auth', now: '2026-11-15T08:02:39Z', truth: AUTH_DONE_15, finish: 'Finish: Sun 15 Nov 11:40-12:30 (local +03:30, now 11:32)', after: 'After your review: 0 of 1 earlier deliveries here were reopened by your corrections' },
  { name: 'R1', table: 'restructure', now: '2026-11-15T07:48:03Z', truth: RESTRUCTURE_DONE, finish: 'Finish: Sun 15 Nov 12:40-14:35 (local +03:30, now 11:18)' },
  { name: 'R2', table: 'restructure', now: '2026-11-15T08:00:05Z', truth: RESTRUCTURE_DONE, finish: 'Finish: Sun 15 Nov 12:55-14:25 (local +03:30, now 11:30)' },
  { name: 'R4', table: 'restructure', now: '2026-11-15T08:30:30Z', truth: RESTRUCTURE_DONE, finish: 'Finish: Sun 15 Nov 13:20-14:30 (local +03:30, now 12:00)' },
  { name: 'R3', table: 'restructure', now: '2026-11-15T10:01:35Z', truth: RESTRUCTURE_DONE, finish: 'Finish: Sun 15 Nov 13:35-14:30 (local +03:30, now 13:31)' },
  { name: 'V9', table: 'restructure', now: '2026-11-15T11:39:00Z', truth: RESTRUCTURE_ROUND_DONE, finish: 'Finish: Sun 15 Nov 15:15-17:35 (local +03:30, now 15:09)' },
  { name: 'V10', table: 'auth', now: '2026-11-15T13:24:00Z', truth: AUTH_ROUND_DONE, finish: 'Finish: not before Sun 15 Nov 17:10 (local +03:30, now 16:54)' },
];

const cell = (time, nowMs) => (time !== '-' && Date.parse(time) <= nowMs ? time : '-');

/** The STATUS.md of a table as it stood at nowMs (epoch ms). */
export function statusAt(table, nowMs) {
  const rows = TABLES[table].filter((r) => r.written <= nowMs).map((r) => {
    const done = cell(r.done, nowMs);
    return `| ${r.id} | ${r.item} | ${r.size} | ${cell(r.started, nowMs)} | ${done} | ${done === '-' ? '-' : 'abc1234'} |`;
  });
  const head = ['# Status', '', '## Work items', '', '| id | item | size | started | done | evidence |', '| -- | ---- | ---- | ------- | ---- | -------- |'];
  return `${[...head, ...rows].join('\n')}\n`;
}
