// Purpose: `responsive` - layout invariants at several widths; screenshots go to disk, never to the caller.
// Exports: options, run. Invariants: exit 0 pass / 1 fail; one fresh page per width.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, need, toNumber } from '../lib/args.mjs';
import { auditInPage } from '../lib/audit.mjs';
import { loadChromium, launch, openPage } from '../lib/browser.mjs';
import { UsageError } from '../lib/errors.mjs';
import { writeReport } from '../lib/report.mjs';
import { RESPONSIVE } from '../lib/tolerances.mjs';

export const options = {
  url: { type: 'string' },
  widths: { type: 'string', default: RESPONSIVE.widths.join(',') },
  height: { type: 'string', default: String(RESPONSIVE.height) },
  out: { type: 'string' },
  project: { type: 'string', default: process.cwd() },
};

function parseWidths(text) {
  const widths = text.split(',').map((w) => Number(w.trim()));
  if (widths.some((w) => !Number.isInteger(w) || w < 200)) throw new UsageError('--widths must be comma-separated integers >= 200');
  return widths;
}

async function auditWidth(browser, url, width, height, outDir) {
  const page = await openPage(browser, { url, width, height });
  const audit = { minTarget: RESPONSIVE.minTarget, minText: RESPONSIVE.minText, smallViewport: RESPONSIVE.smallViewport, max: RESPONSIVE.maxFindingsPerCheck };
  const { findings } = await page.evaluate(auditInPage, audit);
  await page.screenshot({ path: path.join(outDir, `w${width}.png`), fullPage: true, animations: 'disabled', caret: 'hide' });
  await page.context().close();
  return findings.map((f) => ({ width, ...f }));
}

/** Run responsive. @param {string[]} argv @returns {Promise<number>} exit code */
export async function run(argv) {
  const values = parse(argv, options);
  need(values, 'url');
  const widths = parseWidths(values.widths);
  const height = toNumber(values.height, 'height', 200);
  const outDir = values.out ?? path.join(os.tmpdir(), 'ui-check', 'responsive', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await launch(loadChromium(values.project));
  try {
    const findings = [];
    for (const width of widths) findings.push(...await auditWidth(browser, values.url, width, height, outDir));
    const pass = findings.length === 0;
    const md = writeReport(outDir, {
      title: 'ui-check responsive', verdict: pass ? 'PASS' : 'FAIL',
      summary: [`widths: ${widths.join(', ')}`, `findings: ${findings.length}`, `screenshots: ${outDir}/w<width>.png`],
      head: ['width', 'check', 'element', 'detail'], rows: findings.map((f) => [f.width, f.check, f.element, f.detail]), data: { findings },
    });
    console.log(`${pass ? 'PASS' : 'FAIL'} responsive - report: ${md}`);
    return pass ? 0 : 1;
  } finally {
    await browser.close();
  }
}
