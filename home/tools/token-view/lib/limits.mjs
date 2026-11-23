// Part (a) of the token view: the usage limits against time, per account, from the 7-day limit logs the status line writes
// (`~/.claude/state/limits/<account>.jsonl`, one sample per line: { t, five_hour, seven_day }, each window
// { used_percentage, resets_at }; format owned by home/tools/estimate/lib/limits-store.mjs).
// Exports: readLimitLogs(dir, sinceMs) -> [{ account, samples, days }].
// Invariants: read-only; a missing folder gives []; a line that is not a sample is skipped; a gap is shown as a gap (a day with
// no sample has no row), never filled. A log is read through hooks/lib/plain-file.mjs within MAX_LOG_BYTES, the cap its writer
// keeps (one cap in bytes for writer and reader): a log over it, a link, a FIFO or a folder at a log's name is not read (one
// stderr line), so a planted or foreign file is never followed nor read in full.
import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readPlainFile } from '../../../hooks/lib/plain-file.mjs';
import { MAX_LOG_BYTES } from '../../estimate/lib/limits-store.mjs';

const LOG_SUFFIX = '.jsonl';

/** @returns {number|null} the epoch ms of a sample's time (`t` in ms or an ISO string), or null when unreadable. */
const timeOf = (sample) => (typeof sample?.t === 'number' ? sample.t : Date.parse(sample?.t ?? '') || null);
const percent = (window) => (typeof window?.used_percentage === 'number' ? window.used_percentage : null);

/** The samples of one log at or after `sinceMs`, oldest first. */
function samplesOf(file, sinceMs) {
  let text = '';
  try {
    text = readPlainFile(file, MAX_LOG_BYTES);
  } catch (error) {
    process.stderr.write(`token-view: cannot read ${file}: ${error.message}\n`);
    return [];
  }
  const samples = [];
  for (const line of text.split('\n')) {
    try {
      const sample = JSON.parse(line);
      const t = timeOf(sample);
      if (t !== null && t >= sinceMs) samples.push({ t, fiveHour: percent(sample.five_hour), sevenDay: percent(sample.seven_day) });
    } catch {
      // an empty or partly written line is not a sample
    }
  }
  return samples.sort((a, b) => a.t - b.t);
}

/** Per UTC day: the highest 7-day and 5-hour use seen that day. */
function daysOf(samples) {
  const days = new Map();
  for (const sample of samples) {
    const day = new Date(sample.t).toISOString().slice(0, 10);
    const row = days.get(day) ?? { day, sevenDayMax: null, fiveHourMax: null };
    if (sample.sevenDay !== null) row.sevenDayMax = Math.max(row.sevenDayMax ?? 0, sample.sevenDay);
    if (sample.fiveHour !== null) row.fiveHourMax = Math.max(row.fiveHourMax ?? 0, sample.fiveHour);
    days.set(day, row);
  }
  return [...days.values()];
}

/**
 * The limit logs of every account.
 * @param {string} dir - the limits folder (`~/.claude/state/limits`, or a fixture folder).
 * @param {number} sinceMs - epoch ms; older samples are left out.
 * @returns {{account: string, samples: object[], days: object[]}[]} one entry per account log, accounts in name order.
 */
export function readLimitLogs(dir, sinceMs) {
  let names = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(LOG_SUFFIX)).sort();
  } catch {
    return [];
  }
  return names.map((name) => {
    const samples = samplesOf(join(dir, name), sinceMs);
    return { account: basename(name, LOG_SUFFIX), samples, days: daysOf(samples) };
  });
}
