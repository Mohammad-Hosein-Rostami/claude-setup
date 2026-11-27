// Purpose: the two files `board tick` reads beside git: the plan's pieces.json (lex writes it next to the plan) and the job's tess
//   marks (written only by `tick --mark-tess`).
// Exports: readPlan(path, repo) -> plan, readMarks(job, env) -> marks, writeMark({ repo, plan, feature, sha, env, nowMs }) -> the marks file's path.
// Invariants: the boundary of the tick: every plan and marks file is checked here, so tick.mjs trusts what it gets; a missing or bad
//   plan, or a marks file that is not valid, throws UsageError (exit 2), never a guess. Job, feature and piece ids are safe file
//   names (NAME, a subset of session-store.mjs isSessionId). A piece's `branch` passes the check `lane claim --branch` makes
//   (lane-pool.mjs checkBranchName), is no base branch (git-tidy's lane-release.mjs baseNames) and no two pieces share a branch. Marks live in `<boardDir>/jobs/<job>.json` as
//   `{ "<feature>": { "sha": "<40-hex>", "at": "<ISO>" } }` and are written through session-store.mjs: a temp file and a rename,
//   no link followed, 0600, never swept (a job may wait more than a week). A mark's read and write run under `<job>.lock` beside it
//   (O_EXCL, disk-free/lib/lock-file.mjs), so parallel `--mark-tess` calls never drop each other's mark (concurrency R3); a lock
//   older than MARK_LOCK_STALE_MS was left by a killed call and is broken.
import { join } from 'node:path';
import { releaseLock, takeLock } from '../../disk-free/lib/lock-file.mjs';
import { UsageError, gitFlag } from '../../git-tidy/lib/git.mjs';
import { checkBranchName } from '../../git-tidy/lib/lane-pool.mjs';
import { baseNames } from '../../git-tidy/lib/lane-release.mjs';
import { readPlainFile } from '../../../hooks/lib/plain-file.mjs';
import { privateFolder, readSessionFile, writeSessionFile } from '../../../hooks/lib/session-store.mjs';
import { boardDir } from './refresh.mjs';
import { pieceBranch } from './tick-features.mjs';

const MAX_PLAN_BYTES = 1024 * 1024;
const MAX_MARKS_BYTES = 64 * 1024;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const FORMAT_HINT = 'see "pieces.json" in ~/.claude/tools/board/README.md';
const MARK_LOCK_STALE_MS = 10_000; // a turn is one small read and one write: a lock this old was left by a killed --mark-tess
const MARK_LOCK_WAIT_MS = 2_000; // the longest a --mark-tess waits for its turn
const MARK_LOCK_RETRY_MS = 50;
const PAUSE = new Int32Array(new SharedArrayBuffer(4)); // Atomics.wait on it is a synchronous sleep

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isName = (value) => typeof value === 'string' && NAME.test(value);
const isPathList = (value) => Array.isArray(value) && value.every((path) => typeof path === 'string' && path !== '');
const duplicateOf = (ids) => ids.find((id, at) => ids.indexOf(id) !== at);

/** The first thing wrong with one feature entry, or null. */
function featureProblem(feature) {
  if (!isObject(feature) || !isName(feature.id)) return 'a feature needs an "id" of letters, digits, - and _';
  if (typeof feature.risk !== 'string' || feature.risk === '') return `feature ${feature.id} needs a "risk" ("none", or the risk classes)`;
  return null;
}

/** The first thing wrong with one piece entry, or null. */
function pieceProblem(piece, featureIds, pieceIds) {
  if (!isObject(piece) || !isName(piece.id)) return 'a piece needs an "id" of letters, digits, - and _';
  if (!featureIds.includes(piece.feature)) return `piece ${piece.id} names no feature of the plan`;
  if (!isPathList(piece.files)) return `piece ${piece.id} needs "files": a list of repository-relative paths`;
  const after = piece.after ?? [];
  if (!Array.isArray(after) || !after.every((id) => pieceIds.includes(id))) return `piece ${piece.id} has an "after" entry that is no piece of the plan`;
  return null;
}

/** The first thing wrong with the whole plan, or null. */
function planProblem(plan) {
  if (!isObject(plan)) return 'it is not a JSON object';
  if (!isName(plan.job)) return '"job" must be a name of letters, digits, - and _';
  if (!Array.isArray(plan.features) || !Array.isArray(plan.pieces)) return 'it needs a "features" list and a "pieces" list';
  const problem = plan.features.map(featureProblem).find((found) => found !== null);
  if (problem !== undefined) return problem;
  const featureIds = plan.features.map((feature) => feature.id);
  const pieceIds = plan.pieces.map((piece) => (isObject(piece) ? piece.id : null));
  const repeated = duplicateOf(featureIds) ?? duplicateOf(pieceIds);
  if (repeated !== undefined) return `the id ${repeated} is used twice`;
  return plan.pieces.map((piece) => pieceProblem(piece, featureIds, pieceIds)).find((found) => found !== null) ?? null;
}

/** Whether `branch` is a name `lane claim --branch` takes: checkBranchName's refusal is a UsageError, anything else a real failure. */
function isPlainBranch(repo, branch) {
  try {
    checkBranchName(repo, branch);
    return true;
  } catch (error) {
    if (error instanceof UsageError) return false;
    throw error;
  }
}

/** The first thing wrong with the pieces' branches (a named one git refuses or that is a base, two pieces on one), or null. */
function branchProblem(repo, pieces) {
  const named = pieces.filter((piece) => piece.branch !== undefined);
  const bad = named.find((piece) => !isPlainBranch(repo, piece.branch));
  if (bad !== undefined) return `piece ${bad.id} has a "branch" that is no plain branch name (git check-ref-format --branch refuses it, or it starts with - or refs/)`;
  const base = named.find((piece) => baseNames(repo).has(piece.branch));
  if (base !== undefined) return `piece ${base.id} names the base branch ${base.branch}, which is never a lane`;
  const branches = pieces.map(pieceBranch);
  const second = branches.findIndex((branch, at) => branches.indexOf(branch) !== at);
  if (second === -1) return null;
  const first = branches.indexOf(branches[second]);
  return `pieces ${pieces[first].id} and ${pieces[second].id} name the same branch ${branches[second]}`;
}

/**
 * Reads and checks a pieces.json.
 * @param {string} path the absolute path of the plan's pieces.json
 * @param {{ dir: string }} repo openRepo's result: a piece's `branch` is checked against its git and its base branches
 * @returns {{ job: string, features: { id: string, risk: string }[],
 *   pieces: { id: string, feature: string, files: string[], after: string[], branch: string | null }[] }} the plan, files with
 *   `/` separators, `branch` null when the piece names none (it is then `lane/<id>`)
 * @throws {UsageError} the file is missing, unreadable, not JSON or not in the pieces.json format (the message says which)
 */
export function readPlan(path, repo) {
  let text;
  try {
    text = readPlainFile(path, MAX_PLAN_BYTES);
  } catch (error) {
    throw new UsageError(error.code === 'ENOENT' ? `no plan file at ${path}` : `cannot read the plan file: ${error.message}`, { cause: error });
  }
  let plan;
  try {
    plan = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`the plan ${path} is not JSON (${error.message}); ${FORMAT_HINT}`, { cause: error });
  }
  const problem = planProblem(plan) ?? branchProblem(repo, plan.pieces);
  if (problem !== null) throw new UsageError(`the plan ${path} is not a valid pieces.json: ${problem}; ${FORMAT_HINT}`);
  return {
    job: plan.job,
    features: plan.features.map(({ id, risk }) => ({ id, risk })),
    // Windows paths in a plan written by hand: git names files with `/`
    pieces: plan.pieces.map(({ id, feature, files, after, branch }) => ({ id, feature, files: files.map((path) => path.replaceAll('\\', '/')), after: after ?? [], branch: branch ?? null })),
  };
}

const marksDir = (env) => join(boardDir(env), 'jobs');
const marksFile = (job, env) => join(marksDir(env), `${job}.json`);
const marksLock = (job, env) => join(marksDir(env), `${job}.lock`);
const isMark = (mark) => isObject(mark) && FULL_SHA.test(mark.sha) && typeof mark.at === 'string' && Number.isFinite(Date.parse(mark.at));

/**
 * The tess marks of a job: which feature tess was started on, at which main sha and when.
 * @param {string} job the plan's job (a NAME)
 * @param {object} [env] the environment (HOME), process.env by default
 * @returns {Record<string, { sha: string, at: string }>} the marks, {} when the job has none yet
 * @throws {UsageError} the file is a link, too big, not JSON or holds a bad mark (delete it, or fix the named entry)
 */
export function readMarks(job, env = process.env) {
  const file = marksFile(job, env);
  const text = readSessionFile(marksDir(env), job, MAX_MARKS_BYTES);
  if (text === null) return {};
  if (text === undefined) throw new UsageError(`cannot read the tess marks ${file}: not a plain file of yours, or over ${MAX_MARKS_BYTES} bytes`);
  let marks;
  try {
    marks = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`the tess marks ${file} are not JSON (${error.message}); delete the file to start the marks again`, { cause: error });
  }
  const bad = isObject(marks) ? Object.keys(marks).find((feature) => !isName(feature) || !isMark(marks[feature])) : '(the whole file)';
  if (bad !== undefined) throw new UsageError(`the tess marks ${file} hold a bad entry ${JSON.stringify(bad)}; fix or delete it`);
  return marks;
}

/**
 * Marks a feature as given to tess at a main sha (`tick --mark-tess`), keeping the job's other marks.
 * @param {{ repo: object, plan: object, feature: string, sha: string, env?: object, nowMs?: number }} mark openRepo's result, the
 *   plan (readPlan), the feature, the full main sha tess runs on, the environment (HOME) and now (epoch ms)
 * @returns {string} the marks file written
 * @throws {UsageError} the feature is not in the plan, the sha is not on the base, another --mark-tess held the job's lock for
 *   MARK_LOCK_WAIT_MS, the marks cannot be read (readMarks) or the file cannot be written
 */
export function writeMark({ repo, plan, feature, sha, env = process.env, nowMs = Date.now() }) {
  const ids = plan.features.map((entry) => entry.id);
  if (!ids.includes(feature)) throw new UsageError(`--mark-tess ${JSON.stringify(feature)} is no feature of the plan (${ids.join(', ')})`);
  if (!gitFlag(repo.dir, ['merge-base', '--is-ancestor', sha, repo.baseRef])) throw new UsageError(`--sha ${sha} is not on ${repo.base}: tess runs on the base`);
  const { job } = plan;
  const file = marksFile(job, env);
  const notPlain = `cannot write the tess marks ${file}: its folder or file is not a plain one of yours`;
  if (privateFolder(marksDir(env)) === undefined) throw new UsageError(notPlain); // the lock file goes in it, so it must be there first
  const lock = marksLock(job, env);
  const deadline = Date.now() + MARK_LOCK_WAIT_MS;
  // the real clock, not nowMs: a lock's age is measured against its file's mtime
  while (!takeLock(lock, Date.now(), MARK_LOCK_STALE_MS)) {
    if (Date.now() >= deadline) throw new UsageError(`another --mark-tess is writing ${file}; run it again`);
    Atomics.wait(PAUSE, 0, 0, MARK_LOCK_RETRY_MS);
  }
  try {
    const marks = { ...readMarks(job, env), [feature]: { sha, at: new Date(nowMs).toISOString() } };
    if (!writeSessionFile(marksDir(env), job, `${JSON.stringify(marks, null, 2)}\n`, { sweep: false })) throw new UsageError(notPlain);
  } finally {
    releaseLock(lock);
  }
  return file;
}
