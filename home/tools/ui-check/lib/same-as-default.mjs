// Purpose: the `same-as-default?` hint of `batch`: for one surface and state run in several locales, a text of 2+ words that reads the same in the first
// locale and in another one. Each responsive run saves its comparable texts beside the screenshot (`texts-w<width>.json`, a plain list of strings; results.json
// stays as it was); after all states ran, the other locales are compared with the first and the hints are added to their report.json, report.md and record.
// Exports: writeComparableTexts, addSameAsDefaultHints, textsFileName. Invariants: idempotent (a second pass, e.g. after `--resume`, replaces the earlier
// `same-as-default?` hints instead of adding to them); a record without a texts file (compare record, error record) is skipped; records are not mutated.
import fs from 'node:fs';
import path from 'node:path';
import { stateKey } from './batch-schedule.mjs';
import { writeReport } from './report.mjs';
import { comparableTexts, sameAsDefaultHints } from './translation-hints.mjs';

const CHECK = 'same-as-default?';
export const textsFileName = (width) => `texts-w${width}.json`;

/** Save the comparable texts of a page next to its report. @param {string} outDir report folder @param {number} width viewport width @param {{text: string, visible?: boolean}[]} texts page facts */
export function writeComparableTexts(outDir, width, texts) {
  fs.writeFileSync(path.join(outDir, textsFileName(width)), JSON.stringify(comparableTexts(texts)));
}

const reportDir = (record) => (path.basename(record.evidence ?? '') === 'report.md' ? path.dirname(record.evidence) : null);

function readTexts(record) {
  const dir = reportDir(record);
  const file = dir && path.join(dir, textsFileName(record.width));
  return file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

/** Replace the `same-as-default?` hints of one width in report.json and redraw report.md; returns the number of hints that width now has. */
function replaceHints(dir, width, added) {
  const jsonPath = path.join(dir, 'report.json');
  const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const hints = [...report.hints.filter((h) => !(h.check === CHECK && h.width === width)), ...added.map((h) => ({ width, ...h }))];
  const summary = report.summary.map((line) => (/^hints: \d+$/.test(line) ? `hints: ${hints.length}` : line));
  const rowOf = (f) => [f.width, f.check, f.element, f.detail];
  writeReport(dir, { title: report.title, verdict: report.verdict, summary, head: report.head, rows: report.rows, hints: { head: report.head, rows: hints.map(rowOf) }, data: { findings: report.findings, hints } });
  return hints.filter((h) => h.width === width).length;
}

/**
 * Add `same-as-default?` hints to the records of every locale after the first one of each surface, state and width.
 * @param {object[]} records batch records in states-file order
 * @param {object[]} states normalised states (their `sameInAllLocales` is the allow-list of the compared state)
 * @returns {object[]} the records, with `hints` updated for the compared ones
 */
export function addSameAsDefaultHints(records, states) {
  const allowOf = new Map(states.map((s) => [stateKey(s), s.sameInAllLocales]));
  const reference = new Map(); // surface, state, width -> {record, texts} of the first locale that has a texts file
  return records.map((record) => {
    const texts = record.locale === null ? null : readTexts(record);
    if (texts === null) return record;
    const group = JSON.stringify([record.surface, record.state, record.width]);
    if (!reference.has(group)) {
      reference.set(group, { record, texts });
      return record;
    }
    const first = reference.get(group);
    if (first.record.locale === record.locale) return record;
    const added = sameAsDefaultHints({ reference: first.texts, other: texts, referenceLocale: first.record.locale, locale: record.locale }, allowOf.get(stateKey(record)));
    return { ...record, hints: replaceHints(reportDir(record), record.width, added) };
  });
}
