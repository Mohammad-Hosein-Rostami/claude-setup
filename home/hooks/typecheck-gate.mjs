// Stop / SubagentStop: typecheck the files this agent edited, once, instead of after every edit (post-edit.mjs logs them).
// Exports: incrementalTypecheck(script, tsMajor, tscPath, buildInfo), runGate(files, deadline), decideExit(result, logPath, stopHookActive).
// Invariants: silent and exit 0 when nothing was logged, when CLAUDE_TYPECHECK_AT=edit or typecheck is skipped; a
// timeout is never a failure (systemMessage only); a failure exits 2 so the agent keeps running and fixes it, except
// when the agent already retried and the failure is unchanged (then the user is told and the agent may stop).
// The shared tsbuildinfo makes later runs incremental; each run writes a private copy and renames it over the shared one.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAX_LINES, diagnostics } from './lib/diagnostics.mjs';
import { editLogPath, readEdits, tempRoot } from './lib/edit-log.mjs';
import { SKIP_ENV, findPackageDir, isBroadScript, packageManager, runCheck, skipFilter, toolFinder, typecheckAtEdit } from './post-edit.mjs';

const BUDGET_MS = 140_000; // hook timeout is 150 s
const SUPPORTED_TS_MAJORS = [4, 5, 6];
const UNSAFE_SHELL = /[&|;<>$`]/;
const NON_INCREMENTAL_FLAGS = ['-b', '--build', '-w', '--watch', '--incremental', '--tsBuildInfoFile'];
const TIMED_OUT_MESSAGE = 'typecheck gate: timed out, not run';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * The `tsc` call that typechecks incrementally, or null when the script is not a plain `tsc` call this can extend.
 * @param {string} script the package's `typecheck` script
 * @param {number} tsMajor major version of the installed typescript
 * @param {string} tscPath path of the `tsc` binary
 * @param {string} buildInfo private tsbuildinfo file for this run
 * @returns {{cmd: string, args: string[]} | null}
 */
export function incrementalTypecheck(script, tsMajor, tscPath, buildInfo) {
  const [tool, ...flags] = script.trim().split(/\s+/);
  if (tool !== 'tsc' || UNSAFE_SHELL.test(script) || !SUPPORTED_TS_MAJORS.includes(tsMajor)) return null;
  const conflicts = flags.some((f) => NON_INCREMENTAL_FLAGS.some((bad) => f === bad || f.startsWith(`${bad}=`)));
  return conflicts ? null : { cmd: tscPath, args: [...flags, '--incremental', '--tsBuildInfoFile', buildInfo] };
}

// Major version of the nearest installed typescript (a monorepo hoists it), or null.
function typescriptMajor(dir) {
  for (let d = dir; ; d = dirname(d)) {
    const manifest = join(d, 'node_modules', 'typescript', 'package.json');
    if (existsSync(manifest)) {
      try {
        return Number.parseInt(JSON.parse(readFileSync(manifest, 'utf8')).version, 10);
      } catch {
        return null; // unreadable manifest: fall back to the project's own script
      }
    }
    if (dirname(d) === d) return null;
  }
}

// The typecheck command of one package plus the shared/private tsbuildinfo paths when it runs incrementally.
function typecheckPlan(dir, script) {
  const shared = join(tempRoot(), 'tsbuildinfo', sha256(dir));
  const privateInfo = `${shared}.${process.pid}`;
  const tsc = toolFinder(dir)('tsc');
  const major = tsc ? typescriptMajor(dir) : null;
  const incremental = tsc && major !== null ? incrementalTypecheck(script, major, tsc, privateInfo) : null;
  if (!incremental) return { check: { name: 'typecheck', args: ['run', 'typecheck'] } };
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

/** Failure lines of one package for all its logged files, `timedOut` when the budget ran out. */
async function checkPackage(dir, files, scripts, deadline) {
  const left = deadline - Date.now();
  if (left <= 0) return { timedOut: true, lines: [] };
  const plan = typecheckPlan(dir, scripts.typecheck);
  if (plan.shared) seed(plan);
  const r = await runCheck(packageManager(dir), plan.check, dir, left);
  if (plan.shared) r.timedOut ? rmSync(plan.privateInfo, { force: true }) : publish(plan);
  if (r.timedOut) return { timedOut: true, lines: [] };
  const rels = files.map((f) => relative(dir, f).replace(/\\/g, '/'));
  if (r.error) return { timedOut: false, lines: [`${rels[0]}:1 HOOK could not run ${plan.check.name}: ${r.error.message}`] };
  if (r.status === 0) return { timedOut: false, lines: [] };
  const merged = rels.flatMap((rel) => diagnostics(`${r.stdout}\n${r.stderr}`, rel));
  return { timedOut: false, lines: [...new Set(merged)] };
}

function packageScripts(dir) {
  try {
    const scripts = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts;
    return typeof scripts?.typecheck === 'string' && !isBroadScript(scripts.typecheck) ? scripts : null;
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
    const scripts = packageScripts(dir);
    return scripts ? [{ dir, files: group, scripts }] : [];
  });
}

/**
 * Typechecks every package that has logged files, one after another within the shared budget.
 * @param {string[]} files absolute paths of edited files
 * @param {number} deadline epoch ms
 * @returns {Promise<{timedOut: boolean, lines: string[]}>} merged failure lines (at most 15) about the logged files
 */
export async function runGate(files, deadline) {
  const lines = [];
  for (const { dir, files: group, scripts } of groupByPackage(files)) {
    const result = await checkPackage(dir, group, scripts, deadline);
    if (result.timedOut) return { timedOut: true, lines: [] };
    lines.push(...result.lines);
  }
  return { timedOut: false, lines: lines.slice(0, MAX_LINES) };
}

const lastPath = (logPath) => `${logPath}.last`;

// Hash on the first line of `<log>.last`, the failure lines below it.
function previousHash(logPath) {
  try {
    return readFileSync(lastPath(logPath), 'utf8').split('\n', 1)[0];
  } catch {
    return null; // no earlier failure recorded
  }
}

const say = (systemMessage) => process.stdout.write(`${JSON.stringify({ systemMessage })}\n`);

/**
 * Applies a gate result: pass or timeout clears the log, a failure blocks the stop (exit 2) unless the agent already
 * retried with no progress, in which case the user gets the remaining lines as a message.
 * @param {{timedOut: boolean, lines: string[]}} result
 * @param {string} logPath edit log of this agent
 * @param {boolean} stopHookActive input `stop_hook_active`
 */
export function decideExit(result, logPath, stopHookActive) {
  const clear = () => [logPath, lastPath(logPath)].forEach((f) => rmSync(f, { force: true }));
  if (result.timedOut) {
    say(TIMED_OUT_MESSAGE);
    return clear();
  }
  if (!result.lines.length) return clear();
  const hash = sha256(result.lines.join('\n'));
  if (stopHookActive && hash === previousHash(logPath)) {
    return say(`typecheck gate: unresolved errors\n${result.lines.join('\n')}`);
  }
  writeFileSync(lastPath(logPath), `${hash}\n${result.lines.join('\n')}\n`);
  process.stderr.write(`${result.lines.join('\n')}\n`);
  process.exitCode = 2;
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
