// Purpose: `ui-check run --same <base run>`: compare this run's responsive captures (ledger `captures`) with a base run of the same
// matrix and states, state by state and width by width, so a change that must not alter the look can be proved by the renders.
// Exports: SAME_VERDICTS, compareSame, formatSame.
// Verdicts: identical (same sha256), equal (other bytes, odiff 0 px and colour metric 0 px through lib/pixels.mjs, the pixel gate's own
// comparator and options), changed (any pixel differs, or another size), new (no base row), missing (a base row this run lacks, or a
// capture on either side that is absent or unreadable: never identical), other-renderer (the base was made with another comparator or
// renderer: every row, never compared). newFindings are finding ids this run has and the base row lacks; newPageErrors are the page
// errors beyond the base row's (counted per message).
// Invariants: reads the base ledger the caller read once and the base captures it names; writes only under this run's folder
// (`same/` holds the diff images); the exit code of `run` never depends on it.
import fs from 'node:fs';
import path from 'node:path';
import { mismatchLine } from './ledger.mjs';
import { pixelCheck } from './pixels.mjs';

export const SAME_VERDICTS = Object.freeze(['identical', 'equal', 'changed', 'new', 'missing', 'other-renderer']);
const SAME_DIR = 'same'; // diff images of the rows compared pixel by pixel, inside this run's folder
const NO_PIXEL_SLACK = 0; // "equal" allows no differing pixel at all

/** Messages of `now` beyond those of `before`, counted per message (two of the same error where the base had one is one new). */
function extraMessages(now, before) {
  const left = new Map();
  for (const message of before) left.set(message, (left.get(message) ?? 0) + 1);
  return now.filter((message) => {
    const count = left.get(message) ?? 0;
    if (count > 0) left.set(message, count - 1);
    return count === 0;
  });
}

function differences(row, base) {
  const known = new Set(base?.findings ?? []);
  return { newFindings: (row.findings ?? []).filter((id) => !known.has(id)), newPageErrors: extraMessages(row.pageErrors ?? [], base?.pageErrors ?? []) };
}

/** The capture file of a row on disk, or null when the row names none or it is not a readable file. */
function captureFile(row, runDir) {
  if (typeof row.file !== 'string') return null;
  const file = path.resolve(runDir, row.file);
  try {
    fs.accessSync(file, fs.constants.R_OK);
    return fs.statSync(file).isFile() ? file : null;
  } catch (error) {
    if (typeof error.code === 'string') return null; // absent or unreadable: a missing row
    throw error;
  }
}

/** Pixel verdict of two captures that differ in bytes: equal only when odiff and the colour metric both count 0 px at one size. */
async function pixelVerdict(files, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  try {
    const result = await pixelCheck({ baselineFile: files.base, actualFile: files.tip, outDir, maxDiffPercent: NO_PIXEL_SLACK, strict: true });
    const equal = !result.sizeMismatch && result.diffCount === 0 && result.drift.count === 0;
    return { verdict: equal ? 'equal' : 'changed', detail: equal ? null : `${result.diffCount} px (odiff), ${result.drift.count} px (colour metric)${result.sizeMismatch ? ', other size' : ''}; diff ${result.diffFile}` };
  } catch (error) {
    return { verdict: 'missing', detail: `capture not comparable: ${error.message}` }; // a broken PNG proves nothing: fail closed
  }
}

/** Verdict of one row of this run against its base row (same comparator and renderer). */
async function rowVerdict(row, base, dirs, index) {
  if (!base) return { verdict: 'new', detail: null };
  if (row.sha256 === null || base.sha256 === null) return { verdict: 'missing', detail: `${row.sha256 === null ? 'this run' : 'the base run'} has no readable capture` };
  if (row.sha256 === base.sha256) return { verdict: 'identical', detail: null };
  const files = { tip: captureFile(row, dirs.runDir), base: captureFile(base, dirs.baseDir) };
  if (!files.tip || !files.base) return { verdict: 'missing', detail: `${files.tip ? 'the base' : 'this run\'s'} capture file is gone or unreadable` };
  return pixelVerdict(files, path.join(dirs.runDir, SAME_DIR, `${index}-${row.key.replace(/[^A-Za-z0-9_.-]/g, '-')}`));
}

/**
 * Compare this run's captures with the base run's.
 * @param {object} current this run's ledger (buildLedger; `captures` may be absent in a ledger from before them)
 * @param {{file: string, sha256: string, ledger: object}} base the base ledger as readLedgerFile returned it
 * @param {string} runDir this run's folder (capture paths are relative to it; diff images go under its `same/`)
 * @returns {Promise<{ref: {file: string, sha256: string, head: string|null, createdAt: string|null}, mismatch: string|null,
 *   rows: {key: string, verdict: string, newFindings: string[], newPageErrors: string[], detail: string|null}[]}>}
 *   rows: this run's rows in order, then the base rows this run lacks
 */
export async function compareSame(current, base, runDir) {
  const ref = { file: base.file, sha256: base.sha256, head: base.ledger.head ?? null, createdAt: base.ledger.createdAt ?? null };
  const mismatch = mismatchLine(current, base.ledger);
  const mine = current.captures ?? [];
  const theirs = base.ledger.captures ?? [];
  const byKey = new Map(theirs.map((row) => [row.key, row]));
  const dirs = { runDir, baseDir: path.dirname(base.file) };
  const rows = [];
  for (const [index, row] of mine.entries()) {
    const other = byKey.get(row.key);
    const { verdict, detail } = mismatch ? { verdict: 'other-renderer', detail: null } : await rowVerdict(row, other, dirs, index);
    rows.push({ key: row.key, verdict, ...differences(row, other), detail });
  }
  const seen = new Set(mine.map((row) => row.key));
  const gone = theirs.filter((row) => !seen.has(row.key));
  rows.push(...gone.map((row) => ({ key: row.key, verdict: mismatch ? 'other-renderer' : 'missing', newFindings: [], newPageErrors: [], detail: mismatch ? null : 'not captured in this run' })));
  return { ref, mismatch, rows };
}

/**
 * The `same:` lines of `run`: the counts, the reason when the base cannot be compared, then every row that is not identical or
 * equal or that has a new finding or page error.
 * @param {{mismatch: string|null, rows: object[]}} same compareSame result
 * @returns {string[]}
 */
export function formatSame(same) {
  if (same.rows.length === 0) return ['same: 0 rows'];
  const count = (verdict) => same.rows.filter((row) => row.verdict === verdict).length;
  const other = count('other-renderer');
  const head = `same: ${count('identical')} identical, ${count('equal')} equal, ${count('changed')} changed, ${count('new')} new, ${count('missing')} missing${other > 0 ? `, ${other} other-renderer` : ''}`;
  const why = same.mismatch ? [`  other-renderer: ${same.mismatch}`] : [];
  const notable = same.rows.filter((row) => !['identical', 'equal'].includes(row.verdict) || row.newFindings.length > 0 || row.newPageErrors.length > 0);
  const lines = notable.map((row) => {
    const parts = [row.verdict, row.detail, row.newFindings.length > 0 ? `new findings: ${row.newFindings.join(', ')}` : null, row.newPageErrors.length > 0 ? `${row.newPageErrors.length} new page error(s): ${row.newPageErrors[0]}` : null];
    return `  ${row.key}: ${parts.filter(Boolean).join('; ')}`;
  });
  return [head, ...why, ...lines];
}
