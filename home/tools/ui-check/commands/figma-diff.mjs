// Purpose: `figma-diff` - for every state with a `figma` part, list the built parts and texts Figma does not have, the Figma texts and
// drawings the build does not have, and the texts worded differently, each classed fix / keep / ask the owner. The pixel gate checks
// only mapped nodes; this is the check for what the map does not cover.
// Exports: options, diffState, run. Invariants: Figma is read only from the local cache (spec.json; hidden layers are already left out
// by flattenSpec); one browser for the run, a fresh context per state; a state that cannot be opened is recorded with its error and the
// run goes on; exit 0 no open row (only `keep` rows or none) / 1 any `fix` or `ask the owner` row / 2 usage or setup error, also when
// any state could not be compared.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, need } from '../lib/args.mjs';
import { loadChromium, launch, openPage } from '../lib/browser.mjs';
import { readCache } from '../lib/cache.mjs';
import { UsageError } from '../lib/errors.mjs';
import { CLASSES, classifyRow, diffUnits, figmaUnits, parseDecisions } from '../lib/figma-diff.mjs';
import { collectBuiltInPage } from '../lib/figma-diff-page.mjs';
import { writeReport } from '../lib/report.mjs';
import { loadStatesFile, selectSurfaces } from '../lib/states.mjs';
import { pageOptions } from './compare.mjs';

export const options = {
  states: { type: 'string' },
  only: { type: 'string' },
  out: { type: 'string' },
  decisions: { type: 'string' }, // owner decisions that class matching rows (README "figma-diff")
  project: { type: 'string' }, // default: current directory, then UI_CHECK_PROJECT, then the tool's own node_modules (lib/playwright.mjs)
};

const MAX_CELL_CHARS = 60; // report.md cells only; report.json keeps the full texts
const short = (text) => (text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS - 1)}…` : text);
const label = (state) => `${state.surface} ${state.state} ${state.locale ?? '-'}`;

function loadDecisions(file) {
  if (file === undefined) return [];
  try {
    return parseDecisions(JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')));
  } catch (error) {
    // an unreadable file, bad JSON and a schema mistake are all caller mistakes (exit 2)
    throw new UsageError(`--decisions ${file}: ${error.message}`);
  }
}

/**
 * Compare one state's built page with its cached Figma frame.
 * @param {object} browser Playwright browser
 * @param {object} state a loadStatesFile state with a `figma` part
 * @param {object[]} decisions parseDecisions output
 * @returns {Promise<{frame: string, ignored: object, cutTexts: number, rows: object[]}>} rows carry `class` and `reason`
 * @throws {UsageError} when the cache is missing, the page cannot be opened or the root selector matches nothing
 */
export async function diffState(browser, state, decisions) {
  const cache = readCache(state.figma.cache);
  const figma = figmaUnits(cache.spec);
  const pageOpts = pageOptions({ url: state.url, 'bypass-csp': state.bypassCSP === true, 'no-autofocus': false }, cache.meta, state.steps, state.context);
  const page = await openPage(browser, pageOpts);
  try {
    const { rootFound, units } = await page.evaluate(collectBuiltInPage, { rootSelector: state.figma.root });
    if (!rootFound) throw new UsageError(`root selector matched nothing: ${state.figma.root}`);
    const rows = diffUnits(figma, units).map((row) => ({ ...row, ...classifyRow(row, state.surface, decisions) }));
    return { frame: cache.spec.root.id, ignored: figma.ignored, cutTexts: figma.cutTexts, rows };
  } finally {
    await page.context().close();
  }
}

async function diffAll(browser, states, decisions) {
  const results = [];
  for (const state of states) {
    const base = { surface: state.surface, state: state.state, locale: state.locale, url: state.url };
    try {
      results.push({ ...base, ...await diffState(browser, state, decisions) });
    } catch (error) {
      if (!(error instanceof UsageError)) console.error(error.stack ?? error); // a programming error keeps its stack
      results.push({ ...base, error: error.message.split('\n')[0], rows: [] });
    }
  }
  return results;
}

const allRows = (results) => results.flatMap((r) => r.rows.map((row) => ({ ...row, label: label(r) })));
const countClass = (rows, cls) => rows.filter((row) => row.class === cls).length;

function summaryLines(results, skipped, rows) {
  const sum = (pick) => results.reduce((n, r) => n + (pick(r) ?? 0), 0);
  const lines = [
    `states compared: ${results.length - results.filter((r) => r.error).length} of ${results.length} with a figma part (${skipped} without one skipped)`,
    `rows: ${rows.length} (${Object.values(CLASSES).map((cls) => `${cls} ${countClass(rows, cls)}`).join(', ')})`,
    `ignored in Figma: hidden layers (not in spec.json), ${sum((r) => r.ignored?.outsideFrame)} layers outside the frame, ${sum((r) => r.ignored?.deviceChrome)} device status-bar layers`,
  ];
  const cut = sum((r) => r.cutTexts);
  if (cut > 0) lines.push(`warning: ${cut} Figma texts are exactly 80 characters: the cache may predate full texts (re-pull with figma-pull --refresh)`);
  for (const r of results.filter((x) => x.error)) lines.push(`error: ${label(r)}: ${r.error}`);
  return lines;
}

function printRows(rows) {
  for (const row of rows) {
    const where = row.type === 'extra' ? row.where : `node ${row.node}`;
    console.log(`${row.class} | ${row.label} | ${row.type}${row.difference ? ` (${row.difference})` : ''} ${row.part} | figma "${row.figma}" | build "${row.build}" | ${where}`);
  }
}

function report(outDir, results, skipped) {
  const rows = allRows(results);
  const open = rows.filter((row) => row.class !== CLASSES.keep).length;
  const errors = results.filter((r) => r.error).length;
  const md = writeReport(outDir, {
    title: 'ui-check figma-diff', verdict: open === 0 && errors === 0 ? 'PASS' : 'FAIL', summary: summaryLines(results, skipped, rows),
    head: ['state', 'type', 'part', 'figma', 'build', 'class'],
    rows: rows.map((row) => [row.label, row.difference ? `${row.type} (${row.difference})` : row.type, row.part, short(row.figma), short(row.build), row.class]),
    data: { states: results },
  });
  printRows(rows);
  console.log(`${open === 0 && errors === 0 ? 'PASS' : 'FAIL'} figma-diff - ${rows.length} rows, ${open} open, ${errors} states not compared - report: ${md}`);
  if (errors > 0) return 2;
  return open > 0 ? 1 : 0;
}

/** Run figma-diff. @param {string[]} argv @returns {Promise<number>} exit code */
export async function run(argv) {
  const values = parse(argv, options);
  need(values, 'states');
  const decisions = loadDecisions(values.decisions);
  const selected = selectSurfaces(loadStatesFile(values.states), values.only);
  const states = selected.filter((s) => s.figma);
  if (states.length === 0) throw new UsageError(`no state with a figma part to compare${values.only ? ` (--only ${values.only})` : ''}`);
  const outDir = path.resolve(values.out ?? path.join(os.tmpdir(), 'ui-check', 'figma-diff', new Date().toISOString().replace(/[:.]/g, '-')));
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await launch(loadChromium(values.project));
  try {
    return report(outDir, await diffAll(browser, states, decisions), selected.length - states.length);
  } finally {
    await browser.close();
  }
}
