// Purpose: `ui-check run --same <base run>`: compare this run's responsive captures (ledger `captures`) with a base run of the same
// matrix and states, state by state and width by width, so a change that must not alter the look can be proved by the renders.
// Exports: SAME_VERDICTS, baseRefusal, compareSame, formatSame.
// Verdicts: identical (same sha256), equal (other bytes, the same decoded RGBA pixels: 0 px differ, no tolerance), changed (any pixel
// differs in any channel, or another size), new (no base row), missing (a base row this run lacks, or a capture on either side that
// does not count as proof: never identical), other-renderer (the base was made with another comparator or renderer: every row, never
// compared), refused (the base run recorded no head, or this run's own head: every row, never compared). newFindings are finding ids
// this run has and the base row lacks; newPageErrors are the page errors beyond the base row's (counted per message).
// Invariants: a capture counts only when its bytes, read now from a plain file (lstat: no link) inside its run's real folder, hash to
// the sha256 its row recorded; the verdict is made from exactly those bytes (the diff images use copies of them). Reads the base
// ledger the caller read once and the base captures it names; writes only under this run's folder (`same/` holds the diff images and
// the copies); the exit code of `run` never depends on it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pngjs from 'pngjs';
import { mismatchLine } from './ledger.mjs';
import { pixelCheck } from './pixels.mjs';

const { PNG } = pngjs;
export const SAME_VERDICTS = Object.freeze(['identical', 'equal', 'changed', 'new', 'missing', 'other-renderer', 'refused']);
const SAME_DIR = 'same'; // diff images of the rows compared pixel by pixel, inside this run's folder
const NO_PIXEL_SLACK = 0; // the diff image of a changed row is made with no allowance at all
const RGBA = 4; // bytes per decoded pixel (pngjs always decodes to 8-bit RGBA)
// Opened without following a link and without waiting on a FIFO, so a file swapped after the lstat is refused, never followed or hung on.
const PLAIN_READ = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

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

/**
 * Why a base run proves nothing about this run's change, or null when it may be compared: a base must name the tree it rendered
 * (its recorded git head) and that tree must not be this run's own head.
 * @param {object} baseLedger the base run's ledger
 * @param {string|null} tipHead this run's head sha (null outside git)
 * @returns {string|null}
 */
export function baseRefusal(baseLedger, tipHead) {
  const head = baseLedger.head;
  if (typeof head !== 'string' || head === '') return 'the base run recorded no git head, so nothing shows it rendered the base tree; run the base again in the base tree';
  if (head === tipHead) return `the base run's head ${head} is this run's own head; run the base in the base tree`;
  return null;
}

/** The real path of a run folder, or null when it is gone (a file-system error); any other error is thrown. */
function realFolder(dir) {
  try {
    return fs.realpathSync.native(dir);
  } catch (error) {
    if (typeof error.code === 'string') return null;
    throw error;
  }
}

const inside = (dir, file) => {
  const rel = path.relative(dir, file);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

/** The bytes of a plain file inside `realDir` (no link at the end, no link out of the folder on the way), or the reason it is not one. */
function plainBytes(file, realDir) {
  if (!fs.lstatSync(file).isFile()) return { why: 'is not a plain file (a link or another kind)' };
  if (!inside(realDir, fs.realpathSync.native(file))) return { why: 'is outside its run folder' };
  const fd = fs.openSync(file, PLAIN_READ);
  try {
    return fs.fstatSync(fd).isFile() ? { bytes: fs.readFileSync(fd) } : { why: 'is not a plain file (a link or another kind)' };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The bytes of a row's capture when they count as proof: read now from a plain file inside the run's real folder and hashing to the
 * sha256 the row recorded. A hand-edited hash, a path out of the folder, a link or a file swapped since the ledger was written never count.
 * @param {{file: unknown, sha256: unknown}} row a ledger capture row
 * @param {string|null} realDir the run folder's real path (null: the folder is gone)
 * @returns {{bytes: Buffer} | {why: string}}
 */
function provenCapture(row, realDir) {
  if (typeof row.file !== 'string') return { why: 'capture names no file' };
  if (realDir === null) return { why: 'run folder is gone' };
  const label = `capture ${row.file}`;
  let read;
  try {
    read = plainBytes(path.resolve(realDir, row.file), realDir);
  } catch (error) {
    if (typeof error.code === 'string') return { why: `${label} is gone or unreadable (${error.code})` };
    throw error;
  }
  if (read.why) return { why: `${label} ${read.why}` };
  const sha = crypto.createHash('sha256').update(read.bytes).digest('hex');
  return sha === row.sha256 ? { bytes: read.bytes } : { why: `${label} does not hash to its recorded sha256` };
}

/** Pixels that differ in any channel between two decoded PNGs, or null when their sizes differ. */
function differingPixels(base, tip) {
  if (base.width !== tip.width || base.height !== tip.height) return null;
  let count = 0;
  for (let offset = 0; offset < base.data.length; offset += RGBA) {
    if (base.data.compare(tip.data, offset, offset + RGBA, offset, offset + RGBA) !== 0) count += 1;
  }
  return count;
}

/** The odiff and colour-metric counts and diff image of a changed row, from copies of the proven bytes under `outDir`. */
async function diffNote(bytes, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const files = { base: path.join(outDir, 'base.png'), tip: path.join(outDir, 'tip.png') };
  fs.writeFileSync(files.base, bytes.base);
  fs.writeFileSync(files.tip, bytes.tip);
  try {
    const result = await pixelCheck({ baselineFile: files.base, actualFile: files.tip, outDir, maxDiffPercent: NO_PIXEL_SLACK, strict: true });
    return `${result.diffCount} px (odiff), ${result.drift.count} px (colour metric); diff ${result.diffFile}`;
  } catch (error) {
    return `no diff image: ${error.message}`; // the verdict stands on the exact count; only the picture of it failed
  }
}

/** Pixel verdict of two proven captures that differ in bytes: equal only when every decoded pixel is the same, at one size. */
async function pixelVerdict(bytes, outDir) {
  let differing;
  try {
    differing = differingPixels(PNG.sync.read(bytes.base), PNG.sync.read(bytes.tip));
  } catch (error) {
    return { verdict: 'missing', detail: `capture not comparable: ${error.message}` }; // a broken PNG proves nothing: fail closed
  }
  if (differing === 0) return { verdict: 'equal', detail: null };
  return { verdict: 'changed', detail: `${differing === null ? 'other size' : `${differing} px differ (exact)`}, ${await diffNote(bytes, outDir)}` };
}

/** Verdict of one row of this run against its base row (same comparator and renderer, an accepted base). */
async function rowVerdict(row, base, dirs, index) {
  if (!base) return { verdict: 'new', detail: null };
  if (row.sha256 === null || base.sha256 === null) return { verdict: 'missing', detail: `${row.sha256 === null ? 'this run' : 'the base run'} has no readable capture` };
  const tip = provenCapture(row, dirs.runDir);
  const old = provenCapture(base, dirs.baseDir);
  if (tip.why || old.why) return { verdict: 'missing', detail: tip.why ? `this run's ${tip.why}` : `the base run's ${old.why}` };
  if (row.sha256 === base.sha256) return { verdict: 'identical', detail: null }; // both byte strings were just hashed to these
  return pixelVerdict({ tip: tip.bytes, base: old.bytes }, path.join(dirs.runDir, SAME_DIR, `${index}-${row.key.replace(/[^A-Za-z0-9_.-]/g, '-')}`));
}

/**
 * Compare this run's captures with the base run's.
 * @param {object} current this run's ledger (buildLedger; `captures` may be absent in a ledger from before them; `head` its git head)
 * @param {{file: string, sha256: string, ledger: object}} base the base ledger as readLedgerFile returned it
 * @param {string} runDir this run's folder (capture paths are relative to it; diff images go under its `same/`)
 * @returns {Promise<{ref: {file: string, sha256: string, head: string|null, createdAt: string|null}, mismatch: string|null, refused: string|null,
 *   rows: {key: string, verdict: string, newFindings: string[], newPageErrors: string[], detail: string|null}[]}>}
 *   rows: this run's rows in order, then the base rows this run lacks; refused (baseRefusal) wins over mismatch
 */
export async function compareSame(current, base, runDir) {
  const ref = { file: base.file, sha256: base.sha256, head: base.ledger.head ?? null, createdAt: base.ledger.createdAt ?? null };
  const refused = baseRefusal(base.ledger, current.head ?? null);
  const mismatch = mismatchLine(current, base.ledger);
  const blocked = refused ? 'refused' : mismatch ? 'other-renderer' : null;
  const mine = current.captures ?? [];
  const theirs = base.ledger.captures ?? [];
  const byKey = new Map(theirs.map((row) => [row.key, row]));
  const dirs = blocked ? null : { runDir: realFolder(runDir), baseDir: realFolder(path.dirname(base.file)) };
  const rows = [];
  for (const [index, row] of mine.entries()) {
    const other = byKey.get(row.key);
    const { verdict, detail } = blocked ? { verdict: blocked, detail: null } : await rowVerdict(row, other, dirs, index);
    rows.push({ key: row.key, verdict, ...differences(row, other), detail });
  }
  const seen = new Set(mine.map((row) => row.key));
  const gone = theirs.filter((row) => !seen.has(row.key));
  rows.push(...gone.map((row) => ({ key: row.key, verdict: blocked ?? 'missing', newFindings: [], newPageErrors: [], detail: blocked ? null : 'not captured in this run' })));
  return { ref, mismatch, refused, rows };
}

/**
 * The `same:` lines of `run`: the counts, the reason when the base cannot be compared, then every row that is not identical or
 * equal or that has a new finding or page error.
 * @param {{mismatch: string|null, refused?: string|null, rows: object[]}} same compareSame result
 * @returns {string[]}
 */
export function formatSame(same) {
  if (same.rows.length === 0) return ['same: 0 rows'];
  const count = (verdict) => same.rows.filter((row) => row.verdict === verdict).length;
  const extra = ['other-renderer', 'refused'].filter((verdict) => count(verdict) > 0).map((verdict) => `, ${count(verdict)} ${verdict}`).join('');
  const head = `same: ${count('identical')} identical, ${count('equal')} equal, ${count('changed')} changed, ${count('new')} new, ${count('missing')} missing${extra}`;
  const why = same.refused ? [`  refused: ${same.refused}`] : same.mismatch ? [`  other-renderer: ${same.mismatch}`] : [];
  const notable = same.rows.filter((row) => !['identical', 'equal'].includes(row.verdict) || row.newFindings.length > 0 || row.newPageErrors.length > 0);
  const lines = notable.map((row) => {
    const parts = [row.verdict, row.detail, row.newFindings.length > 0 ? `new findings: ${row.newFindings.join(', ')}` : null, row.newPageErrors.length > 0 ? `${row.newPageErrors.length} new page error(s): ${row.newPageErrors[0]}` : null];
    return `  ${row.key}: ${parts.filter(Boolean).join('; ')}`;
  });
  return [head, ...why, ...lines];
}
