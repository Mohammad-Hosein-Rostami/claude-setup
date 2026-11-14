// Purpose: build the `batch` result records and write results.json and summary.md.
// Exports: compareRecords, responsiveRecords, errorRecords, withCloseFailures, exitCodeFor, summaryMarkdown, writeBatchResults.
// Invariant: a record is { surface, state, locale, width|null, status: "pass"|"fail", evidence, findings }; another tool
// (`ui-coverage check --results`) reads these exact field names, so never rename them. evidence is the path of that state's report.
import fs from 'node:fs';
import path from 'node:path';
import { isHint } from './bidi.mjs';
import { tableRow } from './report.mjs';

const SUMMARY_HEAD = ['surface', 'state', 'locale', 'width', 'status', 'findings', 'evidence'];
const NONE = '-';

function record(state, width, findings, evidence) {
  return { surface: state.surface, state: state.state, locale: state.locale, width, status: findings.every(isHint) ? 'pass' : 'fail', evidence, findings };
}

/**
 * Records for the compare part of a state (width is null: the viewport is the Figma frame).
 * @param {object} state normalised state
 * @param {{md: string, pixels: object, elementRows: object[]}} result compareOnce result
 * @param {{root: string, maxDiff: number}} gate selector and pixel tolerance used
 * @returns {object[]} one record; findings are the failing element rows plus a pixel finding when the pixel gate failed
 */
export function compareRecords(state, { md, pixels, elementRows }, { root, maxDiff }) {
  const findings = elementRows.map((r) => ({ check: 'element', element: r.element, detail: `${r.prop}: is ${r.is}, should be ${r.should} (delta ${r.delta})` }));
  if (!pixels.pass) {
    const size = pixels.sizeMismatch ? `size mismatch baseline ${pixels.sizeMismatch.baseline.join('x')} vs page ${pixels.sizeMismatch.actual.join('x')}; ` : '';
    findings.push({ check: 'pixel', element: root, detail: `${size}${pixels.diffPercent.toFixed(3)}% of pixels differ (${pixels.diffCount} px), max ${maxDiff}%` });
  }
  return [record(state, null, findings, md)];
}

/**
 * One record per audited width; a width without findings passes.
 * @param {object} state normalised state
 * @param {number[]} widths audited widths
 * @param {{md: string, findings: {width: number, check: string, element: string, detail: string}[]}} result auditAll result
 */
export function responsiveRecords(state, widths, { md, findings }) {
  return widths.map((width) => {
    const own = findings.filter((f) => f.width === width).map(({ check, element, detail }) => ({ check, element, detail }));
    return record(state, width, own, md);
  });
}

/**
 * Failing records for a part of a state that threw (bad step, HTTP error, direction mismatch, missing cache ...).
 * @param {object} state normalised state
 * @param {(number|null)[]} widths one slot per record the part would have produced (null = the compare slot)
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

/** summary.md content: verdict, counts, and one table row per state x width. */
export function summaryMarkdown(records) {
  if (records.length === 0) return '# ui-check batch: FAIL\n- no states ran\n';
  const failed = records.filter((r) => r.status === 'fail').length;
  const rows = records.map((r) => tableRow([r.surface, r.state, r.locale ?? NONE, r.width ?? NONE, r.status, r.findings.length, r.evidence]));
  return [`# ui-check batch: ${failed === 0 ? 'PASS' : 'FAIL'}`, `- records: ${records.length}, failed: ${failed}`, '', tableRow(SUMMARY_HEAD), tableRow(SUMMARY_HEAD.map(() => '---')), ...rows, ''].join('\n');
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
