// Purpose: `batch` - many UI states (locale, direction, colour scheme, opened controls) in ONE run: compare for states with `figma`,
// responsive for states with widths. Exports: options, run. Invariants: one browser for the whole run, a fresh context per state,
// sequential, a failing state never stops the run; exit 0 all records pass / 1 any fails / 2 usage or setup error.
// Writes <out>/results.json (records are read by `ui-coverage check --results`, see lib/batch-records.mjs) and <out>/summary.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, need } from '../lib/args.mjs';
import { compareRecords, errorRecords, exitCodeFor, responsiveRecords, writeBatchResults } from '../lib/batch-records.mjs';
import { loadChromium, launch } from '../lib/browser.mjs';
import { readCache } from '../lib/cache.mjs';
import { loadStatesFile, selectSurfaces } from '../lib/states.mjs';
import { PIXEL, RESPONSIVE } from '../lib/tolerances.mjs';
import { compareOnce, loadMap, pageOptions } from './compare.mjs';
import { auditAll } from './responsive.mjs';

export const options = {
  states: { type: 'string' },
  only: { type: 'string' },
  out: { type: 'string' },
  project: { type: 'string', default: process.cwd() },
};

const stateDirName = (state) => `${state.index}-${[state.surface, state.state, state.locale ?? 'default'].join('--').replace(/[^A-Za-z0-9_.-]/g, '-')}`;

async function compareState(browser, state, dir) {
  const cache = readCache(state.figma.cache);
  const map = state.figma.map ? loadMap(state.figma.map, cache.spec) : null;
  const pageOpts = pageOptions({ url: state.url, 'bypass-csp': false, 'no-autofocus': false }, cache.meta, state.steps, state.context);
  const { root } = state.figma;
  const result = await compareOnce(browser, { pageOpts, root, cache, map, maxDiff: PIXEL.maxDiffPercent, outDir: path.join(dir, 'compare') });
  return compareRecords(state, result, { root, maxDiff: PIXEL.maxDiffPercent });
}

async function responsiveState(browser, state, dir) {
  const target = { url: state.url, height: RESPONSIVE.height, steps: state.steps, bypassCSP: false, autofocus: true, ...state.context };
  const result = await auditAll(browser, { widths: state.widths, target, outDir: path.join(dir, 'responsive') });
  return responsiveRecords(state, state.widths, result);
}

/** Run one part of a state; any error becomes failing records so the run goes on, and the state's contexts are closed either way. */
async function guarded(browser, { state, dir, slots, job }) {
  try {
    return await job(browser, state, dir);
  } catch (error) {
    return errorRecords(state, slots, error, dir);
  } finally {
    for (const context of browser.contexts()) await context.close();
  }
}

async function runState(browser, state, outRoot) {
  const dir = path.join(outRoot, stateDirName(state));
  const records = [];
  if (state.figma) records.push(...await guarded(browser, { state, dir, slots: [null], job: compareState }));
  if (state.widths) records.push(...await guarded(browser, { state, dir, slots: state.widths, job: responsiveState }));
  return records;
}

/** Run batch. @param {string[]} argv @returns {Promise<number>} exit code */
export async function run(argv) {
  const values = parse(argv, options);
  need(values, 'states');
  const states = selectSurfaces(loadStatesFile(values.states), values.only);
  const outDir = path.resolve(values.out ?? path.join(os.tmpdir(), 'ui-check', 'batch', new Date().toISOString().replace(/[:.]/g, '-')));
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await launch(loadChromium(values.project));
  try {
    const records = [];
    for (const state of states) records.push(...await runState(browser, state, outDir));
    const { summary } = writeBatchResults(outDir, records);
    const code = exitCodeFor(records);
    console.log(`${code === 0 ? 'PASS' : 'FAIL'} batch - ${records.length} records - summary: ${summary}`);
    return code;
  } finally {
    await browser.close();
  }
}
