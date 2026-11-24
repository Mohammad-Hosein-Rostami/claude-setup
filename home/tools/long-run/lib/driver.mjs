// Purpose: the driver of one run (`long-run drive <run>`, usually detached): takes the run lock, beats, keeps the machine awake,
//   reads the control files every 2 s, runs the graph from where it stopped (new, resumed, answered or re-run), and records how it
//   ended (held, done, abandoned, paused, stopped) with events, the summary and a note to the owner.
// Exports: CONTROL_POLL_MS, BEAT_MS, STOP_SIGNALS, NativeModuleError, assertInstallStamp, assertNativeModule, makeSemaphore,
//   drive.
// Invariants: one driver per run (run-store lock); driver.json is written only here; a run-level pause or stop ends every child
//   gracefully, waits until none runs, then exits the process (the journals are already written: the P3 crash path); SIGTERM,
//   SIGINT and SIGHUP of the driver are a run-level pause (no boss is left running with nobody reading it; status says paused);
//   at the end of a run the worktrees its bosses made are removed when they hold no work, else kept and named in the summary;
//   every timer and signal handler is removed before drive() returns; a note that fails is one events.jsonl line, never a run
//   failure.
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Command, RunControl, isGraphDrained } from '@langchain/langgraph';
import { appendJsonLine, acquireLock, readJournal, readJson, readRunJob, releaseFolder, releaseLock, writeJournal, writeJson } from './run-store.mjs';
import { removeIfEmpty } from './worktrees.mjs';
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
/** The signals that pause the run: every boss is ended cleanly, then the driver exits (a SIGKILL no handler sees: `status` warns). */
export const STOP_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];
const FINAL_EVENTS = { done: 'step-done', failed: 'step-failed', 'needs-owner': 'needs-owner', blocked: 'blocked', paused: 'paused', 'taken-over': 'taken-over' };

/** The install stamp `scripts/install` writes: `<lockfile sha256>:<Node ABI>` of the last install of this tool's dependencies. */
const INSTALL_STAMP = fileURLToPath(new URL('../node_modules/.lock-sha256', import.meta.url));
const INSTALL_FIX = 'run scripts/install.sh in the setup repo (Windows: scripts/install.ps1)';

/** The SQLite module or the install of the tool's dependencies does not fit this Node; the message names the fix. */
export class NativeModuleError extends Error {}

/**
 * Refuses when the tool's dependencies were installed for another Node ABI (audit H19): a Node upgrade rebuilds the native
 * module only on the next install. No stamp, or one from before the ABI was stamped, passes (the module load still checks).
 * @param {{stampPath?: string, abi?: string}} options stand-ins for tests.
 * @throws {NativeModuleError} naming both ABIs and the fix.
 */
export function assertInstallStamp({ stampPath = INSTALL_STAMP, abi = process.versions.modules } = {}) {
  let text;
  try {
    text = readFileSync(stampPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const stamped = text.trim().split(':')[1];
  if (stamped !== undefined && stamped !== abi) {
    throw new NativeModuleError(`the dependencies were installed for Node ABI ${stamped}, this Node ${process.versions.node} has ABI ${abi}: ${INSTALL_FIX}`);
  }
}

/**
 * Checks the install stamp, then loads better-sqlite3 once, so a Node upgrade that broke the native module is named with its
 * fix (spec 14).
 * @throws {NativeModuleError} "run scripts/install.sh" when the stamp is for another ABI or the module does not load.
 */
export function assertNativeModule() {
  assertInstallStamp();
  try {
    const Database = createRequire(import.meta.url)('better-sqlite3');
    new Database(':memory:').close();
  } catch (error) {
    const native = ['ERR_DLOPEN_FAILED', 'MODULE_NOT_FOUND'].includes(error.code) || /NODE_MODULE_VERSION/.test(error.message);
    if (!native) throw error;
    const abi = /NODE_MODULE_VERSION/.test(error.message) ? `built for another Node ABI, this Node ${process.versions.node} needs ${process.versions.modules}` : error.code;
    throw new NativeModuleError(`the SQLite module does not load (${abi}): ${INSTALL_FIX}`);
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
  const files = makeControl(paths);
  const ctx = {
    ...deps, paths, job, runId: paths.runId, account: run.account, unitIds: units(job).map((unit) => unit.id),
    semaphore: makeSemaphore(job.maxParallel), live: makeLive(paths, base, deps.now), parked: new Set(),
    signalled: null, runControl: new RunControl(),
  };
  // A signal of the driver counts as the owner's run-level pause, read where the PAUSE file is read.
  ctx.control = { ...files, runSignal: () => (ctx.signalled ? 'pause' : files.runSignal()) };
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
  const why = ctx.signalled ? `the driver got ${ctx.signalled}; ` : '';
  recordEvent(ctx.paths, { event: signal === 'stop' ? 'run-stopped' : 'paused', detail: `${why}every boss ended; long-run resume continues`, at: ctx.now() });
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

/** Handlers that turn a stop signal of the driver into a run-level pause; @returns {() => void} removes them. */
function onStopSignals(ctx) {
  const handler = (name) => {
    if (ctx.signalled) return; // the first signal already started the clean end
    ctx.signalled = name;
    ctx.runControl.requestDrain(name);
    pollControl(ctx);
  };
  for (const name of STOP_SIGNALS) process.on(name, handler);
  return () => { for (const name of STOP_SIGNALS) process.off(name, handler); };
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

/** End of run (audit Job A5): each worktree a step made is removed when it holds no work of its own, else kept; the journal says which. */
function cleanWorktrees(ctx) {
  for (const unit of units(ctx.job)) {
    const journal = readJournal(ctx.paths, unit.id);
    if (!journal?.worktrees?.length) continue;
    const worktrees = journal.worktrees.map((one) => ({ ...one, cleanup: one.cleanup === 'removed' ? one.cleanup : removeIfEmpty(one, journal.folder) }));
    writeJournal(ctx.paths, unit.id, { ...journal, worktrees });
  }
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
  cleanWorktrees(ctx);
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
 * @returns {Promise<string>} `held`, `done` or `abandoned` (`paused` only when `exit` returns, as a stand-in may).
 * @throws {RunBusy} when a live driver holds the run; {JobError} for a run of another runner version.
 */
export async function drive(paths, deps) {
  const job = readRunJob(paths);
  const run = readJson(paths.run);
  acquireLock(paths, deps.now());
  const ctx = buildContext(paths, { notifier: notify, store: null, ...deps }, run, job);
  ctx.live.write();
  const timers = [setInterval(() => ctx.live.write(), BEAT_MS), setInterval(() => pollControl(ctx), CONTROL_POLL_MS)];
  const removeHandlers = onStopSignals(ctx);
  try {
    if (deps.keepAwake) startAwake({ platform: deps.platform });
    const app = buildGraph(ctx);
    const { input, config, event, detail } = await invokeInput(ctx, app);
    recordEvent(paths, { event, detail, at: deps.now() });
    try {
      await app.invoke(input, { ...config, control: ctx.runControl });
    } catch (error) {
      if (!isGraphDrained(error)) throw error;
      // Drained between two nodes after a signal: the checkpoint is saved and no boss runs, so the pause ends here.
      if (!ctx.ending) {
        ctx.ending = true;
        await endParked(ctx, 'pause');
      }
      return 'paused';
    }
    return await finishRun(ctx, app);
  } finally {
    removeHandlers();
    for (const timer of timers) clearInterval(timer);
    if (!ctx.ending) releaseLock(paths);
  }
}
