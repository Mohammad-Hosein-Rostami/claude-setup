// Purpose: `responsive` - layout invariants at several widths; screenshots go to disk, never to the caller.
// Exports: options, auditWidth, auditAll, run. Invariants: exit 0 pass / 1 fail; one fresh page per width.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, need, toNumber } from '../lib/args.mjs';
import { auditInPage } from '../lib/audit.mjs';
import { bidiFieldFindings } from '../lib/bidi.mjs';
import { loadChromium, launch, openPage } from '../lib/browser.mjs';
import { CONTEXT_OPTIONS, readContextFlags, validateWidths } from '../lib/context.mjs';
import { loadSteps } from '../lib/steps.mjs';
import { writeReport } from '../lib/report.mjs';
import { RESPONSIVE } from '../lib/tolerances.mjs';

export const options = {
  url: { type: 'string' },
  widths: { type: 'string', default: RESPONSIVE.widths.join(',') },
  height: { type: 'string', default: String(RESPONSIVE.height) },
  steps: { type: 'string' },
  'bypass-csp': { type: 'boolean', default: false },
  'no-autofocus': { type: 'boolean', default: false },
  ...CONTEXT_OPTIONS,
  out: { type: 'string' },
  project: { type: 'string', default: process.cwd() },
};

function parseWidths(text) {
  return validateWidths(text.split(',').map((w) => Number(w.trim())), '--widths');
}

/**
 * Audit one width on a fresh page; exported for tests.
 * @param {object} browser Playwright browser
 * @param {{url: string, height: number} & Record<string, unknown>} target openPage options other than width (steps, bypassCSP, autofocus, context)
 * @param {number} width viewport width in CSS px
 * @param {string} outDir where w<width>.png goes
 * @returns {Promise<{width: number, check: string, element: string, detail: string}[]>} layout findings plus bidi-field findings
 */
export async function auditWidth(browser, target, width, outDir) {
  const page = await openPage(browser, { ...target, width });
  const audit = { minTarget: RESPONSIVE.minTarget, minText: RESPONSIVE.minText, smallViewport: RESPONSIVE.smallViewport, max: RESPONSIVE.maxFindingsPerCheck };
  const { findings: layout, docDirection, fields } = await page.evaluate(auditInPage, audit);
  const findings = [...layout, ...bidiFieldFindings({ docDirection, fields }, audit.max)];
  await page.screenshot({ path: path.join(outDir, `w${width}.png`), fullPage: true, animations: 'disabled', caret: 'hide' });
  await page.context().close();
  return findings.map((f) => ({ width, ...f }));
}

/**
 * Audit every width on an already launched browser and write report.md/json.
 * @param {object} browser Playwright browser
 * @param {{widths: number[], target: object, outDir: string}} job target as accepted by auditWidth
 * @returns {Promise<{pass: boolean, md: string, findings: object[]}>}
 */
export async function auditAll(browser, { widths, target, outDir }) {
  fs.mkdirSync(outDir, { recursive: true });
  const findings = [];
  for (const width of widths) findings.push(...await auditWidth(browser, target, width, outDir));
  const pass = findings.length === 0;
  const md = writeReport(outDir, {
    title: 'ui-check responsive', verdict: pass ? 'PASS' : 'FAIL',
    summary: [`widths: ${widths.join(', ')}`, `findings: ${findings.length}`, `screenshots: ${outDir}/w<width>.png`],
    head: ['width', 'check', 'element', 'detail'], rows: findings.map((f) => [f.width, f.check, f.element, f.detail]), data: { findings },
  });
  return { pass, md, findings };
}

/** Run responsive. @param {string[]} argv @returns {Promise<number>} exit code */
export async function run(argv) {
  const values = parse(argv, options);
  need(values, 'url');
  const widths = parseWidths(values.widths);
  const height = toNumber(values.height, 'height', 200);
  const context = readContextFlags(values);
  const steps = values.steps !== undefined ? loadSteps(values.steps) : [];
  const target = { url: values.url, height, steps, bypassCSP: values['bypass-csp'], autofocus: !values['no-autofocus'], ...context };
  const outDir = values.out ?? path.join(os.tmpdir(), 'ui-check', 'responsive', new Date().toISOString().replace(/[:.]/g, '-'));
  const browser = await launch(loadChromium(values.project));
  try {
    const { pass, md } = await auditAll(browser, { widths, target, outDir });
    console.log(`${pass ? 'PASS' : 'FAIL'} responsive - report: ${md}`);
    return pass ? 0 : 1;
  } finally {
    await browser.close();
  }
}
