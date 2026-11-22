// Purpose: `responsive` - layout invariants at several widths; screenshots go to disk, never to the caller.
// Exports: options, focusChecks, auditWidth, auditAll, run. Invariants: exit 0 pass / 1 fail; one fresh page per width.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, need, toNumber } from '../lib/args.mjs';
import { auditInPage } from '../lib/audit.mjs';
import { bidiFieldFindings, bidiPlaceholderFindings, isHint } from '../lib/bidi.mjs';
import { loadChromium, launch, openPage } from '../lib/browser.mjs';
import { walkFocus } from '../lib/focus-audit.mjs';
import { FOCUS_INDICATOR_FAILS, MAX_FOCUS_STOPS, focusIndicatorFindings, focusRingWidthHints, rawI18nKeyFindings, rtlPhysicalAlignFindings, targetSizeHints } from '../lib/rendered-checks.mjs';
import { CONTEXT_OPTIONS, readContextFlags, validateWidths } from '../lib/context.mjs';
import { loadSteps } from '../lib/steps.mjs';
import { writeReport } from '../lib/report.mjs';
import { writeComparableTexts } from '../lib/same-as-default.mjs';
import { RESPONSIVE } from '../lib/tolerances.mjs';
import { ltrRunInRtlHints, parseAllowList, untranslatedHints } from '../lib/translation-hints.mjs';

export const options = {
  url: { type: 'string' },
  widths: { type: 'string', default: RESPONSIVE.widths.join(',') },
  height: { type: 'string', default: String(RESPONSIVE.height) },
  steps: { type: 'string' },
  'bypass-csp': { type: 'boolean', default: false },
  'no-autofocus': { type: 'boolean', default: false },
  ...CONTEXT_OPTIONS,
  'same-in-all-locales': { type: 'string' }, // comma separated terms that are the same in every language (brand names): `untranslated?` ignores them
  out: { type: 'string' },
  project: { type: 'string' }, // default: current directory, then UI_CHECK_PROJECT, then the tool's own node_modules (lib/playwright.mjs)
};

function parseWidths(text) {
  return validateWidths(text.split(',').map((w) => Number(w.trim())), '--widths');
}

/**
 * P3e and M3: the focus walk, then again with forced colours. Reaching the cap is a failing `focus-cap` finding (never a silent stop) unless the
 * state raised it with `maxFocusStops` {count, why}; `focus-indicator` fails only once promoted (FOCUS_INDICATOR_FAILS), and the forced-colours
 * walk is always a hint (a box-shadow ring disappears under forced colours). The measured ring width is one more hint (`focus-ring-width`), never a failure.
 * @returns {Promise<{findings: object[], hints: object[]}>}
 */
export async function focusChecks(page, maxFocusStops, max) {
  const walk = await walkFocus(page, maxFocusStops?.count ?? MAX_FOCUS_STOPS);
  const indicator = focusIndicatorFindings({ focusables: walk.facts }, max);
  const ringWidth = focusRingWidthHints({ focusables: walk.facts });
  const cap = walk.capped ? [{ check: 'focus-cap', element: 'page', detail: `the focus walk reached its cap of ${walk.max} stops before focus left the page; the rest is unchecked: raise it with maxFocusStops {count, why} in the state` }] : [];
  await page.evaluate(() => document.activeElement?.blur());
  await page.emulateMedia({ forcedColors: 'active' });
  const forced = focusIndicatorFindings({ focusables: (await walkFocus(page, walk.max)).facts }, max).map((f) => ({ ...f, check: 'focus-indicator (forced colours)' }));
  return FOCUS_INDICATOR_FAILS ? { findings: [...cap, ...indicator], hints: [...ringWidth, ...forced] } : { findings: cap, hints: [...indicator, ...ringWidth, ...forced] };
}

/**
 * Audit one width on a fresh page; exported for tests.
 * @param {object} browser Playwright browser
 * @param {{url: string, height: number, sameInAllLocales?: string[], saveTexts?: boolean} & Record<string, unknown>} target openPage options other than width (steps, bypassCSP, autofocus, context);
 *   sameInAllLocales = terms `untranslated?` ignores; saveTexts (batch) writes the page's comparable texts beside the screenshot for `same-as-default?`
 * @param {number} width viewport width in CSS px
 * @param {string} outDir where w<width>.png goes
 * @returns {Promise<{width: number, check: string, element: string, detail: string, hint?: true}[]>} layout, bidi-field and bidi-placeholder findings, plus the heuristic
 *   hints (target-size?, raw-i18n-key, rtl-physical-align, focus-indicator, focus-ring-width, bidi-placeholder?, ltr-run-in-rtl?, untranslated?) marked `hint: true`; hints never fail a run
 */
export async function auditWidth(browser, target, width, outDir) {
  const page = await openPage(browser, { ...target, width });
  const audit = { minTarget: RESPONSIVE.minTarget, minText: RESPONSIVE.minText, smallViewport: RESPONSIVE.smallViewport, max: RESPONSIVE.maxFindingsPerCheck };
  const { findings: layout, fields, texts, attributeTexts, blocks, inlineTargets } = await page.evaluate(auditInPage, audit);
  const placeholders = bidiPlaceholderFindings({ fields }, audit.max);
  const findings = [...layout, ...bidiFieldFindings({ fields }, audit.max), ...placeholders.findings];
  const hints = [
    ...targetSizeHints({ targets: inlineTargets }, audit.minTarget, audit.max),
    ...rawI18nKeyFindings({ texts }, audit.max), ...rtlPhysicalAlignFindings({ blocks }, audit.max),
    ...placeholders.hints, ...ltrRunInRtlHints({ texts }, audit.max), ...untranslatedHints({ texts: [...texts, ...attributeTexts] }, target.sameInAllLocales),
  ]; // the older, reliable hints first: report.md shows only the first rows of the hints section
  if (target.saveTexts) writeComparableTexts(outDir, width, texts);
  await page.screenshot({ path: path.join(outDir, `w${width}.png`), fullPage: true, animations: 'disabled', caret: 'hide' });
  // Last, because pressing Tab can fire the page's focus handlers.
  const focus = await focusChecks(page, target.maxFocusStops, audit.max);
  await page.context().close();
  return [...findings, ...focus.findings, ...[...hints, ...focus.hints].map((h) => ({ ...h, hint: true }))].map((f) => ({ width, ...f }));
}

/**
 * Audit every width on an already launched browser and write report.md/json.
 * @param {object} browser Playwright browser
 * @param {{widths: number[], target: object, outDir: string}} job target as accepted by auditWidth
 * @returns {Promise<{pass: boolean, md: string, findings: object[], hints: object[]}>} hints = the heuristic findings, listed in their own section and never failing
 */
export async function auditAll(browser, { widths, target, outDir }) {
  fs.mkdirSync(outDir, { recursive: true });
  const all = [];
  for (const width of widths) all.push(...await auditWidth(browser, target, width, outDir));
  const hints = all.filter((f) => f.hint).map(({ hint, ...rest }) => rest);
  const findings = all.filter((f) => !f.hint);
  const pass = findings.every(isHint); // `bidi-field?` is reported among the findings but never fails the run, and the hints are a section of their own
  const head = ['width', 'check', 'element', 'detail'];
  const row = (f) => [f.width, f.check, f.element, f.detail];
  const md = writeReport(outDir, {
    title: 'ui-check responsive', verdict: pass ? 'PASS' : 'FAIL',
    summary: [`widths: ${widths.join(', ')}`, `findings: ${findings.length}${findings.some(isHint) ? ` (${findings.filter(isHint).length} hints, not failures)` : ''}`, `hints: ${hints.length}`, `screenshots: ${outDir}/w<width>.png`],
    head, rows: findings.map(row), hints: { head, rows: hints.map(row) }, data: { findings, hints },
  });
  return { pass, md, findings, hints };
}

/** Run responsive. @param {string[]} argv @returns {Promise<number>} exit code */
export async function run(argv) {
  const values = parse(argv, options);
  need(values, 'url');
  const widths = parseWidths(values.widths);
  const height = toNumber(values.height, 'height', 200);
  const context = readContextFlags(values);
  const steps = values.steps !== undefined ? loadSteps(values.steps) : [];
  const target = { url: values.url, height, steps, sameInAllLocales: parseAllowList(values['same-in-all-locales']), bypassCSP: values['bypass-csp'], autofocus: !values['no-autofocus'], ...context };
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
