// Purpose: build the `batch` result records and write results.json and summary.md.
// Exports: compareRecords, responsiveRecords, errorRecords, withCloseFailures, exitCodeFor, summaryMarkdown, writeBatchResults, writePartialResults, readPriorRecords.
// Invariant: a record is { surface, state, locale, width, status: "pass"|"fail", evidence, findings }; another tool
// (`ui-coverage check --results`) reads these exact field names, so never rename them. evidence is the path of that state's report.
// hints is the number of heuristic hints (report.json `hints` at `evidence`): reported, never part of status. width is the viewport width the part ran at (an integer; a compare record carries the Figma frame width). It is null only on an
// error record whose Figma cache could not be read, so the frame size is unknown.
import fs from 'node:fs';
import path from 'node:path';
import { stateKey } from './batch-schedule.mjs';
import { isHint } from './bidi.mjs';
import { UsageError } from './errors.mjs';
import { tableRow } from './report.mjs';

const SUMMARY_HEAD = ['surface', 'state', 'locale', 'width', 'status', 'findings', 'hints', 'evidence'];
const NONE = '-';

function record(state, width, findings, evidence, hints = 0) {
  return { surface: state.surface, state: state.state, locale: state.locale, width, status: findings.every(isHint) ? 'pass' : 'fail', evidence, findings, hints };
}

/**
 * Records for the compare part of a state (its width is the viewport the compare ran at: the Figma frame width).
 * @param {object} state normalised state
 * @param {{md: string, pixels: object, elementRows: object[]}} result compareOnce result
 * @param {{root: string, maxDiff: number, width: number}} gate selector, pixel tolerance and viewport width used (a positive integer)
 * @returns {object[]} one record; findings are the failing element rows plus a pixel finding when the pixel gate failed
 * @throws {TypeError} when width is not a positive integer (a record without a width can never fill a coverage cell)
 */
export function compareRecords(state, { md, pixels, elementRows }, { root, maxDiff, width }) {
  if (!Number.isInteger(width) || width <= 0) throw new TypeError(`compare record width must be a positive integer (the viewport width), got ${JSON.stringify(width)}`);
  const findings = elementRows.map((r) => ({ check: 'element', element: r.element, detail: `${r.prop}: is ${r.is}, should be ${r.should} (delta ${r.delta})` }));
  if (!pixels.pass) {
    const size = pixels.sizeMismatch ? `size mismatch baseline ${pixels.sizeMismatch.baseline.join('x')} vs page ${pixels.sizeMismatch.actual.join('x')}; ` : '';
    findings.push({ check: 'pixel', element: root, detail: `${size}${pixels.diffPercent.toFixed(3)}% of pixels differ (${pixels.diffCount} px), max ${maxDiff}%` });
  }
  return [record(state, width, findings, md)];
}

/**
 * One record per audited width; a width without findings passes.
 * @param {object} state normalised state
 * @param {number[]} widths audited widths
 * @param {{md: string, findings: {width: number, check: string, element: string, detail: string}[], hints?: {width: number}[]}} result auditAll result
 */
export function responsiveRecords(state, widths, { md, findings, hints = [] }) {
  return widths.map((width) => {
    const own = findings.filter((f) => f.width === width).map(({ check, element, detail }) => ({ check, element, detail }));
    return record(state, width, own, md, hints.filter((h) => h.width === width).length);
  });
}

/**
 * Failing records for a part of a state that threw (bad step, HTTP error, direction mismatch, missing cache ...).
 * @param {object} state normalised state
 * @param {(number|null)[]} widths one slot per record the part would have produced (the compare slot is the frame width, null when the Figma cache is unreadable)
 * @param {Error} error what was thrown; its message becomes the finding
 * @param {string} stateDir the state's output folder, used as evidence because no report exists
 */
export function errorRecords(state, widths, error, stateDir) {
  const findings = [{ check: 'error', element: state.url, detail: error.message }];
  return widths.map((width) => record(state, width, findings, stateDir));
}

/**
 * Add a failing finding per context that could not be closed (a crashed browser), so the failure is recorded and the run goes on.
 * @param {object[]} records records of one part of a state
 * @param {object} state normalised state
 * @param {string[]} messages close error messages; none = records unchanged
 */
export function withCloseFailures(records, state, messages) {
  if (messages.length === 0) return records;
  const findings = messages.map((message) => ({ check: 'error', element: state.url, detail: `closing the browser context failed: ${message}` }));
  return records.map((r) => ({ ...r, status: 'fail', findings: [...r.findings, ...findings] }));
}

/** 1 when any record fails, and also when there are no records at all (nothing ran, so nothing is proved). */
export const exitCodeFor = (records) => (records.length === 0 || records.some((r) => r.status === 'fail') ? 1 : 0);

/**
 * The hints of one record, read from the report.json beside its evidence report.md.
 * @param {{evidence: string, width: number|null, hints?: number}} r record
 * @returns {string[]} one `check element: detail` text per hint; an unreadable report gives one line saying so
 */
function hintTexts(r) {
  if (!r.hints) return [];
  try {
    const { hints = [] } = JSON.parse(fs.readFileSync(path.join(path.dirname(r.evidence), 'report.json'), 'utf8'));
    return hints.filter((h) => h.width === r.width).map((h) => `${h.check} ${h.element}: ${h.detail}`);
  } catch (error) {
    return [`${r.hints} hint(s), details unreadable: ${error.message}`];
  }
}

/** The "Hints" section of summary.md: per state and width, every hint, so a reviewer can confirm or dismiss each (they never change a status). */
function hintsSection(records) {
  const lines = records.filter((r) => r.hints).flatMap((r) => [`- ${r.surface} / ${r.state} / ${r.locale ?? NONE} / ${r.width ?? NONE}px (${r.hints})`, ...hintTexts(r).map((t) => `  - ${t}`)]);
  return lines.length === 0 ? [] : ['', '## Hints (heuristics: confirm or dismiss each, they never fail a record)', ...lines];
}

/** summary.md content: verdict, counts, one table row per state x width, then the hints per state. */
export function summaryMarkdown(records) {
  if (records.length === 0) return '# ui-check batch: FAIL\n- no states ran\n';
  const failed = records.filter((r) => r.status === 'fail').length;
  const hinted = records.reduce((sum, r) => sum + (r.hints ?? 0), 0);
  const rows = records.map((r) => tableRow([r.surface, r.state, r.locale ?? NONE, r.width ?? NONE, r.status, r.findings.length, r.hints ?? 0, r.evidence]));
  return [`# ui-check batch: ${failed === 0 ? 'PASS' : 'FAIL'}`, `- records: ${records.length}, failed: ${failed}, hints: ${hinted}`, '', tableRow(SUMMARY_HEAD), tableRow(SUMMARY_HEAD.map(() => '---')), ...rows, ...hintsSection(records), ''].join('\n');
}

/**
 * Write results.json and summary.md into outDir.
 * @param {string} outDir existing directory
 * @param {object[]} records all records of the run
 * @returns {{results: string, summary: string}} the two paths
 */
export function writeBatchResults(outDir, records) {
  const results = path.join(outDir, 'results.json');
  const summary = path.join(outDir, 'summary.md');
  fs.writeFileSync(results, `${JSON.stringify(records, null, 2)}\n`);
  fs.writeFileSync(summary, summaryMarkdown(records));
  return { results, summary };
}

const PARTIAL = 'results.partial.json';

/**
 * Checkpoint of the states finished so far (`results.partial.json`, replaced atomically); removed when the run ends and results.json is written,
 * so it only survives an interrupted run, and `--resume` reads it.
 * @param {string} outDir existing directory
 * @param {object[]} records records of the finished states
 */
export function writePartialResults(outDir, records) {
  const file = path.join(outDir, PARTIAL);
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(records)}\n`);
  fs.renameSync(`${file}.tmp`, file);
}

/** Remove the checkpoint after a complete run. */
export function removePartialResults(outDir) {
  fs.rmSync(path.join(outDir, PARTIAL), { force: true });
}

function readRecordsFile(file) {
  if (!fs.existsSync(file)) return [];
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new UsageError(`--resume: cannot read ${file}: ${error.message}`);
  }
  if (!Array.isArray(parsed)) throw new UsageError(`--resume: ${file} must be a JSON array of records`);
  return parsed;
}

/**
 * Records of an earlier run in `outDir` for `--resume`: results.json first, then the checkpoint of an interrupted run, which replaces the records of the states it holds (it is newer).
 * @param {string} outDir
 * @returns {object[]} records; empty when neither file exists
 * @throws {UsageError} when a file is not a JSON array
 */
export function readPriorRecords(outDir) {
  const partial = readRecordsFile(path.join(outDir, PARTIAL));
  const newer = new Set(partial.map(stateKey));
  return [...readRecordsFile(path.join(outDir, 'results.json')).filter((r) => !newer.has(stateKey(r))), ...partial];
}
