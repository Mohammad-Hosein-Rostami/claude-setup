// Purpose: the UI check plan of a landing (ui-kinds-spec.md section 3): `land-lane` computes it with `ui-proof plan` from the lane's diff,
//   its brief (the owner's request, quoted by the lead) and the lane's coverage matrix in the road beside the STATUS.md; `git-tidy land`
//   proves it (`ui-proof check --plan`) right before the fast-forward.
// Exports: laneMatrix(options), requireBriefForApp(options), planAt(options, base, tip, matrix) -> { depth, tests }, restartPlan(options, range, matrix).
// Invariants: every input is the lead's flag or git's (P14): no lane report reaches the plan; a road file or a plan that cannot be read
//   is exit 14 and nothing lands (P3); a brief that cannot be read, or none for a diff that changes the app, is exit 2 before anything
//   runs. STATUS rule and decision lines are no request text (ui-proof reads only the brief); the STATUS.md gives the road, and the road
//   the lane's matrix. A lane with no app change pays one plan computation and nothing else.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { runPlanCheck } from '../../git-tidy/lib/ui-plan-check.mjs';
import { readRoad } from '../../road/lib/road-file.mjs';
import { DEPTHS } from '../../ui-proof/lib/ui-evidence.mjs';
import { UsageError } from './args.mjs';
import { stop } from './stop.mjs';
import { firstLine, git, parseJson, tool } from './tools.mjs';

const PLAN_TIMEOUT_MS = 120_000; // the plan reads the screens of both commits (cached under the setup's state)
const ROAD_FILE = /^road-[a-z][a-z0-9-]{0,7}\.json$/; // road.mjs ROAD_FILE: the architect's road files beside STATUS.md
const ROAD_ROW = /^([a-z][a-z0-9-]{0,7})\.s([1-9]\d*)\.([\w.:-]+)$/; // `<road>.s<N>.<lane>`, `<lane>-land` (old form) or `fix-<lane>`
const NO_MATRIX = 'none:'; // road-file.mjs: a lane with no coverage matrix says `none: <reason>`
const UNREADABLE = /^evidence unreadable \(/; // ui-plan.mjs planChecks: the reason of the plan it falls back to when evidence fails

/** True when the row's lane part names `lane`: its own row, an old-form `-land` close row or a `fix-` row. */
const namesLane = (part, lane) => part === lane || part === `${lane}-land` || part === `fix-${lane}`;

/** The matrix paths (absolute) the roads beside the STATUS.md give the row's lane, from every road file of that road id. */
function matricesOf(folder, [, roadId, step, part]) {
  let names;
  try {
    names = readdirSync(folder).filter((name) => ROAD_FILE.test(name)).sort();
  } catch (error) {
    return stop(14, 'tool-failed', `the road files beside the STATUS.md cannot be listed (${error.message}): the lane's matrix is unknown, nothing was landed`);
  }
  const found = [];
  const broken = [];
  for (const name of names) {
    const read = readRoad(join(folder, name));
    if (read.road === null) { broken.push(`${name}: ${read.problems[0]}`); continue; }
    if (read.road.road !== roadId) continue;
    const lane = read.road.steps[Number(step) - 1]?.lanes.find((entry) => namesLane(part, entry.name));
    if (lane === undefined) continue;
    const matrix = typeof lane.matrix === 'string' && !lane.matrix.startsWith(NO_MATRIX) ? lane.matrix : null;
    found.push(matrix === null ? null : (isAbsolute(matrix) ? matrix : resolve(read.road.repo, matrix)));
  }
  return { found, broken };
}

/**
 * The lane's coverage matrix from its road: the road file beside the STATUS.md whose road id and step hold the --close-row's lane.
 * @param {{ statusFile: string, closeRow: string }} options the parsed arguments
 * @returns {string|null} an absolute path, or null: no road row, no road naming the lane, or a lane whose matrix says `none: <reason>`
 * @throws {import('./stop.mjs').Stop} exit 14 when the road files cannot be listed, the roads disagree, or only a broken road file
 *   can be the lane's (its matrix is unknown, and a missing matrix could drop the Figma frames that make a plan pixel)
 */
export function laneMatrix(options) {
  const row = ROAD_ROW.exec(options.closeRow);
  if (row === null) return null;
  const { found, broken } = matricesOf(dirname(options.statusFile), row);
  const distinct = [...new Set(found)];
  if (distinct.length > 1) stop(14, 'tool-failed', `the road files beside the STATUS.md give lane ${options.closeRow} different matrices (${distinct.join(', ')}): nothing was landed`);
  if (found.length === 0 && broken.length > 0) stop(14, 'tool-failed', `a road file beside the STATUS.md cannot be read (${broken[0]}), so the matrix of ${options.closeRow} is unknown: nothing was landed`);
  return distinct[0] ?? null;
}

/**
 * The check plan of `base..tip` by `ui-proof plan --json`, with the brief and the matrix.
 * @param {{ repo: string, brief: string|null }} options the parsed arguments
 * @param {string} base full sha; @param {string} tip full sha; @param {string|null} matrix absolute path or null
 * @returns {{ depth: string, tests: boolean }} the plan's depth and whether logic changed (done-check tests must be ok)
 * @throws {import('./stop.mjs').Stop} exit 14 when the plan cannot be computed or read (never a lighter plan)
 */
export function planAt(options, base, tip, matrix) {
  const extra = [...(options.brief === null ? [] : ['--request', options.brief]), ...(matrix === null ? [] : ['--matrix', matrix])];
  const run = tool('ui-proof', 'ui-proof.mjs', ['plan', '--base', base, '--tip', tip, ...extra, '--json', '--repo', options.repo], { timeoutMs: PLAN_TIMEOUT_MS });
  const plan = run.ok ? parseJson(run.out) : null;
  if (plan === null || !DEPTHS.includes(plan.depth) || typeof plan.tests !== 'boolean' || !Array.isArray(plan.reasons)) {
    stop(14, 'tool-failed', `the ui check plan of ${tip} could not be computed, nothing was landed: ${firstLine(run)}`);
  }
  // planChecks never throws: evidence it cannot read (a missing object, git failing) is its pixel plan with this reason. Here that is a
  // plan that could not be computed: exit 14, as for any tool that cannot run (P3).
  const unreadable = plan.reasons.find((line) => typeof line === 'string' && UNREADABLE.test(line));
  if (unreadable !== undefined) stop(14, 'tool-failed', `the ui check plan of ${tip} could not be computed, nothing was landed: ${unreadable}`);
  return { depth: plan.depth, tests: plan.tests };
}

/** Exit 2 when the brief file cannot be read as a regular file (git-tidy reads it again for the size rule). */
function assertBriefReadable(file) {
  try {
    readFileSync(file, { encoding: 'utf8', flag: 'r' });
  } catch (error) {
    throw new UsageError(`--brief ${file} cannot be read: ${error.message}`);
  }
}

/**
 * Before anything runs: a given brief must be readable, and a lane whose own diff (merge base..tip) changes the app needs one, since
 * the plan reads the owner's request in it (a design word, a no-change request, a `UI-PLAN:` floor only raise it).
 * @param {{ repo: string, base: string, tip: string, brief: string|null }} options the parsed arguments
 * @throws {UsageError} exit 2; {import('./stop.mjs').Stop} exit 14 when git or the plan cannot run
 */
export function requireBriefForApp(options) {
  if (options.brief !== null) return assertBriefReadable(options.brief);
  const mergeBase = git(options.repo, ['merge-base', `refs/heads/${options.base}`, options.tip]);
  if (!mergeBase.ok) stop(14, 'tool-failed', `git could not find where ${options.tip} left ${options.base}: ${firstLine(mergeBase)}`);
  const { depth } = planAt(options, mergeBase.out, options.tip, null);
  if (depth !== 'none') {
    throw new UsageError(`the lane changes the app (ui check plan ${depth}): give --brief <the lane's brief file>, the plan reads the owner's request in it; nothing ran`);
  }
}

/**
 * A landing found again after a restart (F2): the plan of its landed range, proved again from the records, so its row keeps the same
 * pointer a landing in one run writes. Null with a note when the range has no `from` or the plan does not hold now.
 * @returns {{ plan: { depth: string, followUps: string[] }|null, note: string|null }}
 */
export function restartPlan(options, { from, to }, matrix) {
  if (from === null) return { plan: null, note: null };
  const { why, plan } = runPlanCheck({ repoDir: options.repo, baseSha: from, tip: to, brief: options.brief, matrix });
  return why === null ? { plan, note: null } : { plan: null, note: `ui plan of the landed range not proved after the restart (the row has no plan pointer): ${why}` };
}
