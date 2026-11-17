// Stop / SubagentStop: typecheck the files this agent edited, once, instead of after every edit (post-edit.mjs logs them).
// Exports: incrementalTypecheck(script, tsMajor, tscPath, buildInfo, platform), typescriptMajor(tscPath),
// runGate(files, deadline), timeoutMessage(unchecked), decideExit(result, logPath, stopHookActive).
// Invariants: silent and exit 0 when nothing was logged, when CLAUDE_TYPECHECK_AT=edit or typecheck is skipped; only
// real diagnostics about logged files exit 2 (the agent keeps running and fixes them); a timeout, a typecheck that
// cannot run (no diagnostic parses) and a failure the user was already shown are systemMessages, never blocks.
// The shared tsbuildinfo makes later runs incremental; each run writes a private copy and renames it over the shared one.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAX_LINES, diagnosticsDetailed } from './lib/diagnostics.mjs';
import { editLogPath, readEdits, tempRoot } from './lib/edit-log.mjs';
import { SKIP_ENV, findPackageDir, isBroadScript, packageManager, runCheck, skipFilter, toolFinder, typecheckAtEdit, typecheckScript } from './post-edit.mjs';

const BUDGET_MS = 140_000; // hook timeout is 150 s
const MAX_NAMED_FILES = 10;
const SUPPORTED_TS_MAJORS = [4, 5, 6];
const UNSAFE_SHELL = /[&|;<>$`'"]/;
const WIN_UNSAFE_SCRIPT = /[%^!]/; // cmd.exe expands these even inside a script's flags
const WIN_SAFE_PATH = /^[\w@+=:,./\\-]+$/; // args are not quoted under the Windows shell: no spaces or metacharacters
const NON_INCREMENTAL_FLAGS = ['-b', '--build', '-w', '--watch', '--incremental', '--tsBuildInfoFile'];

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const unique = (items) => [...new Set(items)];

/**
 * The `tsc` call that typechecks incrementally, or null when the script is not a plain `tsc` call this can extend.
 * On Windows the shell is on and does not quote args, so unsafe paths or script characters also give null.
 * @param {string} script the package's `typecheck` script
 * @param {number} tsMajor major version of the installed typescript
 * @param {string} tscPath path of the `tsc` binary
 * @param {string} buildInfo private tsbuildinfo file for this run
 * @param {string} [platform] defaults to the running platform
 * @returns {{cmd: string, args: string[]} | null}
 */
export function incrementalTypecheck(script, tsMajor, tscPath, buildInfo, platform = process.platform) {
  const [tool, ...flags] = script.trim().split(/\s+/);
  if (tool !== 'tsc' || UNSAFE_SHELL.test(script) || !SUPPORTED_TS_MAJORS.includes(tsMajor)) return null;
  if (platform === 'win32' && (WIN_UNSAFE_SCRIPT.test(script) || ![tscPath, buildInfo].every((p) => WIN_SAFE_PATH.test(p)))) return null;
  const conflicts = flags.some((f) => NON_INCREMENTAL_FLAGS.some((bad) => f === bad || f.startsWith(`${bad}=`)));
  return conflicts ? null : { cmd: tscPath, args: [...flags, '--incremental', '--tsBuildInfoFile', buildInfo] };
}

// Major of the typescript package at `manifest` (null when unreadable, another package, or without a version).
function majorAt(manifest) {
  try {
    const { name, version } = JSON.parse(readFileSync(manifest, 'utf8'));
    const major = Number.parseInt(version, 10);
    return name === 'typescript' && !Number.isNaN(major) ? major : null;
  } catch {
    return null; // no such manifest here
  }
}

/**
 * Major version of the typescript that the given `tsc` binary belongs to: the package next to its `.bin` folder, else
 * the package that contains the binary's real path. Not the nearest typescript from the project: a hoisted `tsc`
 * must be judged by its own version.
 * @param {string} tscPath path of a `tsc` binary
 * @returns {number | null}
 */
export function typescriptMajor(tscPath) {
  const sibling = majorAt(join(dirname(tscPath), '..', 'typescript', 'package.json'));
  if (sibling !== null) return sibling;
  let real;
  try {
    real = realpathSync(tscPath);
  } catch {
    return null; // tsc vanished
  }
  for (let d = dirname(real); ; d = dirname(d)) {
    const major = majorAt(join(d, 'package.json'));
    if (major !== null) return major;
    if (dirname(d) === d) return null;
  }
}

// The typecheck command of one package (`script`: its { name, text } from typecheckScript) plus the shared/private tsbuildinfo
// paths when it runs incrementally.
function typecheckPlan(dir, script) {
  const shared = join(tempRoot(), 'tsbuildinfo', sha256(dir));
  const privateInfo = `${shared}.${process.pid}`;
  const tsc = toolFinder(dir)('tsc');
  const major = tsc ? typescriptMajor(tsc) : null;
  const incremental = tsc && major !== null ? incrementalTypecheck(script.text, major, tsc, privateInfo) : null;
  if (!incremental) return { check: { name: 'typecheck', args: ['run', script.name] } };
  return { check: { name: 'typecheck', ...incremental }, shared, privateInfo };
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

/** Result of one package for all its logged files: see {@link runGate}. */
async function checkPackage(dir, files, script, deadline) {
  const left = deadline - Date.now();
  if (left <= 0) return { ...NOTHING, timedOut: true };
  const plan = typecheckPlan(dir, script);
  if (plan.shared) seed(plan);
  const r = await runCheck(packageManager(dir), plan.check, dir, left);
  if (plan.shared) r.timedOut ? rmSync(plan.privateInfo, { force: true }) : publish(plan);
  if (r.timedOut) return { ...NOTHING, timedOut: true };
  const rels = files.map((f) => relative(dir, f).replace(/\\/g, '/'));
  if (r.error) return { ...NOTHING, unparsed: [`${rels[0]}:1 HOOK could not run ${plan.check.name}: ${r.error.message}`] };
  return r.status === 0 ? NOTHING : judgeOutput(`${r.stdout}\n${r.stderr}`, rels);
}

// The package's typecheck script (the first of `typecheck`, `type-check`), or null when it has none the gate can run.
function packageTypecheck(dir) {
  try {
    const script = typecheckScript(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts);
    return script && !isBroadScript(script.text) ? script : null;
  } catch {
    return null; // unreadable package.json: post-edit already reported it
  }
}

// Existing logged files grouped by their package dir, skipping packages without a gate-able typecheck script.
function groupByPackage(files) {
  const groups = new Map();
  for (const file of files.filter((f) => existsSync(f))) {
    const dir = findPackageDir(file);
    if (dir) groups.set(dir, [...(groups.get(dir) ?? []), file]);
  }
  return [...groups].flatMap(([dir, group]) => {
    const script = packageTypecheck(dir);
    return script ? [{ dir, files: group, script }] : [];
  });
}

/**
 * Typechecks every package that has logged files, one after another within the shared budget.
 * @param {string[]} files absolute paths of edited files
 * @param {number} deadline epoch ms
 * @returns {Promise<{timedOut: boolean, lines: string[], unparsed: string[], unchecked: string[]}>} `lines`: real
 *   diagnostics about the logged files (at most 15); `unparsed`: output tail or run error when no diagnostic parsed
 *   (typecheck could not run); `unchecked`: files not checked because the budget ran out
 */
export async function runGate(files, deadline) {
  const groups = groupByPackage(files);
  const lines = [];
  const unparsed = [];
  for (const [i, { dir, files: group, script }] of groups.entries()) {
    const result = await checkPackage(dir, group, script, deadline);
    if (result.timedOut) return { ...NOTHING, timedOut: true, unchecked: groups.slice(i).flatMap((g) => g.files) };
    lines.push(...result.lines);
    unparsed.push(...result.unparsed);
  }
  return { ...NOTHING, lines: lines.slice(0, MAX_LINES), unparsed: unparsed.slice(0, MAX_LINES) };
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
  if (typecheckAtEdit() || !skipFilter(process.env[SKIP_ENV])('typecheck')) return;
  const logPath = editLogPath(input?.session_id, input?.agent_id);
  const files = logPath ? readEdits(logPath) : [];
  if (!files.length) return;
  decideExit(await runGate(files, Date.now() + BUDGET_MS), logPath, input.stop_hook_active === true);
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
