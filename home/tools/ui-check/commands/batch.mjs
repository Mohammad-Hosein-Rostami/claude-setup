// Purpose: `batch` - many UI states (locale, direction, colour scheme, opened controls) in ONE run: compare for states with `figma`,
// responsive for states with widths. Exports: options, guarded, runState, run. Invariants: one browser for the whole run, a fresh context per state,
// `--jobs N` states at a time (default 4; states with a `figma` part run alone afterwards), a failing state never stops the run, results.json
// keeps the states-file order, one progress line per finished state on stderr; exit 0 all records pass / 1 any fails / 2 usage or setup error.
// Writes <out>/results.json (records are read by `ui-coverage check --results`, see lib/batch-records.mjs) and <out>/summary.md; while it runs
// <out>/results.partial.json holds the finished states, and `--resume` reuses them and the passing states of an earlier results.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, need } from '../lib/args.mjs';
import { compareRecords, errorRecords, exitCodeFor, readPriorRecords, removePartialResults, responsiveRecords, withCloseFailures, writeBatchResults, writePartialResults } from '../lib/batch-records.mjs';
import { parseJobs, partitionStates, progressLine, resumeFilter, runPool } from '../lib/batch-schedule.mjs';
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
  jobs: { type: 'string' },
  resume: { type: 'boolean', default: false },
  project: { type: 'string' }, // default: current directory, then UI_CHECK_PROJECT, then the tool's own node_modules (lib/playwright.mjs)
};

const stateDirName = (state) => `${state.index}-${[state.surface, state.state, state.locale ?? 'default'].join('--').replace(/[^A-Za-z0-9_.-]/g, '-')}`;

/** Viewport width compare uses for a state (the Figma frame width); null when the cache is unreadable, because compareState reports that same error right after. */
function frameWidth(state) {
  try {
    return pageOptions({ url: state.url }, readCache(state.figma.cache).meta, [], {}).width;
  } catch {
    return null;
  }
}

async function compareState(browser, state, dir) {
  const cache = readCache(state.figma.cache);
  const map = state.figma.map ? loadMap(state.figma.map, cache.spec) : null;
  const pageOpts = pageOptions({ url: state.url, 'bypass-csp': false, 'no-autofocus': false }, cache.meta, state.steps, state.context);
  const { root } = state.figma;
  const result = await compareOnce(browser, { pageOpts, root, cache, map, maxDiff: PIXEL.maxDiffPercent, outDir: path.join(dir, 'compare') });
  return compareRecords(state, result, { root, maxDiff: PIXEL.maxDiffPercent, width: pageOpts.width });
}

async function responsiveState(browser, state, dir) {
  const target = { url: state.url, height: RESPONSIVE.height, steps: state.steps, bypassCSP: false, autofocus: true, ...state.context };
  const result = await auditAll(browser, { widths: state.widths, target, outDir: path.join(dir, 'responsive') });
  return responsiveRecords(state, state.widths, result);
}

/** Append a stack to <dir>/<part>.error.txt so a one-line finding does not hide where a programming error came from. */
function keepStack(dir, part, error) {
  fs.appendFileSync(path.join(dir, `${part}.error.txt`), `${error.stack ?? error}\n`);
}

/** Close every context left open by a part; a close that throws (a crashed browser) is kept and returned, never thrown. */
async function closeContexts(browser, dir, part) {
  const messages = [];
  for (const context of browser.contexts()) {
    try {
      await context.close();
    } catch (error) {
      keepStack(dir, part, error);
      messages.push(error.message);
    }
  }
  return messages;
}

/**
 * Run one part (compare or responsive) of a state. An error becomes failing records (its stack goes to `<dir>/<part>.error.txt`) so the
 * run goes on, and the part's contexts are closed either way; a failing close is added to the records as a finding.
 * @param {object} browser Playwright browser
 * @param {{state: object, dir: string, part: 'compare'|'responsive', slots: (number|null)[], job: Function}} work slots = widths the part would report (compare: the frame width)
 * @returns {Promise<object[]>} records of the part
 */
export async function guarded(browser, { state, dir, part, slots, job }) {
  fs.mkdirSync(dir, { recursive: true });
  let records;
  try {
    records = await job(browser, state, dir);
  } catch (error) {
    keepStack(dir, part, error);
    records = errorRecords(state, slots, error, dir);
  }
  return withCloseFailures(records, state, await closeContexts(browser, dir, part));
}

/** A view of the browser that remembers only its own contexts, so closing after a part never closes the contexts of states running in parallel. */
function scopeBrowser(browser) {
  const own = [];
  return { newContext: async (options) => { const context = await browser.newContext(options); own.push(context); return context; }, contexts: () => own };
}

/** Run every part of one state; the state's folder exists before anything runs, so each record's evidence path exists. */
export async function runState(sharedBrowser, state, outRoot) {
  const browser = scopeBrowser(sharedBrowser);
  const dir = path.join(outRoot, stateDirName(state));
  fs.mkdirSync(dir, { recursive: true });
  const records = [];
  if (state.figma) records.push(...await guarded(browser, { state, dir, part: 'compare', slots: [frameWidth(state)], job: compareState }));
  if (state.widths) records.push(...await guarded(browser, { state, dir, part: 'responsive', slots: state.widths, job: responsiveState }));
  return records;
}

/** Remove results from an earlier run in the same --out, so a failed or empty run never leaves stale passes for a consumer. */
function clearStaleResults(outDir) {
  for (const name of ['results.json', 'summary.md', 'results.partial.json']) fs.rmSync(path.join(outDir, name), { force: true });
}

/** Nothing to run: write an empty results.json (and a FAIL summary), say why on stderr, and fail. */
function nothingToRun(outDir, all, only) {
  writeBatchResults(outDir, []);
  const why = all.length === 0 ? 'the states file lists no states' : `--only ${only} matches no surface (known: ${[...new Set(all.map((s) => s.surface))].join(', ')})`;
  console.error(`no states to run: ${why}`);
  return 1;
}

/** Run the states (those without a `figma` part `jobs` at a time, then the others one by one); records come back in `states` order. */
async function runAll(browser, { states, todo, reused, jobs, outDir }) {
  const done = new Map(reused);
  let finished = 0;
  const ordered = () => states.filter((s) => done.has(s.index)).flatMap((s) => done.get(s.index));
  const execute = async (state) => {
    const started = Date.now();
    const records = await runState(browser, state, outDir);
    done.set(state.index, records);
    finished += 1;
    console.error(progressLine({ done: finished, total: todo.length, state, records, ms: Date.now() - started }));
    writePartialResults(outDir, ordered());
  };
  const { parallel, serial } = partitionStates(todo);
  await runPool(parallel, jobs, execute);
  await runPool(serial, 1, execute);
  return ordered();
}

/** Run batch. @param {string[]} argv @returns {Promise<number>} exit code */
export async function run(argv) {
  const values = parse(argv, options);
  need(values, 'states');
  const jobs = parseJobs(values.jobs);
  const outDir = path.resolve(values.out ?? path.join(os.tmpdir(), 'ui-check', 'batch', new Date().toISOString().replace(/[:.]/g, '-')));
  fs.mkdirSync(outDir, { recursive: true });
  const prior = values.resume ? readPriorRecords(outDir) : [];
  if (!values.resume) clearStaleResults(outDir);
  const all = loadStatesFile(values.states);
  const states = selectSurfaces(all, values.only);
  if (states.length === 0) return nothingToRun(outDir, all, values.only);
  const { todo, reused } = values.resume ? resumeFilter(states, prior) : { todo: states, reused: new Map() };
  if (values.resume) console.error(`resume: ${reused.size} of ${states.length} states already pass and are kept, ${todo.length} to run`);
  const browser = todo.length > 0 ? await launch(loadChromium(values.project)) : null;
  try {
    const records = await runAll(browser, { states, todo, reused, jobs, outDir });
    const { summary } = writeBatchResults(outDir, records);
    removePartialResults(outDir);
    const code = exitCodeFor(records);
    console.log(`${code === 0 ? 'PASS' : 'FAIL'} batch - ${records.length} records - summary: ${summary}`);
    return code;
  } finally {
    await browser?.close();
  }
}
