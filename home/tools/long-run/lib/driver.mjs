// Purpose: the driver of one run (`long-run drive <run>`, usually detached): takes the run lock, beats, keeps the machine awake,
//   reads the control files every 2 s, runs the graph from where it stopped (new, resumed, answered or re-run), and records how it
//   ended (held, done, abandoned, paused, stopped) with events, the summary and a note to the owner.
// Exports: CONTROL_POLL_MS, BEAT_MS, assertNativeModule, makeSemaphore, drive.
// Invariants: one driver per run (run-store lock); driver.json is written only here; a run-level pause or stop ends every child
//   gracefully, waits until none runs, then exits the process (the journals are already written: the P3 crash path); every timer
//   is cleared before drive() returns; a note that fails is one events.jsonl line, never a run failure.
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import { Command } from '@langchain/langgraph';
import { appendJsonLine, acquireLock, readJson, readRunJob, releaseFolder, releaseLock, writeJson } from './run-store.mjs';
import { units } from './job.mjs';
import { makeControl } from './control.mjs';
import { recordEvent } from './events.mjs';
import { buildGraph, graphConfig, holdEventOf, openHold } from './graph.mjs';
import { startAwake } from './awake.mjs';
import { notify } from './notify.mjs';
import { formatWhen, writeSummary } from './view.mjs';

/** The driver reads the control files this often (spec 7.8). */
export const CONTROL_POLL_MS = 2 * 1000;
/** The heartbeat in driver.json (a beat older than 120 s means the driver is gone). */
export const BEAT_MS = 30 * 1000;
const FINAL_EVENTS = { done: 'step-done', failed: 'step-failed', 'needs-owner': 'needs-owner', blocked: 'blocked', paused: 'paused', 'taken-over': 'taken-over' };

/**
 * Loads better-sqlite3 once, so a Node upgrade that broke the native module is named with its fix (spec 14).
 * @throws {Error} "run scripts/install.sh" when the module does not load.
 */
export function assertNativeModule() {
  try {
    const Database = createRequire(import.meta.url)('better-sqlite3');
    new Database(':memory:').close();
  } catch (error) {
    const native = ['ERR_DLOPEN_FAILED', 'MODULE_NOT_FOUND'].includes(error.code) || /NODE_MODULE_VERSION/.test(error.message);
    if (!native) throw error;
    const abi = /NODE_MODULE_VERSION/.test(error.message) ? `built for another Node ABI, this Node ${process.versions.node} needs ${process.versions.modules}` : error.code;
    throw new Error(`the SQLite module does not load (${abi}): run scripts/install.sh in the setup repo (Windows: scripts/install.ps1)`);
  }
}

/** A counting semaphore: at most `size` holders at once, the rest wait in order. */
export function makeSemaphore(size) {
  let free = size;
  const waiting = [];
  return {
    acquire: () => (free > 0 ? (free -= 1, Promise.resolve()) : new Promise((resolve) => { waiting.push(resolve); })),
    release: () => { const next = waiting.shift(); if (next) next(); else free += 1; },
  };
}

function makeLive(paths, base, now) {
  const entries = {};
  const handles = new Map();
  const write = (patch = {}) => {
    Object.assign(base, patch, { beatAt: now().toISOString(), live: entries });
    writeJson(paths.driver, base);
  };
  return {
    handles, write,
    running(unitId, { handle, ...info }) { handles.set(unitId, handle); entries[unitId] = { state: 'running', since: now().toISOString(), ...info }; write(); },
    waiting(unitId, info) { entries[unitId] = { ...info, since: now().toISOString() }; write(); },
    stopped(unitId) { handles.delete(unitId); delete entries[unitId]; write(); },
    runningCount: () => Object.values(entries).filter((entry) => entry.state === 'running').length,
  };
}

function textsFor(job, runId, kind, detail) {
  return { desktop: `${runId}: ${detail}`, phone: `${job.name}: ${kind}` };
}

async function tellOwner(ctx, kind, detail) {
  const failures = await ctx.notifier(textsFor(ctx.job, ctx.runId, kind, detail), { platform: ctx.platform, env: ctx.env });
  for (const failure of failures) appendJsonLine(ctx.paths.events, { t: ctx.now().toISOString(), event: 'notify-failed', detail: failure });
}

function buildContext(paths, deps, run, job) {
  const base = { pid: process.pid, host: hostname(), startedAt: deps.now().toISOString(), status: 'running', hold: null };
  const ctx = {
    ...deps, paths, job, runId: paths.runId, account: run.account, unitIds: units(job).map((unit) => unit.id),
    control: makeControl(paths), semaphore: makeSemaphore(job.maxParallel), live: makeLive(paths, base, deps.now), parked: new Set(),
  };
  ctx.event = (unitId, event, detail, data = {}) => {
    recordEvent(paths, { event, step: unitId, detail, at: deps.now(), data });
    if (event === 'waiting-limit') tellOwner(ctx, `${unitId} waits for the usage limit`, `${unitId} waits for the usage limit, ${detail}`);
  };
  ctx.emit = (unitId, final) => ctx.event(unitId, FINAL_EVENTS[final.status] ?? 'step-failed', final.status === 'failed' ? final.reason ?? '' : final.status === 'needs-owner' ? `question waiting: long-run status ${paths.runId}` : '');
  ctx.park = (unitId) => { ctx.parked.add(unitId); return new Promise(() => {}); }; // never settles: the driver exits (pollControl)
  return ctx;
}

async function endParked(ctx, signal) {
  const status = signal === 'stop' ? 'stopped' : 'paused';
  ctx.live.write({ status });
  recordEvent(ctx.paths, { event: signal === 'stop' ? 'run-stopped' : 'paused', detail: 'every boss ended; long-run resume continues', at: ctx.now() });
  writeSummary(ctx.paths, { nextCommand: `long-run resume ${ctx.runId}`, now: ctx.now() });
  releaseLock(ctx.paths);
  ctx.exit(0);
}

function pollControl(ctx) {
  const signal = ctx.control.runSignal();
  for (const [unitId, handle] of ctx.live.handles) {
    if (signal !== null) handle.end(signal);
    const unitSignal = ctx.control.unitSignal(unitId);
    if (unitSignal !== null) handle.end(unitSignal);
    else if (ctx.control.hasTell(unitId)) handle.endAtSafePoint('tell');
  }
  if (signal !== null && ctx.live.runningCount() === 0 && !ctx.ending) {
    ctx.ending = true;
    endParked(ctx, signal);
  }
}

function takeFile(path) {
  const value = readJson(path);
  rmSync(path, { force: true }); // read once: a later restart of the driver must not apply it again
  return value;
}

async function invokeInput(ctx, app) {
  const rerun = takeFile(ctx.paths.rerun);
  const config = graphConfig(ctx.job, ctx.runId);
  if (rerun) return { input: null, config: { ...config, configurable: { ...rerun.config.configurable } }, event: 'resumed', detail: `re-run from ${rerun.step}` };
  const reply = takeFile(`${ctx.paths.dir}/resume.json`);
  const state = await openHold(app, ctx.runId);
  if (state.fresh) return { input: {}, config, event: 'run-started', detail: `account ${ctx.account}` };
  if (state.hold) return { input: new Command({ resume: reply ?? { action: 'continue', text: null, item: null, id: randomUUID() } }), config, event: 'resumed', detail: reply?.action ?? 'continue' };
  return { input: null, config, event: 'resumed', detail: state.finished ? 'nothing left' : 'continue' };
}

async function finishRun(ctx, app) {
  const state = await openHold(app, ctx.runId);
  if (state.hold) {
    const { hold } = state;
    ctx.live.write({ status: 'held', hold });
    const held = holdEventOf(hold.status);
    if (hold.status === 'guard' || (held && ctx.job.steps.some((entry) => entry.id === hold.stepId && entry.kind === 'group'))) {
      recordEvent(ctx.paths, { event: held ?? 'step-failed', step: hold.stepId, detail: hold.reason ?? '', at: ctx.now() });
    }
    const answer = hold.status === 'needs-owner' ? ' --answer "..."' : '';
    writeSummary(ctx.paths, { nextCommand: `long-run resume ${ctx.runId}${answer}`, now: ctx.now() });
    await tellOwner(ctx, hold.status === 'needs-owner' ? `${hold.stepId} needs your answer` : `${hold.stepId} held (${hold.status})`, `${hold.stepId} held: ${hold.status}`);
    return 'held';
  }
  const abandoned = Object.values(state.values.steps ?? {}).some((outcome) => outcome.status === 'abandoned');
  const status = abandoned ? 'abandoned' : 'done';
  ctx.live.write({ status, hold: null });
  for (const unit of units(ctx.job)) releaseFolder(ctx.paths.root, ctx.runId, unit.cwd);
  releaseFolder(ctx.paths.root, ctx.runId, ctx.job.cwd);
  recordEvent(ctx.paths, { event: abandoned ? 'run-abandoned' : 'run-done', detail: `at ${formatWhen(ctx.now().toISOString())}`, at: ctx.now() });
  writeSummary(ctx.paths, { nextCommand: 'none', now: ctx.now() });
  await tellOwner(ctx, status, `run ${status}`);
  return status;
}

/**
 * Runs the graph of a run until it holds, ends, or is paused or stopped.
 * @param {Record<string, string>} paths runPaths().
 * @param {{env: object, platform: string, now: () => Date, sleep: (ms: number) => Promise<void>, random: () => number,
 *   exit: (code: number) => void, store?: object | null, killAfter?: object, limitsDir?: string, notifier?: Function,
 *   keepAwake?: boolean}} deps stand-ins for tests; `exit` ends the process after a run-level pause or stop.
 * @returns {Promise<string>} `held`, `done` or `abandoned`.
 * @throws {RunBusy} when a live driver holds the run; {JobError} for a run of another runner version.
 */
export async function drive(paths, deps) {
  const job = readRunJob(paths);
  const run = readJson(paths.run);
  acquireLock(paths, deps.now());
  const ctx = buildContext(paths, { notifier: notify, store: null, ...deps }, run, job);
  ctx.live.write();
  const timers = [setInterval(() => ctx.live.write(), BEAT_MS), setInterval(() => pollControl(ctx), CONTROL_POLL_MS)];
  try {
    if (deps.keepAwake) startAwake({ platform: deps.platform });
    const app = buildGraph(ctx);
    const { input, config, event, detail } = await invokeInput(ctx, app);
    recordEvent(paths, { event, detail, at: deps.now() });
    await app.invoke(input, config);
    return await finishRun(ctx, app);
  } finally {
    for (const timer of timers) clearInterval(timer);
    if (!ctx.ending) releaseLock(paths);
  }
}
