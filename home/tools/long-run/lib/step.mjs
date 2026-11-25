// Purpose: one step or parallel item from its first start to its outcome (spec 7.2): the journal per visit, the outcome table
//   (retry with backoff, wait for a limit reset, hold, fail), the loop guards and the waits that the owner's control files cut short.
// Exports: backoffMs, runUnit, finalOf.
// Invariants: an outcome is returned, never thrown; waits are wall-clock targets saved in the journal and read in 30 s slices, so a
//   sleep or a crash loses only the wait already spent; a limit wait, a pause, a stop, a takeover or an owner message is never an
//   attempt; `maxAttempts` counts failed attempts and `maxStarts` every start (loop guards of owner decision O2, not budgets); a
//   run-level pause or stop parks the unit after its journal is written (the driver then exits: spec 7.2, the P3 crash path); an
//   unfinished unit takes the account run.json names at each runUnit (so `resume --account` switches it) and then drops a limit
//   wait recorded under the old account.
import { claimLane } from '../../git-tidy/lib/lane-pool.mjs';
import { openRepo } from '../../git-tidy/lib/repo.mjs';
import { limitWaitUntil } from './limit-time.mjs';
import { isPidAlive, readJournal, readJson, writeJournal } from './run-store.mjs';
import { endOrphan } from './claude-run.mjs';
import { AccountRefusal } from './run-account.mjs';
import { startOnce } from './step-start.mjs';

const SLICE_MS = 30 * 1000;
const JITTER = 0.2;
const MS_PER_SECOND = 1000;
const RETRIED = new Set(['max-turns', 'timeout', 'crash', 'no-verdict', 'check-failed']);

/**
 * The wait before failed attempt `attempt` + 1: first x factor^(attempt-1), capped, with +-20% jitter.
 * @param {{firstDelaySeconds: number, factor: number, maxDelaySeconds: number}} retry the job's retry settings.
 * @param {number} attempt the failed attempts so far (1 or more).
 * @param {() => number} random a number in [0, 1).
 * @returns {number} milliseconds.
 */
export function backoffMs(retry, attempt, random = Math.random) {
  const base = Math.min(retry.firstDelaySeconds * retry.factor ** (attempt - 1), retry.maxDelaySeconds);
  return Math.round(base * (1 + (random() * 2 - 1) * JITTER) * MS_PER_SECOND);
}

/** The step outcome the graph gets for a final verdict. */
export function finalOf(verdict, journal) {
  switch (verdict.outcome) {
    case 'done': return { status: 'done' };
    case 'blocked': return { status: 'blocked', reason: verdict.reason };
    case 'needs-owner': return { status: 'needs-owner', question: verdict.question };
    case 'auth': return { status: 'failed', reason: `login missing or refused for ${journal.account}` };
    case 'stopped': return { status: 'failed', reason: 'stopped by the owner' };
    case 'paused': return { status: 'paused', reason: 'paused by the owner' };
    case 'taken-over': return { status: 'taken-over', reason: 'taken over by the owner' };
    case 'guard': return { status: 'failed', reason: verdict.reason };
    default: throw new Error(`not a final outcome: ${verdict.outcome}`);
  }
}

/** A journal for a new visit; the worktrees the step made on earlier visits stay listed (they are on disk, not in a session). */
function newJournal(ctx, unit, visit, saved) {
  const history = saved ? [...saved.history, { visit: saved.visit, sessionId: saved.sessionId, final: saved.final }] : [];
  return {
    id: unit.id, kind: unit.kind, visit, sessionId: null, account: ctx.account, model: unit.model, folder: unit.cwd, branch: null,
    worktree: null, attempts: 0, starts: 0, totalStarts: 0, startedAt: ctx.now().toISOString(), headBefore: null, headAfter: null,
    running: false, pid: null, last: null, endedHow: null, check: null, nextAttemptAt: null, waitUntil: null, final: null,
    summary: null, tokens: {}, wallMs: 0, startsLog: [], history, notes: [],
    agents: [], worktrees: saved?.worktrees ?? [], worktreeBase: saved?.worktreeBase ?? null,
  };
}

/** The journal of this visit: the saved one, a fresh one for a new visit, counters reset when the owner replied. */
function journalFor(ctx, unit, visit, reply) {
  const saved = readJournal(ctx.paths, unit.id);
  if (!saved || saved.visit !== visit) return newJournal(ctx, unit, visit, saved);
  if (!reply || saved.replyId === reply.id) return saved; // the same reply again: the driver restarted after applying it
  return { ...saved, final: null, attempts: 0, starts: 0, nextAttemptAt: null, replyId: reply.id, notes: [...saved.notes, `owner: ${reply.action}`] };
}

/**
 * The journal on the account run.json names now. `resume --account` rewrites run.json while no driver runs; reading it here,
 * not ctx.account, keeps run.json the one truth even when two resumes race. A limit wait belongs to the old account's limit,
 * so it ends and the step starts at once; the session id stays, so the step continues its own conversation.
 */
function onRunAccount(ctx, journal) {
  const { account } = readJson(ctx.paths.run);
  if (account === journal.account) return journal;
  const switched = `account ${journal.account} -> ${account}`;
  const note = journal.waitUntil ? `${switched}: limit wait dropped` : switched;
  return { ...journal, account, waitUntil: null, notes: [...journal.notes, note] };
}

function claimWorktree(ctx, unit, journal) {
  if (unit.kind !== 'item' || !unit.group.worktree || journal.worktree) return journal;
  const base = readJournal(ctx.paths, unit.group.id)?.base;
  const lane = claimLane(openRepo(unit.group.cwd, null), { branch: `long-run/${ctx.runId}/${unit.id}`, base, env: ctx.env });
  return { ...journal, folder: lane.folder, worktree: lane.folder, branch: lane.branch };
}

/** The owner's control for this unit now: an outcome to return, 'park' for a run-level pause or stop, or null. */
function controlNow(ctx, unitId) {
  if (ctx.control.runSignal() !== null) return 'park';
  const signal = ctx.control.unitSignal(unitId);
  return signal === null ? null : { outcome: { pause: 'paused', stop: 'stopped', takeover: 'taken-over' }[signal] };
}

/** Waits until `untilIso` in slices; returns null when it passed, else the control outcome that cut it short. */
async function waitUntil(ctx, unit, untilIso, state) {
  const until = Date.parse(untilIso);
  ctx.live.waiting(unit.id, { state, until: untilIso });
  try {
    for (;;) {
      const control = controlNow(ctx, unit.id);
      if (control !== null) return control;
      if (ctx.control.hasTell(unit.id) && state === 'waiting-retry') return null; // an owner message is not held back by a backoff
      const left = until - ctx.now().getTime();
      if (left <= 0) return null;
      await ctx.sleep(Math.min(SLICE_MS, left));
    }
  } finally {
    ctx.live.stopped(unit.id);
  }
}

function guardReason(ctx, journal) {
  const { maxAttempts, maxStarts } = ctx.job.loopGuards;
  if (journal.attempts >= maxAttempts) return `loop guard: ${journal.attempts} attempts`;
  if (journal.starts >= maxStarts) return `loop guard: ${journal.starts} starts`;
  return null;
}

function finish(ctx, unit, journal, final) {
  writeJournal(ctx.paths, unit.id, { ...journal, final, nextAttemptAt: null, waitUntil: null });
  ctx.emit(unit.id, final);
  return final;
}

/** What follows a start: the next journal and either a final verdict or null to start again. */
function act(ctx, unit, journal, verdict) {
  if (verdict.outcome === 'crash' && verdict.noConversation && !journal.freshFallback) {
    return { journal: { ...journal, sessionId: null, freshFallback: true, notes: [...journal.notes, 'resume found no conversation: fresh start'] }, final: null };
  }
  if (verdict.outcome === 'limit') {
    const { until, source } = limitWaitUntil(verdict.limitText, { now: ctx.now(), account: journal.account, limitsDir: ctx.limitsDir });
    ctx.event(unit.id, 'waiting-limit', `until ${until.toISOString()}`, { source });
    return { journal: { ...journal, waitUntil: until.toISOString() }, final: null };
  }
  if (RETRIED.has(verdict.outcome)) {
    const attempts = journal.attempts + 1;
    const next = new Date(ctx.now().getTime() + backoffMs(ctx.job.retry, attempts, ctx.random)).toISOString();
    if (attempts < ctx.job.loopGuards.maxAttempts) ctx.event(unit.id, 'waiting-retry', `until ${next}`, { outcome: verdict.outcome, attempt: attempts });
    return { journal: { ...journal, attempts, nextAttemptAt: next }, final: null };
  }
  if (verdict.outcome === 'told') return { journal, final: null };
  return { journal, final: finalOf(verdict, journal) };
}

async function gate(ctx, unit, journal) {
  for (const [field, state] of [['waitUntil', 'waiting-limit'], ['nextAttemptAt', 'waiting-retry']]) {
    if (!journal[field]) continue;
    const control = await waitUntil(ctx, unit, journal[field], state);
    if (control !== null) return { journal, control };
    journal = { ...journal, [field]: null };
    writeJournal(ctx.paths, unit.id, journal);
  }
  return { journal, control: controlNow(ctx, unit.id) };
}

/**
 * Runs `unit` until it has an outcome for this visit.
 * @param {object} ctx the run context (driver.mjs).
 * @param {object} unit a step or item (job.mjs units).
 * @param {{visit: number, reply: object | null}} entry `reply`: the owner's hold reply for this unit, or null.
 * @returns {Promise<{status: string, reason?: string, question?: string}>} never rejects for a step failure; a run-level pause or
 *   stop never resolves (ctx.park).
 */
export async function runUnit(ctx, unit, { visit, reply }) {
  let journal = journalFor(ctx, unit, visit, reply);
  if (journal.final) return journal.final;
  try {
    journal = claimWorktree(ctx, unit, journal);
  } catch (error) {
    return finish(ctx, unit, journal, { status: 'failed', reason: `no worktree: ${error.message}` });
  }
  if (journal.running) {
    const orphan = await endOrphan({ pid: journal.pid, sessionId: journal.sessionId, platform: ctx.platform, isAlive: isPidAlive, killAfter: ctx.killAfter });
    journal = { ...journal, running: false, pid: null, last: journal.last ?? 'restart', notes: [...journal.notes, `driver restarted mid-start; the old child: ${orphan}`] };
  }
  journal = onRunAccount(ctx, journal);
  writeJournal(ctx.paths, unit.id, journal);
  let pendingReply = reply;
  for (;;) {
    const gated = await gate(ctx, unit, journal);
    journal = gated.journal;
    if (gated.control === 'park') return ctx.park(unit.id);
    if (gated.control) return finish(ctx, unit, { ...journal, last: gated.control.outcome }, finalOf(gated.control, journal));
    const guard = guardReason(ctx, journal);
    if (guard) return finish(ctx, unit, journal, finalOf({ outcome: 'guard', reason: guard }, journal));
    let started;
    try {
      started = await startOnce(ctx, unit, journal, { reply: pendingReply, told: ctx.control.takeTells(unit.id) });
    } catch (error) {
      if (!(error instanceof AccountRefusal)) throw error;
      return finish(ctx, unit, journal, { status: 'failed', reason: error.message });
    }
    pendingReply = null;
    if (['paused', 'stopped'].includes(started.verdict.outcome) && ctx.control.runSignal() !== null) return ctx.park(unit.id);
    const next = act(ctx, unit, started.journal, started.verdict);
    journal = next.journal;
    writeJournal(ctx.paths, unit.id, journal);
    if (next.final) return finish(ctx, unit, journal, next.final);
  }
}
