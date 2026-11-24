// Purpose: one `claude` start of a step or item (spec 7.2 steps 1-2, 7.3): pick fresh or resume, build the prompt (fixed texts,
//   on stdin), write the journal before the spawn, run the child under the run's semaphore, run the step check, log one usage row.
// Exports: WRAPPER, FOLLOW_UPS, promptFor, startOnce, gitHead.
// Invariants: the journal names the session id and the start before the child exists, so a crash between the two resumes or
//   starts fresh without losing count; the boss's agents are written to the journal as the stream names them, and the worktrees
//   that appeared since the step's first start before and after each start, so a resumed boss is told what was in flight
//   (RESUME-STATE, in-flight.mjs) even after a SIGKILL of the driver; a session with no transcript is started fresh, never
//   `--resume`d; the token is read from the store for the recorded account at each start and goes only to
//   the child env; the usage row and the journal hold the account name and token counts, never the token; check output is scrubbed.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { logUsage } from '../../account/lib/usage.mjs';
import { claudeArgs, classify, scrub, startClaude } from './claude-run.mjs';
import { endProcessTree } from './process-tree.mjs';
import { readJournal, writeJournal } from './run-store.mjs';
import { accountToken } from './run-account.mjs';
import { hasTranscript } from './control.mjs';
import { openAgents, resumeStateBlock, trackAgent } from './in-flight.mjs';
import { WORKTREES_MAX, commitsSince, listWorktrees, newWorktrees, worktreeState } from './worktrees.mjs';

/** The fixed text after a step's own prompt on its first start (spec 7.3). */
export const WRAPPER = (runId, unitId) => `You run unattended inside long-run (run ${runId}, step ${unitId}). Nobody watches this session. When an owner decision blocks you, finish what does not depend on it, then stop. Wait for every agent you start before your final message. Commit finished work. Your final message ends with exactly one line: \`STEP-RESULT: done\`, \`STEP-RESULT: blocked: <reason>\` or \`STEP-RESULT: needs-owner: <one-line question>\`.`;

const RESTART = 'The runner paused or restarted this session; check what is already done (git status, git log) and continue.';
/** The follow-up of a resumed session, by the last outcome (spec 7.3, 19.2). */
export const FOLLOW_UPS = {
  limit: () => 'The usage limit has reset; continue where you stopped.',
  restart: () => RESTART,
  'no-verdict': () => 'Give your STEP-RESULT line for this step.',
  'check-failed': (journal) => `The step check \`${journal.check.command}\` failed (exit ${journal.check.exit}). Last 40 lines:\n${journal.check.tail}\nFix it and finish.`,
  answer: (journal, reply) => `The owner answered: ${reply.text}`,
  'taken-over': () => 'The owner continued this step by hand and has quit. Check what is done, finish what is left, and give your STEP-RESULT line.',
};
const TELL = (message) => `Message from the owner, sent while you worked: ${message}. Take it into account, continue the step, and end with your STEP-RESULT line.`;
const CHECK_TAIL_LINES = 40;
const CHECK_KEEP_CHARS = 64 * 1024;
const MS_PER_MINUTE = 60 * 1000;
// The exit a check gets when it has no exit code of its own, or was stopped at its deadline: a timed-out check never passes,
// even when it exits 0 on the SIGTERM that stops it.
const NO_EXIT_CODE = -1;

/** The full sha of HEAD of `folder`, or null when it is not a git folder. */
export function gitHead(folder) {
  const run = spawnSync('git', ['-C', folder, 'rev-parse', '--verify', 'HEAD^{commit}'], { encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : null;
}

function earlierSummaries(ctx, unitId) {
  const lines = ctx.unitIds.filter((other) => other !== unitId).flatMap((other) => {
    const journal = readJournal(ctx.paths, other);
    return journal?.final?.status === 'done' && journal.summary ? [`- ${other}: ${journal.summary}`] : [];
  });
  return lines.length > 0 ? `\n\nEarlier steps:\n${lines.join('\n')}` : '';
}

function followUpKind(journal, reply) {
  if (reply?.action === 'answer') return 'answer';
  if (journal.last === 'told') return null;
  return FOLLOW_UPS[journal.last] ? journal.last : 'restart';
}

/** The RESUME-STATE block for `journal`: its unfinished agents, its worktrees and the commits it made ('' when none). */
function resumeState(journal) {
  return resumeStateBlock({
    agents: openAgents(journal.agents),
    worktrees: (journal.worktrees ?? []).map((one) => ({ ...one, state: worktreeState(one.path, journal.headBefore) })),
    commits: commitsSince(journal.folder, journal.headBefore),
  });
}

/**
 * The prompt of the next start: the first prompt for a fresh session, else the follow-up of the last outcome; queued owner
 * messages (`tell`) come first; the RESUME-STATE block comes before the follow-up (after the prompt of a fresh start that
 * replaces a lost session) whenever agents, worktrees or commits of the step were recorded.
 * @returns {string}
 */
export function promptFor(ctx, unit, journal, { fresh, reply, told }) {
  const tells = told.map(TELL);
  const state = resumeState(journal);
  const inFlight = state ? [state] : [];
  if (fresh) return [...tells, `${unit.prompt}\n\n${WRAPPER(ctx.runId, unit.id)}${earlierSummaries(ctx, unit.id)}`, ...inFlight].join('\n\n');
  const kind = followUpKind(journal, reply);
  return [...tells, ...inFlight, ...(kind ? [FOLLOW_UPS[kind](journal, reply)] : [])].join('\n\n') || RESTART;
}

/** `journal` with the worktrees that appeared since its first start (the first call records which ones were there before). */
function withWorktrees(ctx, journal) {
  const now = listWorktrees(journal.folder);
  if (now === null) return journal;
  const worktreeBase = journal.worktreeBase ?? now.map((one) => one.path);
  const found = newWorktrees(now, { basePaths: worktreeBase, runId: ctx.runId });
  const kept = (journal.worktrees ?? []).filter((one) => !found.some((seen) => seen.path === one.path));
  return { ...journal, worktreeBase, worktrees: [...kept, ...found].slice(-WORKTREES_MAX) };
}

function runCheck(ctx, unit, folder, token) {
  const timeoutMs = unit.check.timeoutMinutes * MS_PER_MINUTE;
  return new Promise((resolve) => {
    // The owner's own command (trusted like a Makefile, spec 14), in its own process group so a hang guard ends all of it.
    const child = spawn(unit.check.command, { cwd: folder, env: ctx.env, shell: true, detached: ctx.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const keep = (chunk) => { output = `${output}${chunk}`.slice(-CHECK_KEEP_CHARS); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      output += `\n(check stopped after ${unit.check.timeoutMinutes} min)`;
      endProcessTree(child, { platform: ctx.platform }).catch((error) => { output += `\n(its processes could not be ended: ${error.message})`; });
    }, timeoutMs);
    child.once('error', (error) => { output += `\n${error.message}`; });
    child.once('close', (code) => {
      clearTimeout(timer);
      const tail = scrub(output, token).trimEnd().split('\n').slice(-CHECK_TAIL_LINES).join('\n');
      resolve({ command: unit.check.command, exit: timedOut ? NO_EXIT_CODE : code ?? NO_EXIT_CODE, tail });
    });
  });
}

function usageRow(ctx, unit, journal, run, ms) {
  const usage = run.result?.usage ?? {};
  const tokens = { input: usage.input_tokens ?? 0, cacheCreation: usage.cache_creation_input_tokens ?? 0, cacheRead: usage.cache_read_input_tokens ?? 0, output: usage.output_tokens ?? 0 };
  logUsage({
    session: journal.sessionId, label: `long-run:${ctx.runId}/${unit.id}`, attempt: journal.attempts, account: journal.account, model: unit.model,
    input: tokens.input, cache_creation: tokens.cacheCreation, cache_read: tokens.cacheRead, output: tokens.output,
    cost_usd_list: run.result?.total_cost_usd ?? 0, ms, is_error: Boolean(run.result?.is_error ?? true),
  }, ctx.env);
  return tokens;
}

const addTokens = (sum = {}, more) => Object.fromEntries(Object.entries(more).map(([key, value]) => [key, (sum[key] ?? 0) + value]));

function beginJournal(ctx, unit, journal, fresh) {
  journal = withWorktrees(ctx, journal);
  const sessionId = fresh ? randomUUID() : journal.sessionId;
  const args = claudeArgs({ model: unit.model, effort: unit.effort, sessionId, resume: !fresh });
  const n = journal.totalStarts + 1;
  const begun = {
    ...journal, sessionId, starts: journal.starts + 1, totalStarts: n, running: true, last: null,
    headBefore: journal.headBefore ?? gitHead(journal.folder),
    startsLog: [...journal.startsLog, { n, at: ctx.now().toISOString(), mode: fresh ? 'fresh' : 'resume', args, log: `logs/${unit.id}.${n}.jsonl` }],
  };
  writeJournal(ctx.paths, unit.id, begun);
  return { begun, args, logBase: join(ctx.paths.logs, `${unit.id}.${n}`) };
}

/**
 * Runs the child of one start under the run's semaphore; the journal is written again with its pid, and each time the stream
 * names a change of the boss's agents.
 * @returns {Promise<{run: object, journal: object}>} how the child ended and the journal as last written.
 */
async function runChild(ctx, unit, begun, { args, prompt, token, logBase, fresh }) {
  let current = begun;
  const save = (patch) => {
    current = { ...current, ...patch };
    writeJournal(ctx.paths, unit.id, current);
  };
  const onEvent = (event) => {
    const agents = trackAgent(current.agents ?? [], event, ctx.now());
    if (agents !== (current.agents ?? [])) save({ agents });
  };
  await ctx.semaphore.acquire();
  try {
    const added = { CLAUDE_ACCOUNT: begun.account, LONG_RUN_ID: ctx.runId, LONG_RUN_STEP: unit.id };
    const handle = startClaude({ args, prompt, cwd: begun.folder, env: ctx.env, token, added, logBase, platform: ctx.platform, killAfter: ctx.killAfter, onEvent });
    ctx.live.running(unit.id, { pid: handle.pid, handle, sessionId: begun.sessionId, folder: begun.folder, log: `${logBase}.jsonl` });
    save({ pid: handle.pid });
    ctx.event(unit.id, 'step-started', `${fresh ? 'new' : 'resumed'} session ${begun.sessionId}`, { start: begun.totalStarts, sessionId: begun.sessionId });
    const timer = ctx.job.stepTimeoutMinutes ? setTimeout(() => handle.end('timeout'), ctx.job.stepTimeoutMinutes * MS_PER_MINUTE) : null;
    const run = await handle.done;
    clearTimeout(timer);
    return { run, journal: current };
  } finally {
    ctx.live.stopped(unit.id);
    ctx.semaphore.release();
  }
}

/**
 * Runs one start of `unit` and records it.
 * @param {object} ctx the run context (driver.mjs).
 * @param {object} unit the step or item (job.mjs units).
 * @param {object} journal its journal (folder, counters, session).
 * @param {{reply: object | null, told: string[]}} input the owner's hold reply and queued messages for this start.
 * @returns {Promise<{journal: object, verdict: object}>} the journal after the start and `classify`'s verdict (check-failed when
 *   the boss said done and the check failed).
 * @throws {AccountRefusal} before any spawn when the recorded account cannot be used.
 */
export async function startOnce(ctx, unit, journal, { reply, told }) {
  const token = accountToken(journal.account, { env: ctx.env, store: ctx.store });
  if (journal.sessionId !== null && !hasTranscript({ sessionId: journal.sessionId, env: ctx.env })) {
    // A crash between the journal write and the spawn, or the transcript cleanup, leaves nothing to resume (audit H14).
    journal = { ...journal, sessionId: null, notes: [...journal.notes, `session ${journal.sessionId} has no transcript: fresh start`] };
  }
  const fresh = journal.sessionId === null;
  const { begun, args, logBase } = beginJournal(ctx, unit, journal, fresh);
  const prompt = promptFor(ctx, unit, { ...begun, last: journal.last }, { fresh, reply, told });
  const started = ctx.now().getTime();
  const { run, journal: ran } = await runChild(ctx, unit, begun, { args, prompt, token, logBase, fresh });
  let verdict = classify(run);
  const check = verdict.outcome === 'done' && unit.check ? await runCheck(ctx, unit, ran.folder, token) : null;
  if (check && check.exit !== 0) verdict = { ...verdict, outcome: 'check-failed' };
  const ms = ctx.now().getTime() - started;
  const tokens = usageRow(ctx, unit, ran, run, ms);
  const startsLog = ran.startsLog.map((entry, index) => (index === ran.startsLog.length - 1 ? { ...entry, endedHow: run.endedHow, exitCode: run.exitCode, outcome: verdict.outcome } : entry));
  const notes = run.treeError ? [...ran.notes, `the boss's process tree could not be read: ${run.treeError}`] : ran.notes;
  const after = withWorktrees(ctx, {
    ...ran, running: false, pid: null, last: verdict.outcome, endedHow: run.endedHow, startsLog, check: check ?? ran.check,
    tokens: addTokens(ran.tokens, tokens), wallMs: (ran.wallMs ?? 0) + ms, headAfter: gitHead(ran.folder),
    summary: verdict.summary ?? ran.summary, freshFallback: ran.freshFallback, notes,
  });
  writeJournal(ctx.paths, unit.id, after);
  return { journal: after, verdict, run };
}
