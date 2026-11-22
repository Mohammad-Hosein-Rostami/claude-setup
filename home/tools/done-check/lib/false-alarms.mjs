// False-alarm labels that stick: once the owner labels a check of a run `false-alarm`, the same new failures do not block that change
// again (friction #6: an owner-approved test removal was blocked three stops in a row).
// Exports: alarmIdOf(failure) -> string, alarmIdsOf(failures) -> string[], storedAlarms(kind, check) -> { alarms? }, latestLabels(labels) -> Map,
//   labelledAlarmIds(ledger, { repo, base }) -> Map<kind, Set<id>>, passLabelled(summary, ids) -> summary.
// Invariants:
// - An alarm id is the first 16 hex characters of a sha256 of the failure's kind, id and text, so the ledger never holds a file name or
//   a message. The text is part of it: one more deleted case or one more skip in the same file is a new alarm and blocks again.
// - Only a label row written by `done-check.mjs label` (lib/ledger.mjs appendLabel) can let a failure through, and only through the alarm
//   ids its run row stored. A label row carries no ids, so neither a label note nor a failure text can widen what passes.
// - A label applies to runs of the same repository with the same base commit (the same lane at the same start); a run with no base
//   is never matched. The newest label of a (run, check) wins, so a later `real` takes a `false-alarm` back.
import { createHash } from 'node:crypto';
import { ALARM_ID_PATTERN, MAX_ALARM_IDS_PER_CHECK } from './contract.mjs';

const ALARM_ID_CHARS = 16;
const FALSE_ALARM = 'false-alarm';

/**
 * The stored id of one new failure.
 * @param {import('./contract.mjs').Failure} failure
 * @returns {string} 16 hex characters (contract ALARM_ID_PATTERN)
 */
export const alarmIdOf = (failure) => createHash('sha256').update(`${failure.kind}\n${failure.id}\n${failure.text}`).digest('hex').slice(0, ALARM_ID_CHARS);

/**
 * The ids a run row keeps for its new failures of one kind: unique, at most MAX_ALARM_IDS_PER_CHECK (the rest are not stored, so a
 * label cannot cover them and they keep blocking).
 * @param {import('./contract.mjs').Failure[]} failures the kind's new failures
 * @returns {string[]}
 */
export const alarmIdsOf = (failures) => [...new Set(failures.map(alarmIdOf))].slice(0, MAX_ALARM_IDS_PER_CHECK);

/**
 * The `alarms` field of a check entry the ledger stores: absent stays absent, else at most MAX_ALARM_IDS_PER_CHECK ids of
 * ALARM_ID_PATTERN, so a file name or a failure text never fits.
 * @param {string} kind the check kind (for the error text)
 * @param {{ alarms?: unknown }} check the caller's check entry
 * @returns {{ alarms?: string[] }} a copy, or {} when the entry has none
 * @throws {TypeError} the ids have a wrong shape (a bug in the caller, like any other wrong row field)
 */
export function storedAlarms(kind, check) {
  if (check.alarms === undefined) return {};
  const ok = Array.isArray(check.alarms) && check.alarms.length <= MAX_ALARM_IDS_PER_CHECK
    && check.alarms.every((id) => typeof id === 'string' && ALARM_ID_PATTERN.test(id));
  if (!ok) throw new TypeError(`ledger: check entry "${kind}": alarms must be at most ${MAX_ALARM_IDS_PER_CHECK} ids of 16 hex characters`);
  return { alarms: [...check.alarms] };
}

/**
 * The last label per (run, check): a later label replaces an earlier one, so the owner can change their mind.
 * @param {object[]} labels label rows as readLedger returned them
 * @returns {Map<string, object>} keyed `<run id>\u0000<check kind>`
 */
export function latestLabels(labels) {
  const latest = new Map();
  for (const label of [...labels].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) latest.set(`${label.run}\u0000${label.check}`, label);
  return latest;
}

/**
 * The alarm ids the owner called false alarms for this repository and base, per check kind.
 * @param {{ runs: object[], labels: object[] }} ledger what readLedger returned
 * @param {{ repo: string, base: string|null }} where the hashed repo id and the base commit of the run being judged
 * @returns {Map<string, Set<string>>} check kind -> alarm ids; empty for no base or no matching label
 */
export function labelledAlarmIds({ runs, labels }, { repo, base }) {
  const ids = new Map();
  if (typeof base !== 'string' || labels.length === 0) return ids;
  const labelOf = latestLabels(labels);
  for (const row of runs) {
    if (row.repo !== repo || row.base !== base) continue;
    for (const [kind, check] of Object.entries(row.checks)) {
      if (!Array.isArray(check.alarms) || labelOf.get(`${row.id}\u0000${kind}`)?.label !== FALSE_ALARM) continue;
      if (!ids.has(kind)) ids.set(kind, new Set());
      for (const id of check.alarms) ids.get(kind).add(id);
    }
  }
  return ids;
}

/**
 * One kind's summary with the labelled false alarms taken out of its new failures; a kind left with no new and no unknown failure
 * passes (`ok`). Old, unknown and flaky failures are not touched.
 * @param {import('./verdict-text.mjs').KindSummary} summary
 * @param {Map<string, Set<string>>} ids what labelledAlarmIds returned
 * @returns {import('./verdict-text.mjs').KindSummary & { labelled: number }} `labelled`: how many new failures a label let through
 */
export function passLabelled(summary, ids) {
  const known = ids.get(summary.kind);
  if (!known || summary.fresh.length === 0) return { ...summary, labelled: 0 };
  const fresh = summary.fresh.filter((failure) => !known.has(alarmIdOf(failure)));
  const labelled = summary.fresh.length - fresh.length;
  const result = summary.result === 'fail' && fresh.length === 0 && (summary.unknown?.length ?? 0) === 0 ? 'ok' : summary.result;
  return { ...summary, fresh, labelled, result };
}
