// Purpose: the commands that steer a run (spec 7.8, 19.2): `pause` and `stop` (a run or one step), `takeover` (continue a step by
//   hand) and `tell` (send a running or waiting step a message).
// Exports: TAKEOVER_WAIT_MS, pauseOrStop, takeoverCommand, tellCommand.
// Invariants: a live driver is steered only through control files; a run with no live driver is changed only in its own records
//   (driver.json status, the step journal), so nothing restarts it by itself after a stop; takeover prints the session id every
//   time (a `-p` session is never in the interactive picker) and only once the child is gone, so two writers never share a transcript.
import { readFileSync } from 'node:fs';
import { findUnit } from './job.mjs';
import { queueTell, requestControl, takeoverLines } from './control.mjs';
import { recordEvent } from './events.mjs';
import { driverAlive, readJournal, readJson, readRunJob, writeJournal, writeJson } from './run-store.mjs';
import { NotFound, Refusal, UsageError, openRun } from './cli-common.mjs';
import { resumeCommand } from './cli-run.mjs';
import { runState } from './view.mjs';

/** How long `takeover` waits for the step's child to end (the graceful end takes up to 20 s). */
export const TAKEOVER_WAIT_MS = 60 * 1000;
const WAIT_SLICE_MS = 500;
const ENDED = new Set(['done', 'abandoned']);

function unitOf(paths, stepId, { allowGroup }) {
  const unit = findUnit(readRunJob(paths), stepId);
  if (!unit) throw new NotFound(`no step ${stepId} in run ${paths.runId}`);
  if (unit.kind === 'group' && !allowGroup) throw new UsageError(`${stepId} is a parallel group: name one of its items`);
  return unit;
}

/**
 * `pause` / `stop <run> [<step>]`.
 * @param {'pause' | 'stop'} kind
 */
export function pauseOrStop(kind, { runId, stepId, root, write }) {
  const paths = openRun(root, runId);
  if (stepId) unitOf(paths, stepId, { allowGroup: false });
  if (driverAlive(paths)) {
    requestControl(paths, kind, stepId ?? null);
    write(`asked the driver to ${kind} ${stepId ? `step ${stepId}` : 'every boss'} of ${runId}; it ends the session within about 20 s`);
    return;
  }
  const state = runState(paths);
  if (stepId) throw new Refusal(`run ${runId} is ${state}, no driver runs; nothing to ${kind} in step ${stepId}`);
  if (ENDED.has(state)) throw new Refusal(`run ${runId} is ${state}`);
  const driver = readJson(paths.driver) ?? {};
  const status = kind === 'stop' ? 'stopped' : 'paused';
  writeJson(paths.driver, { ...driver, status, live: {} });
  recordEvent(paths, { event: kind === 'stop' ? 'run-stopped' : 'paused', detail: `marked ${status}; no driver ran` });
  write(`run ${runId} marked ${status} (no driver ran); long-run resume ${runId} continues it`);
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function waitTakenOver(paths, stepId) {
  const deadline = Date.now() + TAKEOVER_WAIT_MS;
  while (Date.now() < deadline) {
    const journal = readJournal(paths, stepId);
    if (journal?.final?.status === 'taken-over' && !journal.running) return journal;
    await sleep(WAIT_SLICE_MS);
  }
  throw new Refusal(`step ${stepId} did not end within ${TAKEOVER_WAIT_MS / 1000} s; try takeover again`);
}

/** `takeover <run> <step>`: pause the step, wait until its child is gone, print the lines that open its session by hand. */
export async function takeoverCommand({ runId, stepId, root, write, platform = process.platform }) {
  const paths = openRun(root, runId);
  if (!stepId) throw new UsageError('takeover needs a step');
  const unit = unitOf(paths, stepId, { allowGroup: false });
  let journal = readJournal(paths, stepId);
  if (!journal?.sessionId) throw new Refusal(`step ${stepId} has no session yet; nothing to take over`);
  if (journal.final?.status === 'done') throw new Refusal(`step ${stepId} is done; use rerun --from to do it again`);
  if (driverAlive(paths) && readJson(paths.driver)?.live?.[stepId]) {
    requestControl(paths, 'takeover', stepId);
    write(`asked the driver to hand over step ${stepId}; waiting for its session to end ...`);
    journal = await waitTakenOver(paths, stepId);
  } else {
    // No driver: a held step shows taken-over; a step cut off mid-start (stale run) keeps no final, so resume continues it at once.
    const final = journal.final ? { status: 'taken-over', reason: 'taken over by the owner' } : null;
    journal = { ...journal, last: 'taken-over', running: false, final };
    writeJournal(paths, stepId, journal);
  }
  recordEvent(paths, { event: 'taken-over', step: stepId, detail: `session ${journal.sessionId}` });
  const run = readJson(paths.run);
  write(platform === 'win32' ? 'Paste this into PowerShell:' : 'Paste these into a terminal:');
  for (const line of takeoverLines({ account: run.account, folder: journal.folder, sessionId: journal.sessionId, model: unit.model, platform })) write(line);
  write(`When you quit that session: long-run resume ${runId} (the boss checks what you did and finishes the step).`);
}

/** `tell <run> <step> "<message>"` / `--message-file <f>` (spec 19.2). */
export async function tellCommand({ runId, stepId, positional, flags, env, root, write }) {
  const paths = openRun(root, runId);
  if (!stepId) throw new UsageError('tell needs a step and a message');
  unitOf(paths, stepId, { allowGroup: false });
  const message = flags['message-file'] ? readFileSync(flags['message-file'], 'utf8') : positional.join(' ');
  const state = runState(paths);
  const journal = readJournal(paths, stepId);
  if (journal?.final?.status === 'done' || ENDED.has(state)) throw new Refusal(`step ${stepId} is done; use rerun --from ${stepId}`);
  queueTell(paths, stepId, message);
  recordEvent(paths, { event: 'told', step: stepId, detail: 'owner message queued' });
  if (driverAlive(paths)) {
    const live = readJson(paths.driver)?.live?.[stepId];
    write(live ? `queued; step ${stepId} gets it at its next safe point (at most 2 min)` : `queued; step ${stepId} gets it at its next start`);
    return;
  }
  write(`queued; resuming run ${runId} so step ${stepId} gets it`);
  await resumeCommand({ runId, flags: { foreground: flags.foreground }, env, root, write });
}
