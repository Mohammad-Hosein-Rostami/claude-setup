// E8, the suite queue (plan section 9, tools only, no claude): two `suite run` of a 20 s command started at once share one
// slot, so the second waits; `suite status` names the holder and the waiter; both exit 0; the two take at least 40 s together.
// The suite state is the temp HOME's (`~/.claude/state/suite`), so the owner's own queue is neither used nor touched.
// Exports the scenario interface (run.mjs): id, title, model, minutes, needsShims, setup(ctx), run(ctx), check(ctx).
import { checkLine, LIMITS } from '../lib/checks.mjs';
import { makeLibrary } from '../lib/repo.mjs';

export const id = 'E8';
export const title = 'suite run queue: two suites in one slot';
export const model = 'none';
export const minutes = LIMITS.defaultScenarioMinutes;
export const needsShims = false;

const SUITE_MS = 20_000;
const STATUS_AFTER_MS = 5_000; // both have started by then: one holds the slot, one waits
const SLOTS = '1';
const HOLDER = /^slot 0: pid \d+/m;
const WAITER = /^waiting: pid \d+/m;
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export function setup(ctx) {
  makeLibrary(ctx);
}

export async function run(ctx) {
  const suite = ctx.tool('suite', 'suite.mjs');
  const args = [suite, 'run', '--repo', ctx.repo, '--slots', SLOTS, '--', process.execPath, '-e', `setTimeout(() => {}, ${SUITE_MS})`];
  const startedMs = Date.now();
  const first = ctx.background('suite-first', process.execPath, args);
  const second = ctx.background('suite-second', process.execPath, args);
  if (!ctx.dry) await pause(STATUS_AFTER_MS);
  ctx.notes.status = ctx.exec(process.execPath, [suite, 'status']);
  ctx.notes.exits = await Promise.all([first.done, second.done]);
  ctx.notes.wallSeconds = (Date.now() - startedMs) / 1000;
}

export function check(ctx) {
  const { status, exits = [], wallSeconds = 0 } = ctx.notes;
  const statusText = status?.stdout ?? '';
  return [
    checkLine('suite status names the holder and a waiter', 'slot 0: pid ..., waiting: pid ...', statusText.replace(/\n/g, ' / ').slice(0, 240) || 'nothing',
      HOLDER.test(statusText) && WAITER.test(statusText)),
    checkLine('both suite runs exit 0', 'exit 0, exit 0', exits.map((exit) => `exit ${exit.code}${exit.timedOut ? ' (timed out)' : ''}`).join(', ') || 'none',
      exits.length === 2 && exits.every((exit) => exit.code === 0)),
    checkLine('the second waited for the first', `wall time at least ${LIMITS.e8MinWallSeconds} s`, `${wallSeconds.toFixed(1)} s`, wallSeconds >= LIMITS.e8MinWallSeconds),
  ];
}
