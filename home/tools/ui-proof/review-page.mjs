// Purpose: `ui-proof review-page --results <dir> --out <dir> [--matrix <matrix.json>]`: write the owner review page
//   (`<out>/index.html`) from a ui-check results folder: per state and locale a live link, the Figma image, the actual
//   capture, the diff and the verdict, then the matrix's accepted list and its "settled, do not report again" list.
// Exports: run(argv) -> exit code (0 written, 2 usage or unreadable input); buildModel(input) (reads the inputs and copies
//   the images); renderPage (the pure page builder, from lib/review-html.mjs).
// Invariants: reads only results.json in --results, the image files its records name (or actual.png and diff.png beside
//   each compare record's evidence) and --matrix; writes only inside --out (index.html and images/); every image is
//   copied so the page links relatively and opens from disk or from a zip; the page path is the only stdout line.
import fs from 'node:fs';
import path from 'node:path';
import { need, parse } from '../ui-check/lib/args.mjs';
import { UsageError } from '../ui-check/lib/errors.mjs';
import { renderPage } from './lib/review-html.mjs';

export { renderPage };

const OPTIONS = { results: { type: 'string' }, out: { type: 'string' }, matrix: { type: 'string' } };
const RESULTS_FILE = 'results.json';
const PAGE_FILE = 'index.html';
const IMAGE_DIR = 'images';
const DEFAULT_IMAGE_EXT = '.png';
const IMAGE_KINDS = ['baseline', 'actual', 'diff'];
const FALLBACK_FILES = { actual: 'actual.png', diff: 'diff.png' }; // what ui-check compare writes beside report.md
const PNG_HEADER_BYTES = 24;
const PNG_WIDTH_AT = 16;
const PNG_HEIGHT_AT = 20;
const EXIT_WRITTEN = 0;
const EXIT_USAGE = 2;

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.length > 0;

function readJson(file, what) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new UsageError(`cannot read the ${what} ${file}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UsageError(`the ${what} ${file} is not JSON: ${error.message}`);
  }
}

/** The records of `<dir>/results.json`; throws UsageError when it is not an array of records with a surface and a state. */
function readRecords(resultsDir) {
  const file = path.join(resultsDir, RESULTS_FILE);
  const records = readJson(file, 'results file');
  if (!Array.isArray(records)) throw new UsageError(`${file} must hold an array of ui-check records`);
  records.forEach((record, index) => {
    if (!isObject(record) || !isText(record.surface) || !isText(record.state)) {
      throw new UsageError(`${file} record ${index} needs a surface and a state (text)`);
    }
  });
  return records;
}

/** The matrix `accepted` and `settled` lists (both empty without --matrix); throws UsageError on a malformed list. */
function readMatrix(file) {
  if (file === undefined) return { accepted: [], settled: [] };
  const matrix = readJson(file, 'matrix');
  if (!isObject(matrix)) throw new UsageError(`the matrix ${file} must be a JSON object`);
  const { accepted = [], settled = [] } = matrix;
  if (!Array.isArray(accepted) || !accepted.every(isObject)) throw new UsageError(`${file}: accepted must be an array of objects`);
  if (!Array.isArray(settled)) throw new UsageError(`${file}: settled must be an array`);
  settled.forEach((entry, index) => {
    const sound = isObject(entry) && ['surface', 'state', 'what'].every((key) => isText(entry[key])) && entry.owner !== undefined;
    if (!sound) throw new UsageError(`${file}: settled[${index}] needs surface, state, what (text) and owner`);
    if (entry.locale !== undefined && !isText(entry.locale)) throw new UsageError(`${file}: settled[${index}].locale must be text`);
  });
  return { accepted, settled };
}

// A record path as given when absolute, else from the current folder when it exists there, else from the results folder.
function resolveRecordPath(resultsDir, file) {
  if (path.isAbsolute(file)) return file;
  const fromCwd = path.resolve(file);
  return fs.existsSync(fromCwd) ? fromCwd : path.resolve(resultsDir, file);
}

/** Source file per image kind of a compare record; null = not recorded (no `images` entry and no evidence). */
function imageSources(record, resultsDir) {
  const given = isObject(record.images) ? record.images : {};
  const evidenceDir = isText(record.evidence) ? path.dirname(resolveRecordPath(resultsDir, record.evidence)) : null;
  const source = (kind) => {
    if (isText(given[kind])) return resolveRecordPath(resultsDir, given[kind]);
    return FALLBACK_FILES[kind] && evidenceDir !== null ? path.join(evidenceDir, FALLBACK_FILES[kind]) : null;
  };
  return Object.fromEntries(IMAGE_KINDS.map((kind) => [kind, source(kind)]));
}

/** Width and height from a PNG header, or {} when the file is not a PNG. */
function pngSize(file) {
  const bytes = fs.readFileSync(file).subarray(0, PNG_HEADER_BYTES);
  if (bytes.length < PNG_HEADER_BYTES || bytes.toString('latin1', 1, 4) !== 'PNG') return {};
  return { width: bytes.readUInt32BE(PNG_WIDTH_AT), height: bytes.readUInt32BE(PNG_HEIGHT_AT) };
}

function missingText(kind, source) {
  if (source === null) return kind === 'baseline' ? 'baseline not recorded' : 'not recorded';
  return kind === 'diff' ? `no diff image at ${source} (an exact match writes none)` : `not found: ${source}`;
}

/**
 * Copy one image into `<out>/images/` and return its page reference.
 * @param {string|null} source the image file, null when the record names none
 * @param {{kind: string, outDir: string, name: string}} target image kind, output folder and file name without extension
 * @returns {{href: string, width?: number, height?: number} | {missing: string}} relative href, or why there is no image
 */
function copyImage(source, { kind, outDir, name }) {
  if (source === null || !fs.existsSync(source)) return { missing: missingText(kind, source) };
  const href = `${IMAGE_DIR}/${name}${path.extname(source) || DEFAULT_IMAGE_EXT}`;
  fs.copyFileSync(source, path.join(outDir, href));
  return { href, ...pngSize(source) };
}

function compareEntry(record, { resultsDir, outDir, name }) {
  const sources = imageSources(record, resultsDir);
  const images = Object.fromEntries(IMAGE_KINDS.map((kind) => [kind, copyImage(sources[kind], { kind, outDir, name: `${name}-${kind}` })]));
  return { width: record.width, status: record.status, findings: record.findings, evidence: record.evidence, images };
}

/** Group the records into one row per surface, state and locale, in the order the results list them. */
function groupRows(records) {
  const rows = new Map();
  for (const record of records) {
    const key = JSON.stringify([record.surface, record.state, record.locale ?? null]);
    const row = rows.get(key) ?? { surface: record.surface, state: record.state, locale: record.locale, url: undefined, compare: [], responsive: [] };
    row.url ??= isText(record.url) ? record.url : undefined;
    (record.part === 'compare' ? row.compare : row.responsive).push(record);
    rows.set(key, row);
  }
  return [...rows.values()];
}

/**
 * Read the inputs, copy the images into the output folder and build the page model.
 * @param {{resultsDir: string, outDir: string, matrixFile?: string, generated: string}} input absolute folders, the
 *   optional matrix file and the generation time shown on the page
 * @returns {object} the model renderPage takes
 * @throws {UsageError} when results.json or the matrix cannot be read or has the wrong shape
 */
export function buildModel({ resultsDir, outDir, matrixFile, generated }) {
  const records = readRecords(resultsDir);
  const { accepted, settled } = readMatrix(matrixFile);
  fs.mkdirSync(path.join(outDir, IMAGE_DIR), { recursive: true });
  const rows = groupRows(records).map(({ compare, ...row }, rowIndex) => ({
    ...row,
    compares: compare.map((record, index) => compareEntry(record, { resultsDir, outDir, name: `${rowIndex + 1}-${index + 1}` })),
    responsive: row.responsive.map(({ width, status, findings, evidence }) => ({ width, status, findings, evidence })),
  }));
  return { generated, resultsDir, rows, accepted, settled };
}

/**
 * Run `ui-proof review-page` with the flags after the command name.
 * @param {string[]} argv flags: --results <dir> --out <dir> [--matrix <matrix.json>]
 * @returns {number} 0 when the page was written (its path printed on stdout), 2 on a usage error or unreadable input
 * @throws {Error} anything that is not a usage problem (a failed write), so it is never hidden
 */
export function run(argv) {
  try {
    const values = parse(argv, OPTIONS);
    need(values, 'results', 'out');
    const outDir = path.resolve(values.out);
    const matrixFile = values.matrix === undefined ? undefined : path.resolve(values.matrix);
    const model = buildModel({ resultsDir: path.resolve(values.results), outDir, matrixFile, generated: new Date().toISOString() });
    const page = path.join(outDir, PAGE_FILE);
    fs.writeFileSync(page, renderPage(model));
    process.stdout.write(`${page}\n`);
    return EXIT_WRITTEN;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`ui-proof review-page: ${error.message}\n`);
    return EXIT_USAGE;
  }
}
