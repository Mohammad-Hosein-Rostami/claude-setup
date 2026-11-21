// Purpose: attribute the compare records of a results.json (P4): read each record's images and Figma spec, recount the colour metric
// against the record's `driftPixels`, class every leftover pixel (lib/attribution.mjs), write crops baseline | actual | diff, judge the
// record under its rule and print one row per class. Also the `run --strict` hook-up (P3f): a strict compare whose only failing finding
// is the pixel finding passes when every leftover pixel is accepted or text anti-aliasing; results.json and ledger.json are rewritten.
// Exports: ATTRIBUTION_FILE, acceptanceContext, attributeRecords, formatAttribution, writeAttribution, attributeStrict.
// Invariants: a recount that differs from the record is a setup error (UsageError, exit 2), never a pass. A size mismatch is never
// accepted. Accepted pixels need a matrix entry with an owner decision and a reason (ui-coverage/lib/accepted.mjs pixelAcceptances).
// Crops are native scale and at most MAX_CROP_EDGE on each edge (lib/crops.mjs cropTiles); they explain a row, never decide it.
import fs from 'node:fs';
import path from 'node:path';
import pngjs from 'pngjs';
import { askDir } from '../../ask/lib/store.mjs';
import { pixelAcceptances } from '../../ui-coverage/lib/accepted.mjs';
import { acceptedBox, attributePixels, CLASSES, CLASS_LABELS, leftoverPixels, textScopeBoxes } from './attribution.mjs';
import { exitCodeFor, writeBatchResults } from './batch-records.mjs';
import { isHint } from './bidi.mjs';
import { readCache } from './cache.mjs';
import { cropTiles } from './crops.mjs';
import { UsageError } from './errors.mjs';
import { padTo, readPng, writePng } from './image.mjs';
import { writeLedger } from './ledger.mjs';
import { tableRow } from './report.mjs';

const { PNG } = pngjs;
export const ATTRIBUTION_FILE = 'attribution.json';
const CROP_DIR = 'attribution';
const PANELS = ['baseline', 'actual', 'diff'];
const DIFF_RGBA = [255, 0, 0, 255];
const CHANNELS = 4;
const TOP_CROPS = 3; // clusters, and again flagged text boxes, per record
const STRICT_FAILING = new Set(['text-flagged', 'graphic', 'other']);
const DEFAULT_FAILING = new Set(['text-aa', 'text-flagged', 'graphic', 'other']);
const RENDER_MATCH_PX = 1; // as commands/compare.mjs: the baseline is a render-bounds export when its size matches within this
const NO_FILE = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);

/** A file's text or real path, null when there is no such file (ui-coverage treats a missing file as a finding, not an error). */
function orNull(read) {
  try {
    return read();
  } catch (error) {
    if (NO_FILE.has(error.code)) return null;
    throw error;
  }
}

/**
 * The matrix and the owner-file readers its accepted entries are judged with, or null without a matrix.
 * @param {string|undefined} matrixFile path of the coverage matrix
 * @returns {{matrix: object, files: object}|null}
 * @throws {UsageError} when the matrix cannot be read or parsed
 */
export function acceptanceContext(matrixFile) {
  if (matrixFile === undefined) return null;
  let matrix;
  try {
    matrix = JSON.parse(fs.readFileSync(matrixFile, 'utf8'));
  } catch (error) {
    throw new UsageError(`--accepted ${matrixFile}: ${error.message}`);
  }
  const realPath = (file) => orNull(() => fs.realpathSync.native(file));
  return { matrix, files: { baseDir: path.dirname(path.resolve(matrixFile)), readText: (file) => orNull(() => fs.readFileSync(file, 'utf8')), queueDir: realPath(askDir()), realPath } };
}

const fresh = (file, than) => fs.existsSync(file) && fs.statSync(file).mtimeMs >= fs.statSync(than).mtimeMs;

/** The image pair the pixel gate compared: its masked or padded copies when this capture wrote them, else the two files padded in memory. */
function alignedImages({ images }) {
  if (!fs.existsSync(images.actual)) throw new UsageError(`capture not found: ${images.actual}`);
  const dir = path.dirname(images.actual);
  const original = readPng(images.baseline);
  for (const [base, actual] of [['baseline.masked.png', 'actual.masked.png'], ['baseline.padded.png', 'actual.padded.png']]) {
    const pair = [base, actual].map((name) => path.join(dir, name));
    if (pair.every((file) => fresh(file, images.actual))) return { base: readPng(pair[0]), actual: readPng(pair[1]), original };
  }
  const actual = readPng(images.actual);
  const width = Math.max(original.width, actual.width);
  const height = Math.max(original.height, actual.height);
  const pad = (png) => (png.width === width && png.height === height ? png : padTo(png, width, height));
  return { base: pad(original), actual: pad(actual), original };
}

/** Where the node origin sits in the image: moved by the render bounds when the baseline is a render-bounds export (as compare captures it). */
function renderOffset({ spec, meta }, original, scale) {
  const { root } = spec;
  const render = root?.render;
  if (!render || (render.x === 0 && render.y === 0 && render.w === root.w && render.h === root.h)) return { x: 0, y: 0 };
  const near = (a, b) => Math.abs(a - b) <= RENDER_MATCH_PX;
  if (!near(original.width, render.w * meta.scale) || !near(original.height, render.h * meta.scale)) return { x: 0, y: 0 };
  return { x: Math.round(-render.x * scale), y: Math.round(-render.y * scale) };
}

/** The accepted pixels of a record: an entry without nodes covers all of them, else the boxes of the nodes it names. */
function acceptedFor(record, acceptance, nodes, place) {
  const entries = acceptance ? pixelAcceptances(acceptance.matrix, record, acceptance.files) : [];
  const whole = entries.find((entry) => entry.nodes === null);
  if (whole) return { all: whole.reason, boxes: [] };
  const byId = new Map(nodes.map((node) => [String(node.id), node]));
  const boxes = entries.flatMap((entry) => entry.nodes.map((id) => {
    if (!byId.has(id)) throw new UsageError(`accepted entry "${entry.reason}" names node ${id}, which is not in the Figma spec`);
    return { box: acceptedBox(byId.get(id), place), reason: entry.reason };
  }));
  return { all: null, boxes };
}

/** Write one tile as three native-scale PNGs: baseline, actual, and actual with the leftover pixels in red. @returns {string[]} */
function writePanels({ base, actual, mask }, tile, prefix) {
  const panels = [base, actual, actual].map((source) => {
    const out = new PNG({ width: tile.w, height: tile.h });
    PNG.bitblt(source, out, tile.x, tile.y, tile.w, tile.h, 0, 0);
    return out;
  });
  for (let y = 0; y < tile.h; y += 1) {
    for (let x = 0; x < tile.w; x += 1) if (mask[(tile.y + y) * base.width + tile.x + x]) panels[2].data.set(DIFF_RGBA, (y * tile.w + x) * CHANNELS);
  }
  return panels.map((png, i) => {
    const file = `${prefix}-${PANELS[i]}.png`;
    writePng(file, png);
    return file;
  });
}

/** Crops of the biggest clusters and flagged text boxes into <state dir>/attribution/ (emptied first). */
function writeCrops(images, attribution, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const toRegion = (b) => ({ x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 });
  const items = [
    ...attribution.clusters.slice(0, TOP_CROPS).map((c) => ({ class: c.class, region: c.box })),
    ...attribution.flaggedText.slice(0, TOP_CROPS).map((t) => ({ class: 'text-flagged', region: toRegion(t.box) })),
  ];
  return items.flatMap((item, n) => cropTiles(item.region, images.base).map((tile, t) => ({ class: item.class, files: writePanels(images, tile, path.join(dir, `${n + 1}${t === 0 ? '' : `.${t + 1}`}-${item.class}`)) })));
}

const pixelFinding = (record) => record.findings?.find((finding) => finding.check === 'pixel');

/** The classes that fail a record: strict = flagged text, graphic, other; default = every unaccepted class, once the gate failed. */
function failingClasses(record, strict) {
  if (strict) return STRICT_FAILING;
  return pixelFinding(record) ? DEFAULT_FAILING : new Set();
}

/**
 * Attribute one compare record.
 * @param {object} record a results.json compare record with `images`
 * @param {{strict: boolean, acceptance: object|null}} ctx strict = judge under the strict rule (also when the record's rule is strict)
 * @returns {object} {record, label, rule, total, classes, crops, pass, why}
 * @throws {UsageError} when an image or the cache is missing, or the recount differs from the record's driftPixels
 */
function attributeRecord(record, ctx) {
  const cache = readCache(path.dirname(record.images.baseline));
  const images = alignedImages(record);
  const scale = record.scale ?? cache.meta.scale;
  const nodes = cache.spec.nodes ?? [];
  const label = `${record.surface} / ${record.state} / ${record.locale ?? 'default'} @${record.width}`;
  const leftover = leftoverPixels(images.base, images.actual, textScopeBoxes(nodes, scale));
  const counted = record.rule === 'strict' ? leftover.every : leftover.outside;
  if (counted.length !== (record.driftPixels ?? 0)) throw new UsageError(`${label}: recounted ${counted.length} colour-metric px, the record says ${record.driftPixels ?? 0} (${record.evidence})`);
  const strict = ctx.strict || record.rule === 'strict';
  const pixels = strict ? leftover.every : leftover.outside;
  const place = { scale, offset: renderOffset(cache, images.original, scale) };
  const attribution = attributePixels({ base: images.base, actual: images.actual, pixels, nodes }, place, acceptedFor(record, ctx.acceptance, nodes, place));
  const mask = new Uint8Array(images.base.width * images.base.height);
  for (const idx of pixels) mask[idx] = 1;
  const crops = writeCrops({ ...images, mask }, attribution, path.join(path.dirname(record.images.actual), CROP_DIR));
  const failing = failingClasses(record, strict);
  const sizeMismatch = pixelFinding(record) !== undefined && typeof pixelFinding(record).percent !== 'number';
  const failed = CLASSES.filter((name) => failing.has(name) && attribution.classes[name].px > 0);
  const why = sizeMismatch ? 'size mismatch (never accepted)' : failed.map((name) => CLASS_LABELS[name]).join(', ');
  return { record, label, rule: strict ? 'strict' : 'default', total: attribution.total, classes: attribution.classes, failing, crops, pass: !sizeMismatch && failed.length === 0, why };
}

/**
 * Attribute every compare record that has images.
 * @param {object[]} records results.json records
 * @param {{strict: boolean, acceptance: object|null}} ctx see attributeRecord
 * @returns {object[]} one result per attributed record
 * @throws {UsageError} as attributeRecord
 */
export const attributeRecords = (records, ctx) => records.filter((r) => r.part === 'compare' && r.images?.actual && r.images?.baseline).map((r) => attributeRecord(r, ctx));

const nodesText = (nodes) => nodes.map((n) => `${n.label} ${n.px} px`).join('; ');

/** One header line per record, then one row per class with pixels (class, px, verdict, top nodes) and the crop paths. @returns {string[]} */
export function formatAttribution(results) {
  return results.flatMap((r) => [
    `attribute ${r.label} (rule ${r.rule}): ${r.total} px, recount matches -> ${r.pass ? 'PASS' : `FAIL (${r.why})`}`,
    ...CLASSES.filter((name) => r.classes[name].px > 0).map((name) => `  ${tableRow([CLASS_LABELS[name], `${r.classes[name].px} px`, r.failing.has(name) ? 'FAIL' : 'pass', nodesText(r.classes[name].nodes)])}`),
    ...r.crops.map((c) => `    crop ${CLASS_LABELS[c.class]}: ${c.files.join(' | ')}`),
  ]);
}

/** Write <dir>/attribution.json (per record: label, rule, verdict, class counts and top nodes, crop paths). @returns {string} its path */
export function writeAttribution(dir, results) {
  const file = path.join(dir, ATTRIBUTION_FILE);
  const rows = results.map(({ record, failing, ...r }) => ({ ...r, evidence: record.evidence, failing: [...failing] }));
  fs.writeFileSync(file, `${JSON.stringify(rows, null, 2)}\n`);
  return file;
}

/** A failing strict compare whose only failing finding is a pixel finding with a share (a size mismatch has none). */
const onlyPixelFailure = (r) => {
  const failing = (r.findings ?? []).filter((finding) => !isHint(finding));
  return r.part === 'compare' && r.status === 'fail' && r.rule === 'strict' && r.images?.actual && failing.length === 1 && failing[0].check === 'pixel' && typeof failing[0].percent === 'number';
};

const sameCell = (a, b) => a.surface === b.surface && a.state === b.state && a.locale === b.locale && a.width === b.width;

/**
 * P3f hook-up for `run`: attribute the strict compares that fail only on pixels; each passes when all its leftover pixels are accepted
 * or text anti-aliasing. Passing ones lose the pixel finding and gain `attribution`; results.json, summary.md and ledger.json are rewritten.
 * @param {{records: object[], outDir: string, ledger: object|null}} batch executeBatch result
 * @param {string} matrixFile the coverage matrix (its accepted entries)
 * @returns {{records: object[], ledger: object|null, lines: string[], code: number}} code = the batch exit code over the new records
 * @throws {UsageError} as attributeRecord
 */
export function attributeStrict({ records, outDir, ledger }, matrixFile) {
  const results = attributeRecords(records.filter(onlyPixelFailure), { strict: true, acceptance: acceptanceContext(matrixFile) });
  if (results.length === 0) return { records, ledger, lines: [], code: exitCodeFor(records) };
  writeAttribution(outDir, results);
  const passed = new Map(results.filter((r) => r.pass).map((r) => [r.record, r]));
  const next = records.map((r) => (passed.has(r) ? { ...r, status: 'pass', findings: r.findings.filter((f) => f.check !== 'pixel'), attribution: Object.fromEntries(CLASSES.map((name) => [name, passed.get(r).classes[name].px])) } : r));
  let nextLedger = ledger;
  if (passed.size > 0) {
    writeBatchResults(outDir, next);
    const flipped = [...passed.keys()];
    nextLedger = ledger && { ...ledger, states: ledger.states.map((row) => (flipped.some((r) => sameCell(r, row)) ? { ...row, status: 'pass' } : row)) };
    if (nextLedger) writeLedger(outDir, nextLedger);
  }
  return { records: next, ledger: nextLedger, lines: ['attribution (strict rule):', ...formatAttribution(results)], code: exitCodeFor(next) };
}
