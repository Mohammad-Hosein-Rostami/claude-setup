// Purpose: `first-paint` - for every state of a states file, cold-load its URL twice (all scripts held, then all fonts held) and
// check the screens a visitor sees in order: blank and/or one neutral loader, then the final screen, nothing in between, and no
// layout shift after the first visible frame (async-ui-states item 8; the frame kinds and the neutral loader are defined in
// lib/first-paint.mjs). Exports: options, run.
// Invariants: one browser for the run (deterministic rasteriser), a fresh context per pass, DEFAULT_JOBS states at a time; a state that
// throws is reported as an error and the run goes on; states with the same url, viewport and context are measured once. A state's
// url, locale, colour scheme, storage, cookies and expectDir are used; its steps are NOT run (first paint is the cold load, steps
// come after it) and the report says so. Viewport: the Figma frame size for a state with `figma`, else its first width x 900.
// Exit 0 every pass of every state passes, 1 a pass fails (or nothing to run), 2 usage/setup error or a state that could not be
// measured while none failed. Writes <out>/report.md, <out>/report.json and <out>/<state>/<hold>.json (the frame records).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, need } from '../lib/args.mjs';
import { DEFAULT_JOBS, runPool } from '../lib/batch-schedule.mjs';
import { launch, loadChromium } from '../lib/browser.mjs';
import { readCache } from '../lib/cache.mjs';
import { HOLD_MS, HOLDS, measurePass } from '../lib/first-paint.mjs';
import { writeReport } from '../lib/report.mjs';
import { loadStatesFile, selectSurfaces } from '../lib/states.mjs';
import { RESPONSIVE } from '../lib/tolerances.mjs';

export const options = {
  states: { type: 'string' },
  only: { type: 'string' },
  out: { type: 'string' },
  project: { type: 'string' }, // default: current directory, then UI_CHECK_PROJECT, then the tool's own node_modules (lib/playwright.mjs)
};

const EXIT_FAIL = 1;
const EXIT_UNMEASURED = 2;
const NONE = '-';
const stateDirName = (state) => `${state.index}-${[state.surface, state.state, state.locale ?? 'default'].join('--').replace(/[^A-Za-z0-9_.-]/g, '-')}`;

/** The page a state is measured on: url, viewport and the states-file context (steps are left out on purpose). */
function targetOf(state) {
  const { width, height } = state.figma ? readCache(state.figma.cache).meta : { width: state.widths[0], height: RESPONSIVE.height };
  return { url: state.url, width: Math.ceil(width), height: Math.ceil(height), ...state.context };
}

/** Both holds of one target, in order; an error in one hold is kept as that hold's result and the next hold still runs. */
async function measureTarget(browser, target) {
  const passes = [];
  for (const hold of Object.keys(HOLDS)) {
    try {
      passes.push(await measurePass(browser, target, hold));
    } catch (error) {
      passes.push({ hold, ok: false, error: error.message, screens: [], violations: [] });
    }
  }
  return passes;
}

/** Status of a state from its passes: fail beats error beats pass. */
function statusOf(passes) {
  if (passes.some((p) => !p.ok && !p.error)) return 'fail';
  return passes.some((p) => p.error) ? 'error' : 'pass';
}

function writeFrames(dir, passes) {
  fs.mkdirSync(dir, { recursive: true });
  for (const { hold, frames, shifts, heldFiles } of passes) {
    if (frames) fs.writeFileSync(path.join(dir, `${hold}.json`), JSON.stringify({ heldFiles, frames, shifts }, null, 1));
  }
}

/** Measure every state (DEFAULT_JOBS at a time, a target once); results keep the states-file order. */
async function measureAll(browser, states, outDir) {
  const byTarget = new Map();
  const results = new Map();
  await runPool(states, DEFAULT_JOBS, async (state) => {
    let target;
    try {
      target = targetOf(state);
    } catch (error) {
      results.set(state.index, { state, status: 'error', passes: [{ hold: NONE, ok: false, error: error.message, screens: [], violations: [] }] });
      return;
    }
    const key = JSON.stringify(target);
    if (!byTarget.has(key)) byTarget.set(key, measureTarget(browser, target));
    const passes = await byTarget.get(key);
    writeFrames(path.join(outDir, stateDirName(state)), passes);
    results.set(state.index, { state, target, status: statusOf(passes), passes });
  });
  return states.map((state) => results.get(state.index));
}

const reasonOf = (pass) => pass.error ?? (pass.violations.join('; ') || NONE);

function reportRows(results) {
  return results.flatMap(({ state, passes }) => passes.map((pass) => [
    state.surface, state.state, state.locale ?? NONE, pass.hold, pass.error ? 'error' : pass.ok ? 'pass' : 'fail', pass.screens.join(' > ') || NONE, reasonOf(pass),
  ]));
}

/** One stdout line per state: verdict, names, and per hold the screens (pass) or the reason (fail, error). */
function printState({ state, status, passes }) {
  const steps = state.steps.length > 0 ? ' (steps not run)' : '';
  const parts = passes.map((pass) => `${pass.hold}: ${pass.ok ? pass.screens.join(' > ') : reasonOf(pass)}`);
  console.log(`${status.toUpperCase()} ${state.surface} ${state.state} ${state.locale ?? NONE}${steps} - ${parts.join(' | ')}`);
}

function exitCodeOf(results) {
  if (results.some((r) => r.status === 'fail')) return EXIT_FAIL;
  return results.some((r) => r.status === 'error') ? EXIT_UNMEASURED : 0;
}

function writeRunReport(outDir, results, code) {
  const count = (status) => results.filter((r) => r.status === status).length;
  const skippedSteps = results.filter((r) => r.state.steps.length > 0).length;
  return writeReport(outDir, {
    title: 'ui-check first-paint', verdict: code === 0 ? 'PASS' : 'FAIL',
    summary: [
      `${results.length} states: ${count('pass')} pass, ${count('fail')} fail, ${count('error')} could not be measured`,
      `holds: ${Object.keys(HOLDS).join(', ')}, each held ${HOLD_MS} ms after navigation, then released`,
      'rule: blank and/or one neutral loader, then the final screen, nothing in between; no layout shift after the first visible frame',
      ...(skippedSteps > 0 ? [`${skippedSteps} states have steps; they were not run (first paint is the cold load)`] : []),
    ],
    head: ['surface', 'state', 'locale', 'hold', 'result', 'screens in order', 'reason'],
    rows: reportRows(results),
    data: { results: results.map(({ state, target, status, passes }) => ({ surface: state.surface, state: state.state, locale: state.locale, url: state.url, target, status, passes: passes.map(({ frames, shifts, ...rest }) => rest) })) },
  });
}

/** Run first-paint. @param {string[]} argv @returns {Promise<number>} exit code @throws {UsageError} on bad flags or a bad states file */
export async function run(argv) {
  const values = parse(argv, options);
  need(values, 'states');
  const all = loadStatesFile(values.states);
  const states = selectSurfaces(all, values.only);
  if (states.length === 0) {
    console.error(`no states to run: ${all.length === 0 ? 'the states file lists no states' : `--only ${values.only} matches no surface`}`);
    return EXIT_FAIL;
  }
  const outDir = path.resolve(values.out ?? path.join(os.tmpdir(), 'ui-check', 'first-paint', new Date().toISOString().replace(/[:.]/g, '-')));
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await launch(loadChromium(values.project));
  try {
    const results = await measureAll(browser, states, outDir);
    results.forEach(printState);
    const code = exitCodeOf(results);
    const md = writeRunReport(outDir, results, code);
    console.log(`${code === 0 ? 'PASS' : 'FAIL'} first-paint - ${states.length} states - report: ${md}`);
    return code;
  } finally {
    await browser.close();
  }
}
