// Purpose: the two files `board tick` reads beside git for each job: the plan's pieces.json (lex writes it next to the plan) and the
//   job's tess marks (written only by `tick --mark-tess`).
// Exports: readPlan(path, repo) -> plan, readMarks(repo, job, env) -> marks, writeMark({ repo, plan, feature, sha, env, nowMs }) ->
//   the marks file's path.
// Invariants: the boundary of the tick: every plan and marks file is checked here, so tick.mjs trusts what it gets; a missing or bad
//   plan, or a marks file that is not valid, throws UsageError, never a guess (the message starts `plan <path>: ` for a plan). Job,
//   feature and piece ids are safe file names (NAME, a subset of session-store.mjs isSessionId). The plan's `base` is a commit of
//   the repository (the base's sha when the plan was written). A piece's `branch` passes the check `lane claim --branch` makes
//   (lane-pool.mjs checkBranchName), is no base branch (git-tidy's lane-release.mjs baseNames) and no two pieces share a branch.
//   A piece's `files` is never empty, its `after` lists make no cycle (no piece of one could ever start), and each of its `waits`
//   (another job's branches that land first, at most MAX_WAITS) passes the same branch-name check.
//   Marks live per repository and job in `<repoStateDir>/marks-<job>.json` (tick-jobs.mjs; an old `<boardDir>/jobs/<job>.json` is
//   read when that file is not there yet, and never written) as `{ "<feature>": { "sha": "<40-hex>", "at": "<ISO>" } }`, written
//   through session-store.mjs: a temp file and a rename, no link followed, 0600, never swept (a job may wait more than a week). A
//   mark's read and write run under `marks-<job>.lock` beside it (tick-jobs.mjs withStateLock), so parallel `--mark-tess` calls never
//   drop each other's mark (concurrency R3).
import { join } from 'node:path';
import { UsageError, gitFlag, runGit } from '../../git-tidy/lib/git.mjs';
import { checkBranchName } from '../../git-tidy/lib/lane-pool.mjs';
import { baseNames } from '../../git-tidy/lib/lane-release.mjs';
import { readPlainFile } from '../../../hooks/lib/plain-file.mjs';
import { privateFolder, readSessionFile, writeSessionFile } from '../../../hooks/lib/session-store.mjs';
import { boardDir } from './refresh.mjs';
import { pieceBranch } from './tick-features.mjs';
import { repoStateDir, withStateLock } from './tick-jobs.mjs';

const MAX_PLAN_BYTES = 1024 * 1024;
const MAX_MARKS_BYTES = 64 * 1024;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHORT_SHA = 8;
const FORMAT_HINT = 'see "pieces.json" in ~/.claude/tools/board/README.md';
const MARKS_PREFIX = 'marks-';
// the optional text fields a plan may give, kept for the briefs the board prints (plan-core-best, cb-start-1)
const FEATURE_TEXTS = Object.freeze(['spec', 'qa', 'acceptance']);
const PIECE_TEXTS = Object.freeze(['acceptance']);
const MAX_WAITS = 16; // a piece waits on a few branches of other jobs; more is a plan written wrong

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isName = (value) => typeof value === 'string' && NAME.test(value);
const isPathList = (value) => Array.isArray(value) && value.length > 0 && value.every((path) => typeof path === 'string' && path !== '');
const isWaitList = (value) => Array.isArray(value) && value.length <= MAX_WAITS && value.every((branch) => typeof branch === 'string');
const duplicateOf = (ids) => ids.find((id, at) => ids.indexOf(id) !== at);
/** The first of `names` that `entry` gives as something other than a string, or undefined. */
const badText = (entry, names) => names.find((name) => entry[name] !== undefined && typeof entry[name] !== 'string');
/** The optional text fields of `entry` it gives, and only those. */
const textsOf = (entry, names) => Object.fromEntries(names.filter((name) => entry[name] !== undefined).map((name) => [name, entry[name]]));

/** The first thing wrong with one feature entry, or null. */
function featureProblem(feature) {
  if (!isObject(feature) || !isName(feature.id)) return 'a feature needs an "id" of letters, digits, - and _';
  if (typeof feature.risk !== 'string' || feature.risk === '') return `feature ${feature.id} needs a "risk" ("none", or the risk classes)`;
  const bad = badText(feature, FEATURE_TEXTS);
  return bad === undefined ? null : `feature ${feature.id} has a non-string "${bad}"`;
}

/** The first thing wrong with one piece entry, or null. */
function pieceProblem(piece, featureIds, pieceIds) {
  if (!isObject(piece) || !isName(piece.id)) return 'a piece needs an "id" of letters, digits, - and _';
  if (!featureIds.includes(piece.feature)) return `piece ${piece.id} names no feature of the plan`;
  if (!isPathList(piece.files)) return `piece ${piece.id} needs "files": a non-empty list of repository-relative paths`;
  const after = piece.after ?? [];
  if (!Array.isArray(after) || !after.every((id) => pieceIds.includes(id))) return `piece ${piece.id} has an "after" entry that is no piece of the plan`;
  if (!isWaitList(piece.waits ?? [])) return `piece ${piece.id} needs "waits" as a list of at most ${MAX_WAITS} branch names`;
  const bad = badText(piece, PIECE_TEXTS);
  return bad === undefined ? null : `piece ${piece.id} has a non-string "${bad}"`;
}

/** The first thing wrong with the whole plan, or null. */
function planProblem(plan) {
  if (!isObject(plan)) return 'it is not a JSON object';
  if (!isName(plan.job)) return '"job" must be a name of letters, digits, - and _';
  if (!FULL_SHA.test(plan.base ?? '')) return '"base" must be the full 40-hex sha of the base when the plan was written';
  if (!Array.isArray(plan.features) || !Array.isArray(plan.pieces)) return 'it needs a "features" list and a "pieces" list';
  const problem = plan.features.map(featureProblem).find((found) => found !== null);
  if (problem !== undefined) return problem;
  const featureIds = plan.features.map((feature) => feature.id);
  const pieceIds = plan.pieces.map((piece) => (isObject(piece) ? piece.id : null));
  const repeated = duplicateOf(featureIds) ?? duplicateOf(pieceIds);
  if (repeated !== undefined) return `the id ${repeated} is used twice`;
  const pieceIssue = plan.pieces.map((piece) => pieceProblem(piece, featureIds, pieceIds)).find((found) => found !== null);
  if (pieceIssue !== undefined) return pieceIssue;
  const cycle = afterCycle(plan.pieces);
  return cycle === null ? null : `piece ${cycle[0]} is in an "after" cycle (${cycle.join(' -> ')}), so none of them can ever start`;
}

/** One cycle of the pieces' `after` lists as piece ids, its first id again at the end (`a -> b -> a`), or null when there is none. */
function afterCycle(pieces) {
  const left = new Map(pieces.map((piece) => [piece.id, piece.after ?? []]));
  // peel off each piece none of whose `after` pieces is left, until a round peels none: what stays is on a cycle or after one
  let isPeeled = true;
  while (isPeeled) {
    isPeeled = false;
    for (const [id, after] of left) {
      if (after.some((other) => left.has(other))) continue;
      left.delete(id);
      isPeeled = true;
    }
  }
  if (left.size === 0) return null;
  // every piece left is after one left, so stepping from one to the next must come back to a piece already passed: the cycle
  const path = [left.keys().next().value];
  while (!path.slice(0, -1).includes(path.at(-1))) path.push(left.get(path.at(-1)).find((other) => left.has(other)));
  return path.slice(path.indexOf(path.at(-1)));
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

/** The first thing wrong with the plan in this repository: its base no commit here, or a problem of its pieces' branches or waits; or null. */
function repoProblem(repo, plan) {
  // plumbing with a full sha: `cat-file -e` exits 0 only for an object of the repository, and `^{commit}` makes it a commit
  if (runGit(repo.dir, ['cat-file', '-e', `${plan.base}^{commit}`]).status !== 0) return `"base" ${plan.base.slice(0, SHORT_SHA)} is no commit of this repository`;
  return branchProblem(repo, plan.pieces) ?? waitsProblem(repo, plan.pieces);
}

/** The first piece with a `waits` entry that is no plain branch name, as a problem, or null. */
function waitsProblem(repo, pieces) {
  const bad = pieces.find((piece) => (piece.waits ?? []).some((branch) => !isPlainBranch(repo, branch)));
  return bad === undefined ? null : `piece ${bad.id} has a "waits" entry that is no plain branch name (git check-ref-format --branch refuses it, or it starts with - or refs/)`;
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
 * @param {{ dir: string }} repo openRepo's result: a piece's `branch` and `waits` are checked against its git, `branch` also against
 *   its base branches
 * @returns {{ job: string, base: string, features: { id: string, risk: string, spec?: string, qa?: string, acceptance?: string }[],
 *   pieces: { id: string, feature: string, files: string[], after: string[], branch: string | null, waits?: string[],
 *   acceptance?: string }[] }} the plan, files with `/` separators, `branch` null when the piece names none (it is then
 *   `lane/<id>`), `waits` and each optional text only when the plan gives them
 * @throws {UsageError} `plan <path>: <problem>`: the file is missing, unreadable, not JSON or not in the pieces.json format
 */
export function readPlan(path, repo) {
  const refuse = (problem, cause) => new UsageError(`plan ${path}: ${problem}`, { cause });
  let text;
  try {
    text = readPlainFile(path, MAX_PLAN_BYTES);
  } catch (error) {
    throw refuse(error.code === 'ENOENT' ? 'there is no such file' : `it cannot be read (${error.message})`, error);
  }
  let plan;
  try {
    plan = JSON.parse(text);
  } catch (error) {
    throw refuse(`it is not JSON (${error.message}); ${FORMAT_HINT}`, error);
  }
  const problem = planProblem(plan) ?? repoProblem(repo, plan);
  if (problem !== null) throw refuse(`it is not a valid pieces.json: ${problem}; ${FORMAT_HINT}`);
  return {
    job: plan.job,
    base: plan.base,
    features: plan.features.map((feature) => ({ id: feature.id, risk: feature.risk, ...textsOf(feature, FEATURE_TEXTS) })),
    pieces: plan.pieces.map((piece) => ({
      id: piece.id,
      feature: piece.feature,
      // Windows paths in a plan written by hand: git names files with `/`
      files: piece.files.map((file) => file.replaceAll('\\', '/')),
      after: piece.after ?? [],
      branch: piece.branch ?? null,
      ...(piece.waits === undefined ? {} : { waits: piece.waits }),
      ...textsOf(piece, PIECE_TEXTS),
    })),
  };
}

const oldMarksDir = (env) => join(boardDir(env), 'jobs'); // before marks were kept per repository: read, never written
const marksName = (job) => `${MARKS_PREFIX}${job}`;
const isMark = (mark) => isObject(mark) && FULL_SHA.test(mark.sha) && typeof mark.at === 'string' && Number.isFinite(Date.parse(mark.at));

/** The job's marks file and its text: the per-repository one, else the old one; text null when neither is there. */
function marksText(repo, job, env) {
  const dir = repoStateDir(repo.dir, env);
  const text = readSessionFile(dir, marksName(job), MAX_MARKS_BYTES);
  if (text !== null) return { file: join(dir, `${marksName(job)}.json`), text };
  return { file: join(oldMarksDir(env), `${job}.json`), text: readSessionFile(oldMarksDir(env), job, MAX_MARKS_BYTES) };
}

/**
 * The tess marks of a job: which feature tess was started on, at which base sha and when.
 * @param {{ dir: string }} repo openRepo's result: marks are kept per repository
 * @param {string} job the plan's job (a NAME)
 * @param {object} [env] the environment (HOME), process.env by default
 * @returns {Record<string, { sha: string, at: string }>} the marks, {} when the job has none yet
 * @throws {UsageError} the file is a link, too big, not JSON or holds a bad mark (delete it, or fix the named entry)
 */
export function readMarks(repo, job, env = process.env) {
  const { file, text } = marksText(repo, job, env);
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
 * Marks a feature as given to tess at a base sha (`tick --mark-tess`), keeping the job's other marks (an old marks file's too).
 * @param {{ repo: object, plan: object, feature: string, sha: string, env?: object, nowMs?: number }} mark openRepo's result, the
 *   plan (readPlan), the feature, the full base sha tess runs on, the environment (HOME) and now (epoch ms)
 * @returns {string} the marks file written
 * @throws {UsageError} the feature is not in the plan, the sha is not on the base, another --mark-tess held the job's lock the
 *   whole wait (withStateLock), the marks cannot be read (readMarks) or the file cannot be written
 */
export function writeMark({ repo, plan, feature, sha, env = process.env, nowMs = Date.now() }) {
  const ids = plan.features.map((entry) => entry.id);
  if (!ids.includes(feature)) throw new UsageError(`--mark-tess ${JSON.stringify(feature)} is no feature of the plan (${ids.join(', ')})`);
  if (!gitFlag(repo.dir, ['merge-base', '--is-ancestor', sha, repo.baseRef])) throw new UsageError(`--sha ${sha} is not on ${repo.base}: tess runs on the base`);
  const name = marksName(plan.job);
  const dir = repoStateDir(repo.dir, env);
  const file = join(dir, `${name}.json`);
  const notPlain = `cannot write the tess marks ${file}: its folder or file is not a plain one of yours`;
  if (privateFolder(dir) === undefined) throw new UsageError(notPlain); // the lock file goes in it, so it must be there first
  withStateLock(join(dir, `${name}.lock`), `another --mark-tess is writing ${file}; run it again`, () => {
    const marks = { ...readMarks(repo, plan.job, env), [feature]: { sha, at: new Date(nowMs).toISOString() } };
    if (!writeSessionFile(dir, name, `${JSON.stringify(marks, null, 2)}\n`, { sweep: false })) throw new UsageError(notPlain);
  });
  return file;
}
