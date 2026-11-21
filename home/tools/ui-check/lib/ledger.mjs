// Purpose: the round ledger of `ui-check batch` and `run`: per compare state the sha256 of the capture, the leftover pixel count and
// the failing element rows, and two comparisons: with the previous round (`--prev`: change, `no-gain`, `PLATEAU` after 2 no-gain
// rounds) and with the lane's reference run (`--no-worse`: identical / equal / better / worse / new / missing; any worse or missing
// state fails). Exports: LEDGER_FILE, COMPARATOR, buildLedger, writeLedger, readLedger, compareRounds, compareReference,
// formatRounds, formatReference.
// Invariants: a reference made with another comparator (name, version, options) or another renderer (platform, Chromium version,
// pixel ratio) is never compared: the result fails closed with the different-comparator or different-renderer line, and a new
// reference is taken on the base tip, never on the lane tip. Diagnostic records never enter a ledger. Pure apart from the file I/O
// of writeLedger / readLedger / the sha256 of each capture.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError } from './errors.mjs';
import { PIXEL } from './tolerances.mjs';

export const LEDGER_FILE = 'ledger.json';
const PLATEAU_ROUNDS = 2; // two failing rounds in a row without a gain = plateau (standards/figma.md, figma-pixel-perfect step 5)
const ODIFF_PACKAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'odiff-bin', 'package.json');

/** The installed odiff version; a missing package is a setup error (the pixel gate cannot run without it either). */
function odiffVersion() {
  try {
    return JSON.parse(fs.readFileSync(ODIFF_PACKAGE, 'utf8')).version;
  } catch (error) {
    throw new UsageError(`cannot read the odiff-bin version (${error.message}); run npm ci in the ui-check folder`);
  }
}

/** The comparator id every record and ledger carries: odiff, its version and the exact options lib/pixels.mjs passes. */
export const COMPARATOR = Object.freeze({ name: 'odiff', version: odiffVersion(), options: Object.freeze({ threshold: PIXEL.threshold, antialiasing: true }) });

const keyOf = (r) => `${r.surface} / ${r.state} / ${r.locale ?? 'default'} @${r.width}`;
const sha256Of = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** One ledger row for a compare record that has a capture; null for any other record. */
function stateRow(r) {
  if (r.part !== 'compare' || r.diagnostic || !r.images?.actual || !fs.existsSync(r.images.actual)) return null;
  const rows = r.findings.filter((f) => f.check === 'element').length;
  return { key: keyOf(r), surface: r.surface, state: r.state, locale: r.locale, width: r.width, scale: r.scale ?? null, sha256: sha256Of(r.images.actual), pixels: r.diffPixels ?? 0, drift: r.driftPixels ?? 0, rows, status: r.status };
}

/**
 * Build the ledger of one round from its batch records.
 * @param {object[]} records batch records (compare records carry images.actual, diffPixels and scale)
 * @param {{renderer: object, step?: string|null, rule?: string, conditions?: object|null, head?: string|null}} meta run facts stored beside the rows
 * @returns {object} { comparator, renderer, step, rule, conditions, head, createdAt, states: [...] }
 */
export function buildLedger(records, { renderer, step = null, rule = 'default', conditions = null, head = null }) {
  const states = records.map(stateRow).filter(Boolean);
  return { comparator: COMPARATOR, renderer, step, rule, conditions, head, createdAt: new Date().toISOString(), states };
}

/** Write <outDir>/ledger.json. @returns {string} its path */
export function writeLedger(outDir, ledger) {
  const file = path.join(outDir, LEDGER_FILE);
  fs.writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`);
  return file;
}

/**
 * Read the ledger of an earlier run.
 * @param {string} where a run folder (holding ledger.json) or the ledger file itself
 * @param {string} flag the flag it came from, for the error message
 * @throws {UsageError} when it is missing, unreadable or has no states list
 */
export function readLedger(where, flag) {
  const file = fs.existsSync(where) && fs.statSync(where).isDirectory() ? path.join(where, LEDGER_FILE) : where;
  let ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new UsageError(`--${flag} ${where}: cannot read ${file}: ${error.message}`);
  }
  if (!Array.isArray(ledger?.states)) throw new UsageError(`--${flag} ${where}: ${file} is not a ui-check ledger (no states list)`);
  return ledger;
}

/** Was the round better than the one before: fewer odiff pixels, colour-metric pixels or rows, and none went up. */
const COUNTS = ['pixels', 'drift', 'rows'];
const gained = (now, before) => COUNTS.some((k) => (now[k] ?? 0) < (before[k] ?? 0)) && COUNTS.every((k) => (now[k] ?? 0) <= (before[k] ?? 0));

/**
 * Compare a round with the previous one and annotate its rows (mutates `current.states`: `noGainRounds`, so the next round can see the streak).
 * @param {object} current this round's ledger
 * @param {object} prev the previous round's ledger
 * @returns {{key: string, verdict: string, pixelDelta: number|null, rowDelta: number|null, plateau: boolean}[]} verdict: new, identical, gain, no-gain, pass
 */
export function compareRounds(current, prev) {
  const before = new Map(prev.states.map((row) => [row.key, row]));
  return current.states.map((row) => {
    const old = before.get(row.key);
    if (!old) return { key: row.key, verdict: 'new', pixelDelta: null, rowDelta: null, plateau: false };
    const failing = row.status === 'fail';
    const noGain = failing && !gained(row, old);
    row.noGainRounds = noGain ? (old.noGainRounds ?? 0) + 1 : 0;
    const verdict = row.sha256 === old.sha256 ? 'identical' : failing ? (noGain ? 'no-gain' : 'gain') : 'pass';
    return { key: row.key, verdict: noGain && verdict === 'identical' ? 'identical, no-gain' : verdict, pixelDelta: row.pixels - old.pixels, rowDelta: row.rows - old.rows, plateau: row.noGainRounds >= PLATEAU_ROUNDS };
  });
}

/** The line that says why two ledgers cannot be compared, or null when they can. */
function mismatchLine(current, reference) {
  if (JSON.stringify(current.comparator) !== JSON.stringify(reference.comparator)) {
    return `different comparator: reference ${JSON.stringify(reference.comparator ?? null)}, this run ${JSON.stringify(current.comparator)}; take a new reference on the base tip (never on the lane tip)`;
  }
  const a = current.renderer ?? {};
  const b = reference.renderer ?? {};
  if (a.platform !== b.platform || a.chromium !== b.chromium) {
    return `different renderer: reference ${b.platform ?? '?'} Chromium ${b.chromium ?? '?'}, this run ${a.platform} Chromium ${a.chromium}; take a new reference on the base tip (never on the lane tip)`;
  }
  return null;
}

function referenceVerdict(row, ref) {
  if (!ref) return 'new';
  if (ref.scale !== row.scale) return 'different-pixel-ratio';
  if (row.sha256 === ref.sha256) return 'identical';
  if (COUNTS.some((k) => (row[k] ?? 0) > (ref[k] ?? 0))) return 'worse';
  if (COUNTS.some((k) => (row[k] ?? 0) < (ref[k] ?? 0))) return 'better';
  return 'equal';
}

/**
 * Compare a round with the lane's reference run ("0 worse").
 * @param {object} current this round's ledger
 * @param {object} reference the reference ledger (a run on the base tip at lane start)
 * @returns {{ok: boolean, mismatch: string|null, rows: {key: string, verdict: string, pixels: number|null, refPixels: number|null}[]}}
 *   ok is false when the ledgers cannot be compared, a state is worse, its pixel ratio differs, or a reference state is missing from this run
 */
export function compareReference(current, reference) {
  const mismatch = mismatchLine(current, reference);
  if (mismatch) return { ok: false, mismatch, rows: [] };
  const refs = new Map(reference.states.map((row) => [row.key, row]));
  const rows = current.states.map((row) => ({ key: row.key, verdict: referenceVerdict(row, refs.get(row.key)), pixels: row.pixels, refPixels: refs.get(row.key)?.pixels ?? null }));
  const seen = new Set(current.states.map((row) => row.key));
  const missing = reference.states.filter((row) => !seen.has(row.key)).map((row) => ({ key: row.key, verdict: 'missing', pixels: null, refPixels: row.pixels }));
  const all = [...rows, ...missing];
  const bad = new Set(['worse', 'missing', 'different-pixel-ratio']);
  return { ok: !all.some((row) => bad.has(row.verdict)), mismatch: null, rows: all };
}

/** Text lines for the `--prev` table. */
export function formatRounds(rounds) {
  const sign = (n) => (n === null ? '-' : n > 0 ? `+${n}` : String(n));
  return rounds.map((r) => `  ${r.key}: ${r.verdict}${r.plateau ? ' PLATEAU' : ''} (pixels ${sign(r.pixelDelta)}, rows ${sign(r.rowDelta)})`);
}

/** Text lines for the `--no-worse` table; the first line is the verdict. */
export function formatReference(result) {
  if (result.mismatch) return [`no-worse: FAIL - ${result.mismatch}`];
  const worse = result.rows.filter((r) => r.verdict !== 'identical' && r.verdict !== 'better' && r.verdict !== 'equal' && r.verdict !== 'new');
  const head = result.ok ? 'no-worse: PASS - 0 worse' : `no-worse: FAIL - ${worse.length} worse: ${worse.map((r) => r.key).join('; ')}`;
  return [head, ...result.rows.map((r) => `  ${r.key}: ${r.verdict}${r.verdict === 'new' ? ' (INFO: no reference row)' : ''} (${r.refPixels ?? '-'} -> ${r.pixels ?? '-'} px)`)];
}
