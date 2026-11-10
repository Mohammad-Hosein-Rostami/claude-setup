// Purpose: `columns` - check that body cells line up with their header cells in a table.
// Exports: options, run, alignColumns. Invariants: max left delta <= 1px, max width delta <= 2px; exit 0/1.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, need, toNumber } from '../lib/args.mjs';
import { loadChromium, launch, openPage } from '../lib/browser.mjs';
import { UsageError } from '../lib/errors.mjs';
import { writeReport } from '../lib/report.mjs';

const MAX_LEFT_DELTA = 1;
const MAX_WIDTH_DELTA = 2;

export const options = {
  url: { type: 'string' },
  table: { type: 'string' },
  width: { type: 'string', default: '1440' },
  height: { type: 'string', default: '900' },
  out: { type: 'string' },
  project: { type: 'string', default: process.cwd() },
};

/** Runs in the page: cell {x, w} per row, relative to the table. */
function readRows(selector) {
  const table = document.querySelector(selector);
  if (!table) return null;
  const origin = table.getBoundingClientRect().x;
  const rowSel = table.querySelector('tr') ? 'tr' : '[role="row"]';
  const cellSel = ':scope > th, :scope > td, :scope > [role="columnheader"], :scope > [role="cell"], :scope > [role="gridcell"]';
  return [...table.querySelectorAll(rowSel)].map((row) => [...row.querySelectorAll(cellSel)].map((c) => {
    const r = c.getBoundingClientRect();
    return { x: r.x - origin, w: r.width };
  }));
}

/**
 * Compare each body row to the header row, column by column.
 * @param {{x: number, w: number}[][]} rows first row is the header; rows with another cell count are skipped
 * @returns {{column: number, maxLeft: number, maxWidth: number, pass: boolean}[]}
 */
export function alignColumns(rows) {
  const [header, ...body] = rows;
  const comparable = body.filter((r) => r.length === header.length);
  return header.map((cell, column) => {
    const maxLeft = Math.max(0, ...comparable.map((r) => Math.abs(r[column].x - cell.x)));
    const maxWidth = Math.max(0, ...comparable.map((r) => Math.abs(r[column].w - cell.w)));
    return { column, maxLeft, maxWidth, pass: maxLeft <= MAX_LEFT_DELTA && maxWidth <= MAX_WIDTH_DELTA };
  });
}

/** Run columns. @param {string[]} argv @returns {Promise<number>} exit code */
export async function run(argv) {
  const values = parse(argv, options);
  need(values, 'url', 'table');
  const outDir = values.out ?? path.join(os.tmpdir(), 'ui-check', 'columns', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await launch(loadChromium(values.project));
  try {
    const page = await openPage(browser, { url: values.url, width: toNumber(values.width, 'width', 200), height: toNumber(values.height, 'height', 200) });
    const rows = await page.evaluate(readRows, values.table);
    if (!rows || rows.length < 2) throw new UsageError(`table "${values.table}" not found or has fewer than 2 rows`);
    const columns = alignColumns(rows);
    const failing = columns.filter((c) => !c.pass);
    const md = writeReport(outDir, {
      title: 'ui-check columns', verdict: failing.length === 0 ? 'PASS' : 'FAIL',
      summary: [`columns: ${columns.length}, rows: ${rows.length - 1}`, `limits: left <= ${MAX_LEFT_DELTA}px, width <= ${MAX_WIDTH_DELTA}px`],
      head: ['column', 'max left delta', 'max width delta'], rows: failing.map((c) => [c.column, c.maxLeft.toFixed(1), c.maxWidth.toFixed(1)]), data: { columns },
    });
    console.log(`${failing.length === 0 ? 'PASS' : 'FAIL'} columns - report: ${md}`);
    return failing.length === 0 ? 0 : 1;
  } finally {
    await browser.close();
  }
}
