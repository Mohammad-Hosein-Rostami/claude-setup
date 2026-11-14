// Purpose: write report.json and a report.md capped at 40 lines.
// Exports: writeReport, tableRow (one escaped markdown table row), MAX_REPORT_LINES. Invariant: markdown never exceeds the cap; full rows stay in report.json.
import fs from 'node:fs';
import path from 'node:path';

export const MAX_REPORT_LINES = 40;

const cell = (value) => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
const row = (cells) => `| ${cells.map(cell).join(' | ')} |`;
export const tableRow = row;

function buildMarkdown({ title, verdict, summary, head, rows }) {
  const lines = [`# ${title}: ${verdict}`, ...summary.map((s) => `- ${s}`)];
  if (rows.length === 0) return lines;
  lines.push('', row(head), row(head.map(() => '---')));
  const room = MAX_REPORT_LINES - lines.length;
  if (rows.length <= room) return [...lines, ...rows.map(row)];
  const shown = Math.max(room - 1, 0);
  return [...lines, ...rows.slice(0, shown).map(row), `... ${rows.length - shown} more rows in report.json`];
}

/**
 * Write report.json and report.md into outDir.
 * @param {string} outDir existing directory
 * @param {{title: string, verdict: 'PASS'|'FAIL', summary: string[], head: string[], rows: string[][], data?: object}} report
 * @returns {string} path of report.md
 */
export function writeReport(outDir, report) {
  const mdPath = path.join(outDir, 'report.md');
  const md = buildMarkdown({ ...report, summary: report.summary.slice(0, 12) });
  fs.writeFileSync(mdPath, `${md.join('\n')}\n`);
  const json = { title: report.title, verdict: report.verdict, summary: report.summary, head: report.head, rows: report.rows, ...report.data };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(json, null, 2));
  return mdPath;
}
