// Runs one planned check of the typecheck gate and judges what it printed. Split from typecheck-gate.mjs, which would pass
// 300 lines with it.
// Exports: runPlan(packageDir, plan, deadline), notRun(plan, reason).
// A plan is { files, skipped } or { files, id, dir, cwd, check, config?, listsFiles?, info? } (typecheck-gate.mjs builds them).
// A result is { timedOut, lines, unparsed, keep, entries, timeoutId? }: `lines` are diagnostics about the plan's files,
// `unparsed` what the user is told when the check could not say anything about them, `keep` the files whose edit-log
// entries must stay, `entries` the run-log lines ({ outcome, exit, ms }), `timeoutId` the plan's id when it was killed.
// Invariants: a diagnostic counts for a logged file only when the path it names resolves to that file from the folder the
// command ran in, the plan's folder or the package folder: a file of the same name elsewhere (a sibling package's
// `src/index.ts`) never blocks. `keep` is empty only when the check ran to its end and found nothing about the files, or
// they are not in the tsconfig's program: a skipped, killed or unstartable check forgets no edit. Nothing here waits past
// the deadline: every command gets what is left of it.
import { realpathSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { MAX_LINES, diagnosticsDetailed } from './diagnostics.mjs';
import { closeBuildInfo, seedBuildInfo } from './typecheck-build-info.mjs';
import { SKIPPED, configSkip, pathKey, splitListedFiles } from './typecheck-plan.mjs';
import { packageManager, runCheck } from '../post-edit.mjs';

const TSCONFIG_FILE = /(^|[\\/])tsconfig[^\\/]*\.json$/; // a diagnostic about the config: tsc checked no source file
const FOUND_NOTHING = Object.freeze({ timedOut: false, lines: [], unparsed: [] });

const unique = (items) => [...new Set(items)];
const entryOf = (outcome, exit = null, ms = 0) => ({ outcome, exit, ms });
const lastLines = (output) => output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-MAX_LINES);

/**
 * The result of a plan that did not run: its files stay in the edit log and the run log says why.
 * @param {{files: string[]}} plan the plan
 * @param {string} reason a skip reason of lib/typecheck-plan.mjs; `budget spent` also counts as timed out
 */
export function notRun(plan, reason) {
  return { ...FOUND_NOTHING, timedOut: reason === SKIPPED.budgetSpent, keep: plan.files, entries: [entryOf(`skipped: ${reason}`)] };
}

function realOf(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return path; // gone: compare it as it is written
  }
}

// The test "does this reported path name `file`": resolved from each of `bases` (as written and as real paths).
function aboutFile(file, bases) {
  const targets = new Set([resolve(file), realOf(file)]);
  const from = unique(bases.flatMap((base) => [base, realOf(base)]));
  return (reported) => from.some((base) => targets.has(resolve(base, reported)));
}

// Real diagnostics about the logged files win. Without one: diagnostics about a tsconfig (tsc refused the options and
// checked nothing), else the raw output tail when no line parsed at all, go to the user.
function judgeOutput(output, files, bases) {
  const details = files.map((file) => diagnosticsDetailed(output, file, aboutFile(file, bases)));
  const lines = unique(details.filter((d) => d.parsed).flatMap((d) => d.lines));
  if (lines.length) return { lines, unparsed: [] };
  const config = diagnosticsDetailed(output, '', (reported) => TSCONFIG_FILE.test(reported));
  return { lines: [], unparsed: config.parsed ? config.lines : unique(details.flatMap((d) => d.lines)) };
}

// The command as the run log names it: the tool by name (not its path), then its arguments.
const commandText = (pm, check) => [basename(check.cmd ?? pm).replace(/\.cmd$/i, ''), ...check.args].join(' ');

function exitOf(run) {
  if (run.timedOut) return 'timeout';
  return run.error ? 'error' : run.status;
}

// Runs one command of a plan within what is left of the deadline: { run, entry } when it ran to its end, else { result }.
async function start(plan, check, packageDir, deadline) {
  const left = deadline - Date.now();
  if (left <= 0) return { result: notRun(plan, SKIPPED.budgetSpent) };
  const pm = packageManager(packageDir);
  const run = await runCheck(pm, check, plan.cwd, left);
  const entry = entryOf(`ran: ${commandText(pm, check)}`, exitOf(run), left - (deadline - Date.now()));
  if (run.timedOut) return { result: { ...FOUND_NOTHING, timedOut: true, timeoutId: plan.id, keep: plan.files, entries: [entry] } };
  if (!run.error) return { run, entry };
  const rel = relative(packageDir, plan.files[0]).replace(/\\/g, '/');
  const unparsed = [`${rel}:1 HOOK could not run ${check.name}: ${run.error.message}`];
  return { result: { ...FOUND_NOTHING, unparsed, keep: plan.files, entries: [entry] } };
}

// The result when the resolved config says the tsconfig must not be run (or cannot be resolved: the user sees why), else null.
async function refusedByConfig(plan, packageDir, deadline) {
  if (!plan.config) return null;
  const { run, result } = await start(plan, { name: 'typecheck', ...plan.config }, packageDir, deadline);
  if (result) return result;
  const reason = run.status === 0 ? configSkip(run.stdout) : SKIPPED.unreadableTsconfig;
  if (!reason) return null;
  const unparsed = reason === SKIPPED.unreadableTsconfig ? lastLines(`${run.stdout}\n${run.stderr}`) : [];
  return { ...notRun(plan, reason), unparsed };
}

// What a finished run says: diagnostics about the plan's files, and which of them tsc did not have in its program (`outside`;
// known only when it listed its files).
function judge(plan, packageDir, run) {
  const { listed, rest } = plan.listsFiles ? splitListedFiles(run.stdout) : { listed: new Set(), rest: run.stdout };
  const isListed = (file) => listed.has(pathKey(file)) || listed.has(pathKey(realOf(file)));
  const outside = listed.size ? plan.files.filter((file) => !isListed(file)) : [];
  if (run.status === 0) return { lines: [], unparsed: [], outside };
  const inside = plan.files.filter((file) => !outside.includes(file));
  return { ...judgeOutput(`${rest}\n${run.stderr}`, inside, unique([plan.cwd, plan.dir, packageDir])), outside };
}

async function typecheck(plan, packageDir, deadline) {
  const cold = plan.info ? seedBuildInfo(plan.info) : null;
  const before = cold ? [entryOf(`cold: ${cold}`)] : [];
  const { run, entry, result } = await start(plan, plan.check, packageDir, deadline);
  if (result) return { ...result, entries: [...before, ...result.entries] };
  if (plan.info) closeBuildInfo(plan.info, true);
  const { lines, unparsed, outside } = judge(plan, packageDir, run);
  const entries = [...before, entry, ...(outside.length ? [entryOf(`skipped: ${SKIPPED.notInTsconfig}`)] : [])];
  return { ...FOUND_NOTHING, lines, unparsed, keep: lines.length ? plan.files.filter((file) => !outside.includes(file)) : [], entries };
}

/**
 * Runs one plan within the deadline.
 * @param {string} packageDir the package folder of the plan's files
 * @param {object} plan see the header
 * @param {number} deadline epoch ms
 * @returns {Promise<object>} the result, see the header
 */
export async function runPlan(packageDir, plan, deadline) {
  if (plan.skipped) return notRun(plan, plan.skipped);
  try {
    return (await refusedByConfig(plan, packageDir, deadline)) ?? (await typecheck(plan, packageDir, deadline));
  } finally {
    if (plan.info) closeBuildInfo(plan.info, false); // what was not published goes with the run's folder
  }
}
