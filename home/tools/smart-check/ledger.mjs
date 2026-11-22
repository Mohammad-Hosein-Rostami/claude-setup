// Purpose: the smart check's evidence ledger (spec r9-smart-check 6-7): one JSON line per check run, later truth rows that label it,
//   the queue of skipped checks for a background run, and the stats (miss rate with its 95% upper bound) that `smart-check stats`
//   and doctor print.
// Usage: node ledger.mjs stats [--json] [--doctor]
//        node ledger.mjs truth --change <id> --check <kind> --truth catch|false-alarm|escape|pass [--level <l>] [--source <s>] [--defect <row>]
//        node ledger.mjs defect --row <status-row-id> (--change <id> | --path <repo-relative file>) [--check <kind>] [--level <l>]
//                    (an owner defect from `status.mjs defect`: an escape of that change; no --check counts in the overall rate only)
//        node ledger.mjs train            (the weekly retrain of lib/model.mjs; the lead or doctor runs it)
// Exports: stateDir(), ledgerPath(), appendRows(rows), readRows(), queueSkipped(items), readQueue(), takeQueue(), stats(rows),
//   recentCatches(rows, nowMs), LEDGER_MAX_BYTES.
// Files: <state>/ledger.jsonl, <state>/queue.jsonl, <state>/model.json; <state> = $SMART_CHECK_STATE or ~/.claude/state/smart-check.
// Invariants: append-only, one write per call, so concurrent sessions never interleave a line; never throws to a caller (a write that
//   fails returns false); a line that is not JSON is skipped. The ledger holds paths, kinds and counts, never a line of code or a secret.
//   Writer and reader share LEDGER_MAX_BYTES: at the cap the ledger takes no more rows and stats says so.
import { mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appendPlainFile, readPlainFile } from '../../hooks/lib/plain-file.mjs';
import { removeStateFile } from '../../hooks/lib/state-files.mjs';

export const LEDGER_MAX_BYTES = 32 * 1024 * 1024; // about 100k rows: years of this setup's volume
const QUEUE_MAX_BYTES = 256 * 1024;
const QUEUE_MAX_ITEMS = 50; // older skipped checks are dropped first: their tree is likely gone anyway
const DAY_MS = 86_400_000;
const CATCH_WINDOW_DAYS = 90;
const Z95 = 1.96;
const TRUTHS = ['catch', 'false-alarm', 'escape', 'pass'];

export const stateDir = () => process.env.SMART_CHECK_STATE || join(homedir(), '.claude', 'state', 'smart-check');
export const ledgerPath = () => join(stateDir(), 'ledger.jsonl');
const queuePath = () => join(stateDir(), 'queue.jsonl');

/** Appends rows as JSON lines in one write; false when nothing was written (at the cap, or the folder cannot be made). */
function appendLines(path, rows, maxBytes) {
  try {
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    return appendPlainFile(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(''), { maxBytes });
  } catch {
    return false;
  }
}

/** Reads JSON lines; [] when the file is missing or unreadable. */
function readLines(path, maxBytes) {
  try {
    return readPlainFile(path, maxBytes).split('\n').flatMap((line) => {
      try { return line ? [JSON.parse(line)] : []; } catch { return []; }
    });
  } catch {
    return [];
  }
}

/** Appends ledger rows (each gets `ts` when it has none). @returns {boolean} */
export const appendRows = (rows) => appendLines(ledgerPath(), rows.map((row) => ({ ts: new Date().toISOString(), ...row })), LEDGER_MAX_BYTES);
/** Every ledger row. */
export const readRows = () => readLines(ledgerPath(), LEDGER_MAX_BYTES);
/** The queued skipped checks. */
export const readQueue = () => readLines(queuePath(), QUEUE_MAX_BYTES);

/** Queues skipped checks for a background run (keeps the newest QUEUE_MAX_ITEMS). @returns {boolean} */
export function queueSkipped(items) {
  if (items.length === 0) return true;
  const kept = [...readQueue(), ...items].slice(-QUEUE_MAX_ITEMS);
  removeStateFile(stateDir(), 'queue.jsonl');
  return appendLines(queuePath(), kept, QUEUE_MAX_BYTES);
}

/** Takes every queued item and empties the queue. */
export function takeQueue() {
  const items = readQueue();
  removeStateFile(stateDir(), 'queue.jsonl');
  return items;
}

/** Wilson score upper bound of a rate at 95% (x events in n trials); 1 for n = 0. */
const upperBound = (x, n) => {
  if (n === 0) return 1;
  const p = x / n;
  const z2 = Z95 * Z95;
  return Math.min(1, (p + z2 / (2 * n) + Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n));
};

/** Paths with a true catch in the last 90 days (round 2, 8.3 review "full": a past catch in a touched file). */
export function recentCatches(rows, nowMs = Date.now()) {
  const since = nowMs - CATCH_WINDOW_DAYS * DAY_MS;
  const caught = new Set(rows.filter((row) => (row.result === 'catch' || row.truth === 'catch' || row.truth === 'escape') && Date.parse(row.ts) >= since).map((row) => row.change));
  return new Set(rows.filter((row) => row.type === 'run' && caught.has(row.change)).flatMap((row) => row.paths ?? []));
}

/**
 * Miss rate per check kind and overall: escapes / changes that had a defect (a catch or an escape), with a 95% upper bound.
 * @param {object[]} rows the ledger
 * @returns {{changes: number, runs: number, labelled: number, perKind: Object<string, {runs: number, catches: number, falseAlarms: number,
 *   escapes: number, missRate: number, upper: number, seconds: number, tokens: number}>, overall: {defects: number, escapes: number,
 *   missRate: number, upper: number}}}
 */
export function stats(rows) {
  const runs = rows.filter((row) => row.type === 'run');
  const truths = rows.filter((row) => row.type === 'truth' && TRUTHS.includes(row.truth));
  const perKind = {};
  for (const row of runs) {
    const kind = (perKind[row.check] ??= { runs: 0, catches: 0, falseAlarms: 0, escapes: 0, seconds: 0, tokens: 0 });
    kind.runs += 1;
    kind.catches += row.result === 'catch' ? 1 : 0;
    kind.seconds += Number(row.seconds) || 0;
    kind.tokens += Number(row.tokens) || 0;
  }
  for (const row of truths) {
    const kind = (perKind[row.check] ??= { runs: 0, catches: 0, falseAlarms: 0, escapes: 0, seconds: 0, tokens: 0 });
    kind.labelled = (kind.labelled ?? 0) + 1;
    if (row.truth === 'escape') kind.escapes += 1;
    if (row.truth === 'false-alarm') kind.falseAlarms += 1;
    if (row.truth === 'catch') kind.catches += 1;
  }
  for (const kind of Object.values(perKind)) {
    const defects = kind.catches + kind.escapes;
    Object.assign(kind, { missRate: defects ? kind.escapes / defects : 0, upper: upperBound(kind.escapes, defects) });
  }
  const changeOf = (list) => new Set(list.map((row) => row.change));
  const escaped = changeOf(truths.filter((row) => row.truth === 'escape'));
  const defective = new Set([...escaped, ...changeOf([...truths, ...runs].filter((row) => row.result === 'catch' || row.truth === 'catch'))]);
  return {
    changes: changeOf(runs).size, runs: runs.length, labelled: changeOf(truths).size, perKind,
    overall: { defects: defective.size, escapes: escaped.size, missRate: defective.size ? escaped.size / defective.size : 0, upper: upperBound(escaped.size, defective.size) },
  };
}

const percent = (value) => `${(value * 100).toFixed(1)}%`;

/** The stats as text: one summary line (doctor) or a line per kind. */
function statsText(summary, doctorLine) {
  const head = `smart-check ledger: ${summary.runs} runs over ${summary.changes} changes, ${summary.labelled} labelled; miss rate ${percent(summary.overall.missRate)} (95% bound ${percent(summary.overall.upper)}, ${summary.overall.escapes} escapes in ${summary.overall.defects} defects; target <= 1%)`;
  if (doctorLine) return head;
  const lines = Object.entries(summary.perKind).map(([kind, k]) => `  ${kind.padEnd(8)} runs ${k.runs}, catches ${k.catches}, false alarms ${k.falseAlarms}, escapes ${k.escapes}, miss ${percent(k.missRate)} (bound ${percent(k.upper)}), ${Math.round(k.seconds)} s, ${k.tokens} tokens`);
  return [head, ...lines].join('\n');
}

/** The newest change whose run rows touched `path` (a repo-relative path), or undefined. */
function latestChangeOf(rows, path) {
  return rows.filter((row) => row.type === 'run' && (row.paths ?? []).includes(path)).at(-1)?.change;
}

/** Alarm lines: an escape of a pinned or security check means a rule review at once (round 2, 11.4). */
const alarms = (rows) => rows.filter((row) => row.type === 'truth' && row.truth === 'escape' && /^(pinned:|security)/.test(String(row.check)))
  .map((row) => `ALARM: escape of ${row.check} in change ${row.change}: review its rule now and add the cheapest proxy check`);

/** Reads `--name value` flags. */
const flagsOf = (args) => Object.fromEntries(args.flatMap((arg, i) => (arg.startsWith('--') ? [[arg.slice(2), args[i + 1]?.startsWith('--') ? true : (args[i + 1] ?? true)]] : [])));

/** The CLI. @returns {Promise<number>} the exit code: 0 ok, 1 not written, 2 usage */
async function main([command, ...args]) {
  const flags = flagsOf(args);
  if (command === 'stats') {
    const summary = stats(readRows());
    console.log(flags.json ? JSON.stringify(summary) : [statsText(summary, flags.doctor), ...alarms(readRows())].join('\n'));
    return 0;
  }
  if (command === 'truth' || command === 'defect') {
    const truth = command === 'defect' ? 'escape' : flags.truth;
    if (command === 'defect' && typeof flags.change !== 'string' && typeof flags.path === 'string') flags.change = latestChangeOf(readRows(), flags.path);
    if (command === 'defect' && typeof flags.check !== 'string') flags.check = 'unknown'; // counts in the overall miss rate only
    if (typeof flags.change !== 'string' || typeof flags.check !== 'string' || !TRUTHS.includes(truth)) {
      console.error('usage: ledger.mjs truth --change <id> --check <kind> --truth catch|false-alarm|escape|pass [--level <l>] [--source <s>] [--defect <row>]');
      return 2;
    }
    const row = { type: 'truth', change: flags.change, check: flags.check, level: flags.level ?? null, truth, source: command === 'defect' ? 'owner-defect' : (flags.source ?? 'owner'), defect: flags.row ?? flags.defect ?? null };
    return appendRows([row]) ? 0 : 1;
  }
  if (command === 'train') {
    const { trainModels } = await import('./lib/model.mjs');
    console.log(trainModels(readRows(), stateDir()));
    return 0;
  }
  console.error('usage: ledger.mjs stats [--json] [--doctor] | truth ... | defect --row <id> (--change <id> | --path <file>) [--check <kind>] | train');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
