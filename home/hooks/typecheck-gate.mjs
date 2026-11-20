// Stop / SubagentStop: typecheck the files this agent edited, once, instead of after every edit (post-edit.mjs logs them).
// Per package of a logged file, the first that applies: (1) its `typecheck` / `type-check` script unless it targets the
// whole repo; (2) the nearest tsconfig.json of each file with the project's own `tsc --noEmit`; (3) else skipped with the
// reason. lib/typecheck-plan.mjs builds the commands.
// Exports: incrementalTypecheck, typescriptMajor (from lib/typecheck-plan.mjs), runGate(files, deadline, record),
// timeoutMessage(unchecked), decideExit(result, logPath, stopHookActive), runLogPath(env), MAX_RUN_LOG_BYTES.
// Invariants: silent and exit 0 when nothing was logged, when CLAUDE_TYPECHECK_AT=edit or typecheck is skipped; only
// real diagnostics about logged files exit 2 (the agent keeps running and fixes them); a timeout, a typecheck that
// cannot run (no diagnostic parses), a skipped package and a failure the user was already shown never block.
// The shared tsbuildinfo makes later runs incremental; each run writes a private copy and renames it over the shared one.
// Run log: one JSON line per check of a Stop/SubagentStop that has logged edits, in ~/.claude/logs/typecheck-gate.jsonl
// (override: CLAUDE_TYPECHECK_LOG): `ts`, `session`, `agent`, `dir` (the package folder), `outcome` (`ran: <command>` or
// `skipped: <reason>`), `exit` (the exit code, `timeout`, `error` when it could not start, null when skipped) and `ms`.
// A package whose files sit under different tsconfigs gets one line for each. A stop with no logged edits writes nothing;
// at MAX_RUN_LOG_BYTES no line is written; a log that cannot be written never changes the decision.
// The gate runs project code (the script, tsc) with the trust the project's typecheck script already had, only in
// packages this agent edited; what reaches the agent on exit 2 is at most 15 lines about logged files.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAX_LINES, diagnosticsDetailed } from './lib/diagnostics.mjs';
import { editLogPath, readEdits, tempRoot } from './lib/edit-log.mjs';
import { appendPlainFile } from './lib/plain-file.mjs';
import { SKIPPED, incrementalTypecheck, nearestTsconfig, projectBin, projectFolders, readJsonFile, tsconfigTypecheck, typescriptMajor } from './lib/typecheck-plan.mjs';
import { SKIP_ENV, findPackageDir, isBroadScript, packageManager, runCheck, skipFilter, typecheckAtEdit, typecheckScript } from './post-edit.mjs';

export { incrementalTypecheck, typescriptMajor } from './lib/typecheck-plan.mjs';

const BUDGET_MS = 140_000; // hook timeout is 150 s
const GIT_TOP_TIMEOUT_MS = 3000; // one `git rev-parse` per package, inside the budget; it normally takes a few ms
const MAX_NAMED_FILES = 10;
/** The most the run log holds: 1 MB is about 4,000 lines; at the cap no line is written, so the log cannot fill the disk. */
export const MAX_RUN_LOG_BYTES = 1024 * 1024;
const RUN_LOG_FILE = join(homedir(), '.claude', 'logs', 'typecheck-gate.jsonl');
const RUN_LOG_DIR_MODE = 0o700; // the log names project folders: only the owner reads it
const MAIN_AGENT = 'main';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const unique = (items) => [...new Set(items)];
const skip = (files, reason) => ({ files, skipped: reason });

// A command of lib/typecheck-plan.mjs, or its skip, as the plan for `files`; `info`: the build-info paths of a tsc run.
function planFor(files, cwd, command, info = {}) {
  if (command.skipped) return skip(files, command.skipped);
  return { files, cwd, check: { name: 'typecheck', cmd: command.cmd, args: command.args, env: command.env }, ...info };
}

// The shared build info of one check (keyed by the package folder or the tsconfig) and this run's private copy of it.
function buildInfoFor(key) {
  const shared = join(tempRoot(), 'tsbuildinfo', sha256(key));
  return { shared, privateInfo: `${shared}.${process.pid}` };
}

// Step 1: the package's own typecheck script (`script`: its { name, text }); a plain `tsc` call runs incrementally with the
// project's tsc and the shared/private tsbuildinfo paths.
function scriptPlan(dir, folders, script) {
  const info = buildInfoFor(dir);
  const tsc = projectBin(folders, 'tsc');
  const major = tsc ? typescriptMajor(tsc) : null;
  const incremental = tsc && major !== null ? incrementalTypecheck(script.text, major, tsc, info.privateInfo) : null;
  if (!incremental) return { cwd: dir, check: { name: 'typecheck', args: ['run', script.name] } };
  return { cwd: dir, check: { name: 'typecheck', ...incremental }, ...info };
}

// Step 2: one tsc run per nearest tsconfig.json of the files; files with none are skipped with `noneReason`.
function tsconfigPlans(dir, folders, files, noneReason) {
  const byTsconfig = new Map();
  for (const file of files) {
    const tsconfig = nearestTsconfig(file, dir);
    byTsconfig.set(tsconfig, [...(byTsconfig.get(tsconfig) ?? []), file]);
  }
  const tsc = projectBin(folders, 'tsc');
  return [...byTsconfig].map(([tsconfig, group]) => {
    if (!tsconfig) return skip(group, noneReason);
    const info = buildInfoFor(tsconfig);
    return planFor(group, dir, tsconfigTypecheck(tsconfig, tsc, info.privateInfo), info);
  });
}

// What runs for one package, in the order of the header: [{ files, cwd, check, shared?, privateInfo? } | { files, skipped }].
function packagePlans(dir, files) {
  const folders = projectFolders(dir, GIT_TOP_TIMEOUT_MS);
  const script = typecheckScript(readJsonFile(join(dir, 'package.json'))?.scripts);
  if (script && !isBroadScript(script.text)) return [{ files, ...scriptPlan(dir, folders, script) }];
  return tsconfigPlans(dir, folders, files, script ? SKIPPED.broadScript : SKIPPED.noTsconfig);
}

// Seed the private build info from the shared one; any failure only costs the speed-up.
function seed({ shared, privateInfo }) {
  try {
    mkdirSync(dirname(shared), { recursive: true });
    if (existsSync(shared)) copyFileSync(shared, privateInfo);
  } catch {
    // cold run
  }
}

// Publish the private build info atomically, then make sure no private copy is left behind.
function publish({ shared, privateInfo }) {
  try {
    if (existsSync(privateInfo)) renameSync(privateInfo, shared);
  } catch {
    rmSync(privateInfo, { force: true }); // a lost rename only costs the speed-up
  }
}

const NOTHING = { timedOut: false, lines: [], unparsed: [], unchecked: [] };

// Real diagnostics about the logged files win; the raw output tail counts only when no file got a parsed line.
function judgeOutput(output, rels) {
  const details = rels.map((rel) => diagnosticsDetailed(output, rel));
  const lines = unique(details.filter((d) => d.parsed).flatMap((d) => d.lines));
  return { ...NOTHING, lines, unparsed: lines.length ? [] : unique(details.flatMap((d) => d.lines)) };
}

// The command as the run log names it: the tool by name (not its path), then its arguments.
const commandText = (pm, check) => [basename(check.cmd ?? pm).replace(/\.cmd$/i, ''), ...check.args].join(' ');

function exitOf(run) {
  if (run.timedOut) return 'timeout';
  return run.error ? 'error' : run.status;
}

/** Result of one plan for its logged files (see {@link runGate}) plus `entry`, its run-log fields. */
async function runPlan(dir, plan, deadline) {
  if (plan.skipped) return { ...NOTHING, timedOut: plan.skipped === SKIPPED.budgetSpent, entry: { outcome: `skipped: ${plan.skipped}`, exit: null, ms: 0 } };
  const left = deadline - Date.now();
  if (left <= 0) return runPlan(dir, skip(plan.files, SKIPPED.budgetSpent), deadline);
  const pm = packageManager(dir);
  if (plan.shared) seed(plan);
  const r = await runCheck(pm, plan.check, plan.cwd, left);
  if (plan.shared) r.timedOut ? rmSync(plan.privateInfo, { force: true }) : publish(plan);
  const entry = { outcome: `ran: ${commandText(pm, plan.check)}`, exit: exitOf(r), ms: left - (deadline - Date.now()) };
  if (r.timedOut) return { ...NOTHING, timedOut: true, entry };
  const rels = plan.files.map((f) => relative(dir, f).replace(/\\/g, '/'));
  if (r.error) return { ...NOTHING, unparsed: [`${rels[0]}:1 HOOK could not run ${plan.check.name}: ${r.error.message}`], entry };
  return { ...(r.status === 0 ? NOTHING : judgeOutput(`${r.stdout}\n${r.stderr}`, rels)), entry };
}

// Existing logged files grouped by their package dir: [{ dir, files }]. A file with no package.json above it is out of scope.
function groupByPackage(files) {
  const groups = new Map();
  for (const file of files.filter((f) => existsSync(f))) {
    const dir = findPackageDir(file);
    if (dir) groups.set(dir, [...(groups.get(dir) ?? []), file]);
  }
  return [...groups].map(([dir, group]) => ({ dir, files: group }));
}

const cut = (lines) => lines.slice(0, MAX_LINES);

/**
 * Typechecks every package that has logged files, one after another within the shared budget. Once the budget is gone
 * nothing more is planned or started: what is left is recorded as `skipped: budget spent` and returned as unchecked.
 * @param {string[]} files absolute paths of edited files
 * @param {number} deadline epoch ms
 * @param {(entry: {dir: string, outcome: string, exit: number | string | null, ms: number}) => void} [record] called once
 *   per check that ran or was skipped (the run log); nothing is recorded by default
 * @returns {Promise<{timedOut: boolean, lines: string[], unparsed: string[], unchecked: string[]}>} `lines`: real
 *   diagnostics about the logged files (at most 15); `unparsed`: output tail or run error when no diagnostic parsed
 *   (typecheck could not run); `unchecked`: files not checked because the budget ran out
 */
export async function runGate(files, deadline, record = () => {}) {
  const found = { lines: [], unparsed: [], unchecked: [] };
  for (const { dir, files: group } of groupByPackage(files)) {
    const plans = deadline > Date.now() ? packagePlans(dir, group) : [skip(group, SKIPPED.budgetSpent)];
    for (const plan of plans) {
      const { entry, ...result } = await runPlan(dir, plan, deadline);
      record({ dir, ...entry });
      if (result.timedOut) found.unchecked.push(...plan.files);
      found.lines.push(...result.lines);
      found.unparsed.push(...result.unparsed);
    }
  }
  if (found.unchecked.length) return { ...NOTHING, timedOut: true, unchecked: found.unchecked };
  return { ...NOTHING, lines: cut(found.lines), unparsed: cut(found.unparsed) };
}

/**
 * User message for a timed-out gate: names the files that were not checked (at most 10) and asks for a runner typecheck.
 * @param {string[]} unchecked absolute paths
 */
export function timeoutMessage(unchecked) {
  const more = unchecked.length > MAX_NAMED_FILES ? `, +${unchecked.length - MAX_NAMED_FILES} more` : '';
  const named = unchecked.slice(0, MAX_NAMED_FILES).join(', ');
  return `typecheck gate: timed out, not run for: ${named}${more}. Run a typecheck through the runner agent.`;
}

const lastPath = (logPath) => `${logPath}.last`; // hash + lines of the failure that last blocked a stop
const shownPath = (logPath) => `${logPath}.shown`; // hash of a failure the user was already shown

function readHash(path) {
  try {
    return readFileSync(path, 'utf8').split('\n', 1)[0];
  } catch {
    return null; // nothing recorded
  }
}

const say = (systemMessage) => process.stdout.write(`${JSON.stringify({ systemMessage })}\n`);

// Blocks the stop with `lines` (exit 2) unless the user has seen this exact failure or the agent retried without progress.
function blockOrReport(lines, logPath, stopHookActive) {
  const text = lines.join('\n');
  const hash = sha256(text);
  const alreadyShown = hash === readHash(shownPath(logPath));
  const noProgress = stopHookActive && hash === readHash(lastPath(logPath));
  if (alreadyShown || noProgress) {
    if (!alreadyShown) writeFileSync(shownPath(logPath), `${hash}\n`);
    return say(`typecheck gate: unresolved errors\n${text}`);
  }
  writeFileSync(lastPath(logPath), `${hash}\n${text}\n`);
  process.stderr.write(`${text}\n`);
  process.exitCode = 2;
}

/**
 * Applies a gate result. Pass, timeout and "typecheck could not run" clear the log (a message goes to the user for the
 * last two); real diagnostics block the stop (exit 2) unless this exact failure was already shown or the agent retried
 * with no progress, in which case the user gets the lines as a message and the hash is remembered as shown.
 * @param {{timedOut: boolean, lines: string[], unparsed: string[], unchecked: string[]}} result from {@link runGate}
 * @param {string} logPath edit log of this agent
 * @param {boolean} stopHookActive input `stop_hook_active`
 */
export function decideExit(result, logPath, stopHookActive) {
  if (result.lines.length && !result.timedOut) return blockOrReport(result.lines, logPath, stopHookActive);
  if (result.timedOut) say(timeoutMessage(result.unchecked));
  else if (result.unparsed.length) say(`typecheck gate: no diagnostics for the edited files, typecheck may not run\n${result.unparsed.join('\n')}`);
  for (const file of [logPath, lastPath(logPath), shownPath(logPath)]) rmSync(file, { force: true });
}

/** @returns {string} where the run log is: CLAUDE_TYPECHECK_LOG or ~/.claude/logs/typecheck-gate.jsonl */
export const runLogPath = (env = process.env) => env.CLAUDE_TYPECHECK_LOG || RUN_LOG_FILE;

// The `record` of runGate for this session and agent (both already checked as safe ids by editLogPath): appends one line.
function runLogWriter(session, agent) {
  return (entry) => {
    try {
      const path = runLogPath();
      mkdirSync(dirname(path), { recursive: true, mode: RUN_LOG_DIR_MODE });
      appendPlainFile(path, `${JSON.stringify({ ts: new Date().toISOString(), session, agent, ...entry })}\n`, { maxBytes: MAX_RUN_LOG_BYTES });
    } catch {
      // the log is best effort: a link, a FIFO or an unwritable folder at its path must never change the gate's decision
    }
  };
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return; // not hook JSON: nothing to check
  }
  if (typecheckAtEdit()) return;
  const logPath = editLogPath(input?.session_id, input?.agent_id);
  const files = logPath ? readEdits(logPath) : [];
  if (!files.length) return;
  const record = runLogWriter(input.session_id, input.agent_id ?? MAIN_AGENT);
  if (!skipFilter(process.env[SKIP_ENV])('typecheck')) {
    for (const { dir } of groupByPackage(files)) record({ dir, outcome: `skipped: ${SKIPPED.skipEnv}`, exit: null, ms: 0 });
    return; // opted out: the edit log stays as it is
  }
  decideExit(await runGate(files, Date.now() + BUDGET_MS, record), logPath, input.stop_hook_active === true);
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
