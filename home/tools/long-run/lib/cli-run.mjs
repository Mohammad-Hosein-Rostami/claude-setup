// Purpose: the commands that make a run go: `check`, `start`, `resume` (one run or every stale one) and `rerun` (M9).
// Exports: planLines, checkCommand, startCommand, resumeCommand, resumeStale, rerunCommand.
// Invariants: nothing starts before the job, the account (stored, usage credits recorded off) and the SQLite module pass; a run
//   records its account once and every resume checks that same account again; resume refuses while a taken-over session looks
//   open (unless --force) and never while a driver lives; --retry, --skip and --abandon are refused unless a step is held; rerun moves the later journals aside and never touches git.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { freezeJob, loadJob, reloadChanges, units } from './job.mjs';
import { requireCreditsOff, startAccount } from './run-account.mjs';
import { RunBusy, driverAlive, ensureRunDirs, listRunIds, newRunId, readJournal, readJson, readRunJob, runPaths, writeJson } from './run-store.mjs';
import { assertNativeModule } from './driver.mjs';
import { clearControl, sessionLooksOpen } from './control.mjs';
import { recordEvent } from './events.mjs';
import { buildGraph, openHold, rerunPoint } from './graph.mjs';
import { Refusal, UsageError, claimRunFolders, openRun, startDriver } from './cli-common.mjs';
import { runState } from './view.mjs';

const SECOND_MS = 1000;
const HOLD_ONLY = ['retry', 'skip', 'abandon'];

/** The plan lines `check` prints: what will run where, on which model and account. */
export function planLines(job, account) {
  const lines = [`job ${job.name}: ${job.steps.length} step(s), at most ${job.maxParallel} boss(es) at once, account ${account} (usage credits recorded off)`];
  for (const entry of job.steps) {
    const next = Object.entries(entry.next).map(([outcome, to]) => `${outcome}->${to}`).join(' ');
    const what = entry.kind === 'group' ? `group of ${entry.items.length}${entry.worktree ? ' in lane worktrees' : ''}` : 'step';
    lines.push(`- ${entry.id}: ${what}, model ${entry.model}${entry.effort ? ` (${entry.effort})` : ''}, folder ${entry.cwd}${entry.check ? `, check \`${entry.check.command}\`` : ''}${next ? `, next ${next}` : ''}`);
    for (const item of entry.items ?? []) lines.push(`  - ${item.id}: model ${item.model}, folder ${item.cwd}`);
  }
  lines.push(`loop guards per step: ${job.loopGuards.maxAttempts} failed attempts, ${job.loopGuards.maxStarts} starts, 3 visits by default (not budgets); step timeout: ${job.stepTimeoutMinutes ? `${job.stepTimeoutMinutes} min` : 'none'}`);
  return lines;
}

function loadChecked(jobPath, env) {
  if (!jobPath) throw new UsageError('give a job file');
  const loaded = loadJob(jobPath);
  const account = startAccount(env);
  assertNativeModule();
  return { loaded, account };
}

/**
 * `check <job.json>`: validate, resolve account and models, load the SQLite module; prints the plan, spends nothing.
 * `check --deps` (doctor, spec 21): only loads better-sqlite3, opens an in-memory database and imports LangGraph; prints `ok`.
 * @throws {Refusal} with the one-line fix when a dependency does not load.
 */
export async function checkCommand({ positional, flags, env, write }) {
  if (flags.deps) {
    try {
      assertNativeModule();
      await import('@langchain/langgraph');
    } catch (error) {
      const cause = error.message.split('\n')[0].replace(/: run scripts\/install\.sh.*$/, '');
      throw new Refusal(`deps: ${cause} (run scripts/install.sh; Windows: scripts/install.ps1)`);
    }
    write('ok');
    return;
  }
  const { loaded, account } = loadChecked(positional[0], env);
  for (const line of planLines(loaded.job, account)) write(line);
}

const startedBy = (env, schedule) => (schedule ? 'schedule' : env.CLAUDECODE ? 'session' : 'terminal');

/**
 * `start <job.json> [--foreground] [--schedule <name>]`.
 * @returns {Promise<string>} the run id.
 */
export async function startCommand({ positional, flags, env, root, write }) {
  const { loaded, account } = loadChecked(positional[0], env);
  const now = new Date();
  const paths = runPaths(root, newRunId(root, loaded.job.name, now));
  ensureRunDirs(paths);
  try {
    claimRunFolders(paths, loaded.job);
  } catch (error) {
    rmSync(paths.dir, { recursive: true, force: true });
    throw error;
  }
  writeJson(paths.job, freezeJob(loaded));
  writeJson(paths.run, { account, startedBy: startedBy(env, flags.schedule), schedule: flags.schedule ?? null, createdAt: now.toISOString() });
  write(`started ${paths.runId} (account ${account})`);
  write(`status: node ~/.claude/tools/long-run/long-run.mjs status ${paths.runId}`);
  write(`events: node ~/.claude/tools/long-run/long-run.mjs events --run ${paths.runId} --follow`);
  const ended = await startDriver(paths, { env, foreground: Boolean(flags.foreground) });
  if (flags.foreground) write(`run ${paths.runId} ${ended}`);
  return paths.runId;
}

function refuseOpenSessions(paths, job, env) {
  for (const unit of units(job)) {
    const journal = readJournal(paths, unit.id);
    if (journal?.last !== 'taken-over' || !journal.sessionId) continue;
    const why = sessionLooksOpen({ sessionId: journal.sessionId, env });
    if (why) throw new Refusal(`step ${unit.id}: session ${journal.sessionId} looks open (${why}); quit it in its terminal first, or resume --force`);
  }
}

function reloadJob(paths, jobPath, write) {
  const loaded = loadJob(jobPath);
  const old = readRunJob(paths);
  const finished = new Set(units(old).map((unit) => unit.id).filter((unitId) => readJournal(paths, unitId)?.final?.status === 'done'));
  for (const entry of old.steps) if (entry.kind === 'group' && entry.items.every((item) => finished.has(item.id))) finished.add(entry.id);
  const changed = reloadChanges(old, loaded.job, finished);
  writeJson(paths.job, freezeJob(loaded));
  write(changed.length > 0 ? `reloaded; changed prompts: ${changed.join(', ')}` : 'reloaded; no unfinished prompt changed');
}

function replyOf(flags) {
  const chosen = ['retry', 'skip', 'abandon'].filter((name) => flags[name]);
  const answer = flags.answer ?? (flags['answer-file'] ? readFileSync(flags['answer-file'], 'utf8').trim() : null);
  if (chosen.length + (answer === null ? 0 : 1) > 1) throw new UsageError('give at most one of --answer, --answer-file, --retry, --skip, --abandon');
  if (flags.item && answer === null && chosen.length === 0) throw new UsageError('--item goes with --answer, --retry, --skip or --abandon');
  const action = answer !== null ? 'answer' : chosen[0] ?? 'continue';
  return { action, text: answer, item: flags.item ?? null, id: randomUUID() };
}

/**
 * `resume <run> [...]`: continue a held, paused, stopped, taken-over or stale run with the owner's reply.
 * @returns {Promise<void>}
 * @throws {RunBusy} while its driver lives; {Refusal} for a finished run, an account that cannot be used or an open session.
 */
export async function resumeCommand({ runId, flags, env, root, write }) {
  const paths = openRun(root, runId);
  if (driverAlive(paths)) throw new RunBusy(`run ${runId} is running; pause or stop it first, or use tell to steer a step`);
  const state = runState(paths);
  if (state === 'done' || state === 'abandoned') throw new Refusal(`run ${runId} is ${state}; use rerun --from <step>`);
  const reply = replyOf(flags);
  if (HOLD_ONLY.includes(reply.action) && readJson(paths.driver)?.status !== 'held') {
    // Only a held step takes these; on any other run they would start its boss again instead (audit Job A, the abandon bug).
    throw new Refusal(`run ${runId} holds no step (it is ${state}); --${reply.action} applies to a held step only. Leave it ${state} (it spends nothing) or continue it with long-run resume ${runId}`);
  }
  requireCreditsOff(readJson(paths.run).account, env);
  if (!flags.force) refuseOpenSessions(paths, readRunJob(paths), env);
  if (flags['reload-job']) reloadJob(paths, flags['reload-job'], write);
  claimRunFolders(paths, readRunJob(paths));
  clearControl(paths);
  writeJson(join(paths.dir, 'resume.json'), reply);
  write(`resuming ${runId} (${reply.action}${reply.item ? ` for ${reply.item}` : ''})`);
  const ended = await startDriver(paths, { env, foreground: Boolean(flags.foreground) });
  if (flags.foreground) write(`run ${runId} ${ended}`);
}

/**
 * `resume --stale [--delay <s>]` (M6): resumes every run whose driver died; never a paused, stopped, held, taken-over or finished one.
 * @returns {Promise<string[]>} the run ids resumed.
 */
export async function resumeStale({ flags, env, root, write, sleep }) {
  if (flags.delay) await sleep(Number(flags.delay) * SECOND_MS);
  const resumed = [];
  for (const runId of listRunIds(root)) {
    if (runState(runPaths(root, runId)) !== 'stale') continue;
    try {
      await resumeCommand({ runId, flags: {}, env, root, write });
      resumed.push(runId);
    } catch (error) {
      write(`${runId}: not resumed: ${error.message}`);
    }
  }
  if (resumed.length === 0) write('no stale runs');
  return resumed;
}

function moveAside(paths, ids) {
  let n = 1;
  while (existsSync(join(paths.steps, `.rerun-${n}`))) n += 1;
  const aside = join(paths.steps, `.rerun-${n}`);
  mkdirSync(aside, { recursive: true, mode: 0o700 });
  for (const unitId of ids) {
    const from = join(paths.steps, `${unitId}.json`);
    if (existsSync(from)) renameSync(from, join(aside, `${unitId}.json`));
  }
  return aside;
}

/** `rerun <run> --from <step> [--reload-job <f>]` (M9). */
export async function rerunCommand({ runId, flags, env, root, write }) {
  const paths = openRun(root, runId);
  if (driverAlive(paths)) throw new RunBusy(`run ${runId} is running; stop it first`);
  if (!flags.from) throw new UsageError('rerun needs --from <step>');
  if (flags['reload-job']) reloadJob(paths, flags['reload-job'], write);
  const job = readRunJob(paths);
  const entry = job.steps.find((one) => one.id === flags.from);
  if (!entry) throw new Refusal(`no top-level step ${flags.from} in run ${runId}`);
  requireCreditsOff(readJson(paths.run).account, env);
  const app = buildGraph({ job, paths, runId });
  const point = await rerunPoint(app, runId, entry);
  if (!point) throw new Refusal(`step ${entry.id} never ran in run ${runId}`);
  const latest = (await openHold(app, runId)).values;
  const rerunSteps = job.steps.filter((one) => (latest.visits?.[one.id] ?? 0) > (point.values.visits?.[one.id] ?? 0));
  const ids = rerunSteps.flatMap((one) => [one.id, ...(one.items ?? []).map((item) => item.id)]);
  const head = readJournal(paths, entry.id)?.[entry.kind === 'group' ? 'base' : 'headBefore'] ?? null;
  const aside = moveAside(paths, ids);
  writeJson(paths.rerun, { step: entry.id, config: point.config });
  claimRunFolders(paths, job);
  clearControl(paths);
  recordEvent(paths, { event: 'resumed', step: entry.id, detail: `re-run from ${entry.id}; ${ids.length} journal(s) set aside` });
  write(`re-running ${runId} from ${entry.id}; journals of ${ids.join(', ')} moved to ${aside}`);
  write(head ? `files are not rolled back; to work from the code as it was before ${entry.id}: git switch -c rerun-${entry.id} ${head}` : 'files are not rolled back (no HEAD was recorded for this step)');
  const ended = await startDriver(paths, { env, foreground: Boolean(flags.foreground) });
  if (flags.foreground) write(`run ${runId} ${ended}`);
}
