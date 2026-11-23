// Purpose: `road.mjs land`: one lane's landing in one call: the road's join, then land-lane (the only landing route: road land never merges
//   or moves a branch itself), then the next launch list (`road.mjs next`). Also the join with its needs check, which `road.mjs join` runs.
// Exports: LAND_USAGE, joinWithNeeds(road, roadSha256, flags, { readItems, isOnBase }) -> { code, out },
//   landRoadLane(ctx, flags, { run, readRows, join, next }) -> { code, out }.
// Order of `land`:
//   1. With no subprocess: the flags, the road file's sha256, the lane, its landing row in STATUS.md and the step rows (usage 2, refused 1).
//      Refused: an unknown lane, no landing row (run `rows`), a step whose check row is done (its gate passed), and two steps open (a check
//      row done after an earlier open one: the rows do not say which step is open).
//   2. git reads the lane branch. At --tip: `join` runs (its needs check first); its exit 1, 2 or 3 is road land's exit and land-lane never
//      runs; a joined HEAD other than --tip is refused (1). Gone or at another commit: a re-run after a landing that stopped, so the join is
//      skipped and land-lane's own restart path decides: it records a landing already made or refuses (9, 14); it lands nothing new.
//   3. land-lane with the road's repo, lane branch, base, the STATUS.md beside the road, the lane's landing row (an old-form road: its
//      `-land` row), --worktree, and the lead's answer flags as given (--brief, --reviewed, --skip-review, --accept-open), always --json.
//   4. After land-lane exit 0 or 1: a `leftover:` line when the lane branch still exists (known: STATUS row fu.prune-rebased-reflog), and
//      `next` with --budget (default 5, the agent cap).
// Exit: road land's exit is the first failing step's: join's, else land-lane's unchanged, else next's (0 when all passed).
// Fail closed (P3): land-lane's exit counts only with its own one-line JSON report holding the same exit. No such report (killed,
//   crashed, timed out) is exit 14, and a re-run with the same --tip follows land-lane's restart path.
// Output: `join:`, the land-lane lines, `leftover:`, `next:` and a last `road land: exit <n>` line; with --json one object
//   `{ exit, join, joinSkipped, land, leftover, next }`.
import { isAbsolutePath } from '../../land-lane/lib/args.mjs';
import { LANE_NAME, rowIds } from './road-file.mjs';
import { GIT_TIMEOUT_MS } from './road-gate.mjs';
import { joinLane } from './road-join.mjs';
import { landingRowId, needsNotOnBase } from './road-state.mjs';

export const LAND_USAGE = 'land <road.json> --road-sha256 <hex> --lane <name> --worktree <abs> --base <40-hex> --tip <40-hex>'
  + ' [--brief <file>] [--reviewed <40-hex> | --skip-review <reason>] [--accept-open <reason>] [--budget <1-5>] [--json]';
const USAGE = `usage: road.mjs ${LAND_USAGE}`;
const EXIT = { refused: 1, usage: 2, toolFailed: 14 }; // 14 = land-lane's "a tool failed or could not run"
const LANDED_EXITS = [0, 1]; // land-lane: 0 landed clean, 1 landed with `git-tidy check` findings left
const DEFAULT_BUDGET = 5; // the agent cap (road.mjs next --budget 1-5)
// land-lane has no total deadline: each step has its own (git-tidy 10 min a call, the done-check about 5 min) and a base that moved repeats
// the rebase and land steps. Two hours is the longest a background command runs; a run killed at it is exit 14 and restarts.
const LAND_LANE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const FULL_SHA = /^[0-9a-f]{40}$/;
const MAX_SHOWN_CHARS = 80; // an unknown argument is shown cut to this length (P5)
const OWN_FLAGS = {
  '--road-sha256': ['sha256', (value) => /^[0-9a-f]{64}$/.test(value)], '--lane': ['lane', (value) => LANE_NAME.test(value)],
  '--worktree': ['worktree', isAbsolutePath], '--base': ['base', (value) => FULL_SHA.test(value)],
  '--tip': ['tip', (value) => FULL_SHA.test(value)], '--budget': ['budget', (value) => /^[1-5]$/.test(value)],
};
// land-lane's answer flags, passed on as given: land-lane checks their values and refuses a bad one (exit 2, passed through).
const PASSED_FLAGS = ['--brief', '--reviewed', '--skip-review', '--accept-open'];
const REQUIRED = ['sha256', 'lane', 'worktree', 'base', 'tip'];

class Usage extends Error {}
class Refused extends Error {}
class ToolFailed extends Error {}

const firstLine = (text) => String(text).trim().split('\n')[0] ?? '';

function parseObject(text) {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null; // not JSON: the caller treats it as no report (fail closed)
  }
}

/**
 * The join of one lane, after the road's needs check: every lane it needs has landed on the base in git (land-lane knows no road). A lane
 * not in the road goes to joinLane, which refuses it.
 * @param {object} road the checked road
 * @param {string} roadSha256 the sha256 of the road file's bytes
 * @param {string[]} flags the arguments after the road path
 * @param {{ readItems: () => object[], isOnBase: (sha: string) => boolean }} deps the STATUS.md rows and the git base check
 * @returns {{ code: number, out: string }} joinLane's result, or exit 1 naming the needed lanes not on the base
 */
export function joinWithNeeds(road, roadSha256, flags, { readItems, isOnBase }) {
  const at = flags.indexOf('--lane');
  const name = at === -1 ? undefined : flags[at + 1];
  if (road.steps.some((step) => step.lanes.some((lane) => lane.name === name))) {
    const missing = needsNotOnBase(road, readItems(), name, isOnBase);
    if (missing.length > 0) return { code: EXIT.refused, out: `refused: lane ${name} needs ${missing.join(', ')} landed on ${road.base} first (git does not show the landing a row records, or no row records one)` };
  }
  return joinLane(road, roadSha256, flags);
}

/** The flags of `land`, every value checked; answer flags kept in order for land-lane. @throws {Usage} */
function parseLandFlags(rest) {
  const options = { json: false, passed: [] };
  const seen = new Set();
  for (let at = 0; at < rest.length; at += 1) {
    const flag = rest[at];
    if (flag === '--json') options.json = true;
    else if (!Object.hasOwn(OWN_FLAGS, flag) && !PASSED_FLAGS.includes(flag)) throw new Usage(`unknown argument ${JSON.stringify(String(flag).slice(0, MAX_SHOWN_CHARS))}. ${USAGE}`);
    else {
      const value = rest[(at += 1)];
      if (seen.has(flag)) throw new Usage(`${flag} given twice. ${USAGE}`);
      seen.add(flag);
      if (value === undefined || value.startsWith('--')) throw new Usage(`${flag} needs a value. ${USAGE}`);
      if (PASSED_FLAGS.includes(flag)) options.passed.push(flag, value);
      else if (!OWN_FLAGS[flag][1](value)) throw new Usage(`${flag} needs a valid value. ${USAGE}`);
      else options[OWN_FLAGS[flag][0]] = value;
    }
  }
  for (const key of REQUIRED) if (options[key] === undefined) throw new Usage(`missing --${key === 'sha256' ? 'road-sha256' : key}. ${USAGE}`);
  return { ...options, budget: Number(options.budget ?? DEFAULT_BUDGET) };
}

/**
 * The lane, its step and its landing row, judged from the road file and the STATUS.md rows only (no subprocess). A table with any problem
 * is refused: a row it could not read could be a done check row (fail closed). @throws {Refused}
 */
function planLanding(ctx, options, { items, problems }) {
  const { road } = ctx;
  if (ctx.sha256 !== options.sha256) throw new Refused(`the road file's sha256 is ${ctx.sha256}, not --road-sha256 ${options.sha256}`);
  const index = road.steps.findIndex((step) => step.lanes.some((lane) => lane.name === options.lane));
  if (index === -1) throw new Refused(`lane ${options.lane} is not in the road`);
  if (problems.length > 0) throw new Refused(`${ctx.statusFile} is not fully understood (line ${problems[0].line}: ${problems[0].reason}): fix the table first`);
  const rows = new Map(items.map((item) => [item.id.toLowerCase(), item]));
  const step = index + 1;
  const closeRow = landingRowId(rows, road.road, step, options.lane);
  if (!rows.has(closeRow.toLowerCase())) throw new Refused(`no row ${closeRow} in ${ctx.statusFile}: run road.mjs rows first`);
  const checkDone = (n) => rows.get(rowIds(road.road, n, 'x').check.toLowerCase())?.done != null;
  if (checkDone(step)) throw new Refused(`step ${step}'s check row is done (its gate passed): a change after the gate is a fix row (road.mjs rows --fix)`);
  const firstOpen = road.steps.findIndex((_, at) => !checkDone(at + 1));
  const doneAfter = road.steps.findIndex((_, at) => at > firstOpen && checkDone(at + 1));
  if (doneAfter !== -1) throw new Refused(`two steps open: step ${firstOpen + 1}'s check row is open but step ${doneAfter + 1}'s is done, so the rows do not say which step is open`);
  return { lane: road.steps[index].lanes.find((lane) => lane.name === options.lane), step, closeRow };
}

/** The sha the lane branch points at, or null when it does not exist. @throws {ToolFailed} when git cannot tell */
function branchTip(run, road, branch) {
  const read = run('git', ['-C', road.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], GIT_TIMEOUT_MS);
  const sha = read.out.trim();
  if (read.exit === 0 && FULL_SHA.test(sha)) return sha;
  if (read.exit === 1) return null;
  throw new ToolFailed(`git could not read branch ${branch} in ${road.repo} (exit ${read.exit}): ${firstLine(read.out)}`);
}

/** Step 2 at --tip: the join; `stop` is its exit when it did not join this very tip clean. */
function joinStep(join, options) {
  const joined = join(['--road-sha256', options.sha256, '--lane', options.lane, '--worktree', options.worktree, '--base', options.base, '--json']);
  const report = parseObject(joined.out);
  if (joined.code !== 0) return { stop: joined.code, report: report ?? joined.out, problem: null };
  if (report?.joined === options.tip) return { stop: null, report, problem: null };
  return { stop: EXIT.refused, report: report ?? joined.out, problem: `refused: the join read HEAD ${report?.joined ?? 'unknown'} of ${options.worktree}, not --tip ${options.tip}: land-lane would land another commit than the one judged` };
}

/** land-lane's own report: the last output line that is its `--json` object `{ state, exit, lines }`, or null. */
function landLaneReport(out) {
  const reports = String(out).split('\n').map(parseObject)
    .filter((value) => typeof value?.state === 'string' && Number.isInteger(value.exit) && Array.isArray(value.lines) && value.lines.every((line) => typeof line === 'string'));
  return reports.at(-1) ?? null;
}

/** Step 3: land-lane; its exit passes through unchanged when its report agrees with it, else exit 14. */
function landStep(run, ctx, options, plan) {
  const args = ['--repo', ctx.road.repo, '--branch', plan.lane.branch, '--tip', options.tip, '--base', ctx.road.base, '--status-file', ctx.statusFile,
    '--close-row', plan.closeRow, '--worktree', options.worktree, ...options.passed, '--json'];
  const ran = run('land-lane', args, LAND_LANE_TIMEOUT_MS);
  const report = landLaneReport(ran.out);
  if (report !== null && report.exit === ran.exit) return { exit: report.exit, report, lines: [`land: ${report.state}`, ...report.lines] };
  const why = `land-lane did not finish (exit ${ran.exit}, no report with that exit): it may have stopped mid-way; run road.mjs land again with the same --tip and land-lane's restart path finds a landing already made`;
  return { exit: EXIT.toolFailed, report: null, lines: [`land: ${why}`, ...(firstLine(ran.out) ? [`land-lane said: ${firstLine(ran.out).slice(0, 2 * MAX_SHOWN_CHARS)}`] : [])] };
}

/** The `leftover:` line after a landing: the lane branch still exists (prune kept it), or git could not tell; null when it is gone. */
function leftoverLine(run, road, branch) {
  try {
    const tip = branchTip(run, road, branch);
    return tip === null ? null : `leftover: branch ${branch} still exists after the landing, at ${tip} (with its worktree, if any): known, STATUS row fu.prune-rebased-reflog`;
  } catch (error) {
    if (!(error instanceof ToolFailed)) throw error;
    return `leftover: unknown: ${error.message}`;
  }
}

/** Step 4: next, as `road.mjs next --budget <n>` prints it; a failure of next is its own exit 1, never lost with the landing's output. */
function nextStep(next, budget) {
  try {
    return next(budget);
  } catch (error) {
    return { code: EXIT.refused, out: `next failed: ${error.message}` };
  }
}

function render(options, result) {
  const { exit, join, joinSkipped, land, leftover, listed } = result;
  if (options.json) {
    return JSON.stringify({ exit, join: join?.report ?? null, joinSkipped, land: land?.report ?? null, leftover, next: listed === null ? null : { exit: listed.code, out: listed.out } });
  }
  const joinLines = joinSkipped !== null ? [`join: skipped: ${joinSkipped}`] : join === null ? [] : [`join: ${typeof join.report === 'string' ? join.report : JSON.stringify(join.report)}`, ...(join.problem ? [join.problem] : [])];
  return [...joinLines, ...(land?.lines ?? []), ...(leftover ? [leftover] : []), ...(listed ? ['next:', listed.out] : []), `road land: exit ${exit}`].join('\n');
}

/** Steps 2-4 after the plan; returns what render prints. */
function landPlanned(ctx, options, plan, deps) {
  const result = { exit: 0, join: null, joinSkipped: null, land: null, leftover: null, listed: null };
  const current = branchTip(deps.run, ctx.road, plan.lane.branch);
  if (current === options.tip) {
    result.join = joinStep(deps.join, options);
    if (result.join.stop !== null) return { ...result, exit: result.join.stop };
  } else {
    result.joinSkipped = `branch ${plan.lane.branch} is ${current === null ? 'gone' : `at ${current}`}, not at --tip ${options.tip}: a re-run after a landing that stopped; land-lane's restart path decides and lands nothing new`;
  }
  result.land = landStep(deps.run, ctx, options, plan);
  if (!LANDED_EXITS.includes(result.land.exit)) return { ...result, exit: result.land.exit };
  result.leftover = leftoverLine(deps.run, ctx.road, plan.lane.branch);
  result.listed = nextStep(deps.next, options.budget);
  return { ...result, exit: result.land.exit !== 0 ? result.land.exit : result.listed.code };
}

/**
 * Runs `road.mjs land` for a road that readRoad accepted.
 * @param {{ road: object, sha256: string, statusFile: string }} ctx the checked road, the sha256 of its bytes, the STATUS.md beside it
 * @param {string[]} flags the arguments after the road path
 * @param {{ run: (file: string, argv: string[], timeoutMs: number) => { exit: number, out: string }, readRows: () => { items: object[], problems: object[] },
 *   join: (flags: string[]) => { code: number, out: string }, next: (budget: number) => { code: number, out: string } }} deps road.mjs's
 *   program runner (git, land-lane), the STATUS.md rows, its join and its next
 * @returns {{ code: number, out: string }} the exit (above) and the report
 */
export function landRoadLane(ctx, flags, deps) {
  let options = { json: flags.includes('--json') };
  try {
    options = parseLandFlags(flags);
    const plan = planLanding(ctx, options, deps.readRows());
    const result = landPlanned(ctx, options, plan, deps);
    return { code: result.exit, out: render(options, result) };
  } catch (error) {
    if (error instanceof Usage) return { code: EXIT.usage, out: `road: ${error.message}` };
    const code = error instanceof Refused ? EXIT.refused : error instanceof ToolFailed ? EXIT.toolFailed : null;
    if (code === null) throw error;
    const word = code === EXIT.refused ? 'refused' : 'tool failed';
    return { code, out: options.json ? JSON.stringify({ exit: code, [code === EXIT.refused ? 'refused' : 'failed']: error.message }) : `${word}: ${error.message}` };
  }
}
