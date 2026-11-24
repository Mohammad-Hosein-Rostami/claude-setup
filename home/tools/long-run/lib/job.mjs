// Purpose: the job file of a long run (spec section 6): its zod schema, defaults, prompt files, the frozen copy a run keeps, and
//   the rule for reloading an edited job into a run that already started.
// Exports: JobError, RUNNER_VERSION, DEFAULT_MODEL, ID_PATTERN, loadJob, freezeJob, readFrozenJob, reloadChanges, units, findUnit,
//   folderKey.
// Invariants: the job file is the owner's code (its check commands run in a shell), but every id, model, path and prompt is
//   validated here before it reaches a path or a command; Fable is refused in every model field; prompts are read once and
//   inlined, so a run never rereads the owner's files; the normalized job always has every default filled in.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

/** The shape version of a frozen job.json; a run of any other version is refused with the version named. */
export const RUNNER_VERSION = 1;
/** The model of a step that names none (owner decision O5). Never Fable. */
export const DEFAULT_MODEL = 'claude-opus-5-5';
/** A job name and every step and item id: they become file names and branch parts. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

const JOB_MAX_BYTES = 256 * 1024;
const PROMPT_MAX_BYTES = 100 * 1024;
const MODEL_ALIASES = ['opus', 'sonnet', 'haiku'];
const MODEL_ID = /^claude-(?:opus|sonnet|haiku)-[a-z0-9.-]{1,40}$/;
const FABLE = /fable/i;
const WIN32_FOLDER_META = /["%^&|<>]/;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const OUTCOME_KEYS = ['done', 'blocked', 'needs-owner', 'failed'];
const DEFAULTS = {
  loopGuards: { maxAttempts: 3, maxStarts: 10 },
  retry: { firstDelaySeconds: 60, factor: 4, maxDelaySeconds: 1800 },
  maxParallel: 3,
  maxVisits: 3,
  checkTimeoutMinutes: 30,
};

/** A job that cannot run; `problems` lists each reason, one line each. */
export class JobError extends Error {
  constructor(problems) {
    super(problems.join('\n'));
    this.name = 'JobError';
    this.problems = problems;
  }
}

const id = z.string().regex(ID_PATTERN, 'an id is 1-40 of a-z, 0-9 and -, starting with a letter or digit');
const model = z.string().refine((value) => !FABLE.test(value), 'Fable is never used by long-run (owner decision O5)')
  .refine((value) => MODEL_ALIASES.includes(value) || MODEL_ID.test(value), 'a model is opus, sonnet, haiku or a full claude-opus-*, claude-sonnet-* or claude-haiku-* id');
const prompted = { prompt: z.string().optional(), promptFile: z.string().optional() };
const target = z.union([id, z.literal('end')]);
const item = z.strictObject({ id, ...prompted, cwd: z.string().optional(), model: model.optional(), effort: z.enum(EFFORTS).optional() });
const step = z.strictObject({
  id,
  ...prompted,
  cwd: z.string().optional(),
  model: model.optional(),
  effort: z.enum(EFFORTS).optional(),
  parallel: z.array(item).min(2).max(20).optional(),
  worktree: z.boolean().optional(),
  check: z.strictObject({ command: z.string().min(1), timeoutMinutes: z.number().int().min(1).max(1440).optional() }).optional(),
  next: z.strictObject(Object.fromEntries(OUTCOME_KEYS.map((key) => [key, target.optional()]))).optional(),
  maxVisits: z.number().int().min(1).max(10).optional(),
});
const JOB_SCHEMA = z.strictObject({
  name: id,
  model: model.optional(),
  effort: z.enum(EFFORTS).optional(),
  cwd: z.string(),
  loopGuards: z.strictObject({ maxAttempts: z.number().int().min(1).max(10).optional(), maxStarts: z.number().int().min(2).max(100).optional() }).optional(),
  retry: z.strictObject({
    firstDelaySeconds: z.number().min(10).max(3600).optional(),
    factor: z.number().min(1).max(10).optional(),
    maxDelaySeconds: z.number().min(60).max(21600).optional(),
  }).optional(),
  stepTimeoutMinutes: z.number().int().min(5).max(10080).optional(),
  maxParallel: z.number().int().min(1).max(3).optional(),
  steps: z.array(step).min(1).max(50),
});

/** The key two folders share when they are one folder: realpath, lower-cased on the case-insensitive systems. */
export function folderKey(folder, platform = process.platform) {
  const real = realpathSync.native(folder);
  return platform === 'darwin' || platform === 'win32' ? real.toLowerCase() : real;
}

function checkFolder(folder, where, platform, problems) {
  if (!isAbsolute(folder)) return problems.push(`${where}: cwd must be an absolute path`);
  if (platform === 'win32' && WIN32_FOLDER_META.test(folder)) return problems.push(`${where}: cwd may not hold " % ^ & | < > on Windows`);
  if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory()) return problems.push(`${where}: cwd ${folder} is not a folder`);
  return null;
}

/** The text of a prompt file inside the job folder: no `..`, no link out, UTF-8, at most 100 KB, not empty. */
function readPromptFile(jobDir, file, where) {
  if (isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new JobError([`${where}: promptFile must be relative to the job file, without ..`]);
  const real = realpathSync.native(resolve(jobDir, file));
  const inside = relative(realpathSync.native(jobDir), real);
  if (inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside)) throw new JobError([`${where}: promptFile leads out of the job folder`]);
  const bytes = readFileSync(real);
  if (bytes.length > PROMPT_MAX_BYTES) throw new JobError([`${where}: promptFile is over ${PROMPT_MAX_BYTES} bytes`]);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function promptOf(entry, jobDir, where, problems) {
  if ((entry.prompt === undefined) === (entry.promptFile === undefined)) {
    problems.push(`${where}: give exactly one of prompt and promptFile`);
    return '';
  }
  let text = entry.prompt;
  try {
    text ??= readPromptFile(jobDir, entry.promptFile, where);
  } catch (error) {
    problems.push(error instanceof JobError ? error.message : `${where}: promptFile ${entry.promptFile}: ${error.code ?? error.message}`);
    return '';
  }
  if (text.trim() === '') problems.push(`${where}: the prompt is empty`);
  return text;
}

function normalizeItem(raw, group, context) {
  const where = `step ${group.id} item ${raw.id}`;
  const cwd = raw.cwd ?? context.cwd;
  checkFolder(cwd, where, context.platform, context.problems);
  return { id: raw.id, prompt: promptOf(raw, context.jobDir, where, context.problems), cwd, model: raw.model ?? context.model, effort: raw.effort ?? context.effort };
}

function normalizeStep(raw, context) {
  const where = `step ${raw.id}`;
  const cwd = raw.cwd ?? context.cwd;
  checkFolder(cwd, where, context.platform, context.problems);
  const common = {
    id: raw.id, cwd, model: raw.model ?? context.model, effort: raw.effort ?? context.effort, next: raw.next ?? {},
    maxVisits: raw.maxVisits ?? DEFAULTS.maxVisits,
    check: raw.check ? { command: raw.check.command, timeoutMinutes: raw.check.timeoutMinutes ?? DEFAULTS.checkTimeoutMinutes } : null,
  };
  if (raw.parallel === undefined) {
    if (raw.worktree !== undefined) context.problems.push(`${where}: worktree is for parallel groups only`);
    return { ...common, kind: 'step', prompt: promptOf(raw, context.jobDir, where, context.problems) };
  }
  if (raw.prompt !== undefined || raw.promptFile !== undefined) context.problems.push(`${where}: a parallel group has no prompt of its own`);
  const stepContext = { ...context, cwd, model: common.model, effort: common.effort };
  return { ...common, kind: 'group', worktree: raw.worktree ?? false, items: raw.parallel.map((entry) => normalizeItem(entry, raw, stepContext)) };
}

function checkCrossRules(job, problems, platform) {
  const ids = job.steps.flatMap((entry) => [entry.id, ...(entry.items ?? []).map((one) => one.id)]);
  const twice = ids.filter((value, index) => ids.indexOf(value) !== index);
  if (twice.length > 0) problems.push(`ids must be unique across steps and items: ${[...new Set(twice)].join(', ')}`);
  const stepIds = new Set(job.steps.map((entry) => entry.id));
  for (const entry of job.steps) {
    for (const [outcome, to] of Object.entries(entry.next)) {
      if (to !== 'end' && !stepIds.has(to)) problems.push(`step ${entry.id}: next.${outcome} names no step: ${to}`);
    }
    if (entry.kind !== 'group' || entry.worktree || problems.length > 0) continue;
    const keys = entry.items.map((one) => folderKey(one.cwd, platform));
    if (new Set(keys).size !== keys.length) problems.push(`step ${entry.id}: without worktree: true every item needs its own cwd (two items share one folder)`);
  }
}

function normalize(raw, jobDir, platform) {
  const problems = [];
  const context = { cwd: raw.cwd, model: raw.model ?? DEFAULT_MODEL, effort: raw.effort ?? null, jobDir, platform, problems };
  checkFolder(raw.cwd, 'job', platform, problems);
  const job = {
    name: raw.name, model: context.model, effort: context.effort, cwd: raw.cwd,
    loopGuards: { ...DEFAULTS.loopGuards, ...raw.loopGuards }, retry: { ...DEFAULTS.retry, ...raw.retry },
    stepTimeoutMinutes: raw.stepTimeoutMinutes ?? null, maxParallel: raw.maxParallel ?? DEFAULTS.maxParallel,
    steps: raw.steps.map((entry) => normalizeStep(entry, context)),
  };
  if (problems.length === 0) checkCrossRules(job, problems, platform);
  if (problems.length > 0) throw new JobError(problems);
  return job;
}

/**
 * Reads and validates a job file.
 * @param {string} path the job file.
 * @param {{platform?: string}} options `platform` stands in for process.platform (tests).
 * @returns {{job: object, sha256: string, path: string}} the normalized job (prompts inlined, defaults filled) and the file's hash.
 * @throws {JobError} with every problem found, each naming the step or field and what to change.
 */
export function loadJob(path, { platform = process.platform } = {}) {
  const full = resolve(path);
  const stat = statSync(full, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new JobError([`${full} is not a file`]);
  if (stat.size > JOB_MAX_BYTES) throw new JobError([`${full} is over ${JOB_MAX_BYTES} bytes`]);
  const bytes = readFileSync(full);
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new JobError([`${full} is not JSON: ${error.message}`]);
  }
  const result = JOB_SCHEMA.safeParse(parsed);
  if (!result.success) throw new JobError(result.error.issues.map((issue) => `${issue.path.join('.') || 'job'}: ${issue.message}`));
  const job = normalize(result.data, dirname(full), platform);
  return { job, sha256: createHash('sha256').update(bytes).digest('hex'), path: full };
}

/** The frozen copy a run keeps in `<run>/job.json`. */
export const freezeJob = (loaded) => ({ runnerVersion: RUNNER_VERSION, source: loaded.path, sourceSha256: loaded.sha256, job: loaded.job });

/**
 * @param {string} text the content of `<run>/job.json`.
 * @returns {object} its normalized job.
 * @throws {JobError} for another runner version (named) or a file that is not a frozen job.
 */
export function readFrozenJob(text) {
  const frozen = JSON.parse(text);
  if (frozen?.runnerVersion !== RUNNER_VERSION) {
    throw new JobError([`this run was made by runner version ${frozen?.runnerVersion ?? 'unknown'}; this runner reads version ${RUNNER_VERSION} only`]);
  }
  return frozen.job;
}

/** Every unit that starts a boss: plain steps and group items, in job order. */
export const units = (job) => job.steps.flatMap((entry) => (entry.kind === 'group' ? entry.items.map((one) => ({ ...one, kind: 'item', group: entry })) : [{ ...entry, group: null }]));

/** The unit (plain step, group or item) with that id, or null. */
export function findUnit(job, unitId) {
  const top = job.steps.find((entry) => entry.id === unitId);
  if (top) return top;
  return units(job).find((one) => one.kind === 'item' && one.id === unitId) ?? null;
}

const shapeOf = (entry) => `${entry.id}:${entry.kind}:${(entry.items ?? []).map((one) => one.id).join(',')}`;
const promptsOf = (entry) => (entry.kind === 'group' ? entry.items.map((one) => [one.id, one.prompt]) : [[entry.id, entry.prompt]]);

/**
 * Whether an edited job may replace a running one: the ids, kinds and order of the finished steps must be unchanged.
 * @param {object} oldJob the frozen job.
 * @param {object} newJob the edited job, normalized.
 * @param {Set<string>} finished the ids of the steps already done.
 * @returns {string[]} the ids of unfinished steps or items whose prompt changed.
 * @throws {JobError} naming the first finished step that changed.
 */
export function reloadChanges(oldJob, newJob, finished) {
  oldJob.steps.forEach((entry, index) => {
    if (!finished.has(entry.id)) return;
    if (newJob.steps[index] === undefined || shapeOf(newJob.steps[index]) !== shapeOf(entry)) {
      throw new JobError([`step ${entry.id} is finished: its id, kind and place must stay the same in the reloaded job`]);
    }
  });
  const oldPrompts = new Map(oldJob.steps.flatMap(promptsOf));
  return newJob.steps.filter((entry) => !finished.has(entry.id)).flatMap(promptsOf)
    .filter(([unitId, prompt]) => oldPrompts.get(unitId) !== prompt).map(([unitId]) => unitId);
}
