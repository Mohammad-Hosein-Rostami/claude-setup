// Runs the project's own format script on a code file after it is edited, within the trust rules.
// PostToolUse(Edit|Write|MultiEdit): run the project's own `format` script on a code file after it changes (C21). Only a
// script that exists in the nearest package.json runs.
// Trust (audit H8, lib/format-trust.mjs): a cloned repo's `format` script runs through the package manager only in a project the owner
// trusts (CLAUDE_POST_EDIT_TRUST_FORMAT=1); elsewhere only one plain call of a known formatter runs, as that tool's binary, and any
// other script is not run and warned about once per session.
// A format script that targets the whole repo (`prettier --write .`, `nx run-many`) is replaced by the tool's binary on the
// edited file, or skipped; CLAUDE_POST_EDIT_SKIP opts out ("all" or "format"), but not when only a project's committed
// .claude/settings.json sets it (lib/team-switch.mjs): then the format runs and the owner gets one warning per session (a
// `systemMessage`, or a line after the failures). A format run that outlives the deadline is
// killed with its whole process tree. Silent on success; on failure prints at most 15 `file:line RULE-ID message` lines and
// exits 2. Never evaluates hook input; on Windows (shell on) the relative path must look safe.
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPlainFile } from './lib/plain-file.mjs';
import { CODE_FILE, diagnostics } from './lib/diagnostics.mjs';
import { formatterCall, refusedText, TRUST_ENV, trustedFormat } from './lib/format-trust.mjs';
import { noticeOnce, switchDirs, trustedSwitch } from './lib/team-switch.mjs';

const SAFE_PATH = /^[\w@+=:,./-]+$/; // no `%`: cmd.exe expands %VAR%
const BUDGET_MS = 18_000; // hook timeout is 20 s
const PACKAGE_JSON_MAX_BYTES = 4 * 1024 * 1024; // far above any real package.json; a bigger one is reported unreadable
const FORMAT_SCRIPT = 'format'; // takes the edited file after `--`
const FORMAT_TOOL = ['prettier', '--write']; // per-file fallback for a broad format script
const BROAD_SCRIPT = /(^|\s)\.\/?(\s|$)|\*|\brun-many\b|\bnx\b|\bturbo\b|\blerna\b/;
/** Env var that opts the format run out: "all" or "format". */
export const SKIP_ENV = 'CLAUDE_POST_EDIT_SKIP'; // the shell or a project's .claude/settings.local.json env; a team file's value is ignored

export { diagnostics, isSamePath } from './lib/diagnostics.mjs';
export { formatterCall, TRUST_ENV, trustedFormat } from './lib/format-trust.mjs';

export const isCodeFile = (file) => CODE_FILE.test(file);

/** Nearest directory at or above `file` that holds a package.json, or null. */
export function findPackageDir(file) {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/** `pnpm`, `yarn` or `npm`, from the nearest lockfile at or above `dir`. */
export function packageManager(dir) {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, 'pnpm-lock.yaml'))) return 'pnpm';
    if (existsSync(join(d, 'yarn.lock'))) return 'yarn';
    if (dirname(d) === d) return 'npm';
  }
}

/** True when a script already targets the whole repo (`prettier --write .`, `nx run-many`, ...). */
export const isBroadScript = (script) => BROAD_SCRIPT.test(script);

/** `skip` env value ("all" or "format") -> predicate on check names. Pure. */
export const skipFilter = (skip = '') => {
  const names = new Set(skip.split(',').map((s) => s.trim()).filter(Boolean));
  return (name) => !names.has('all') && !names.has(name);
};

const formatScriptOf = (scripts) => (typeof scripts?.[FORMAT_SCRIPT] === 'string' ? scripts[FORMAT_SCRIPT] : null);

/** True when the project's `format` script would run only with trust: it exists, is not broad and is no known formatter call. Pure. */
export function needsTrust(scripts) {
  const script = formatScriptOf(scripts);
  return script !== null && !isBroadScript(script) && formatterCall(script) === null;
}

/**
 * `file` as a command-line argument: a name that starts with `-` (a repo file `--plugin=x.ts` at the package root) would reach the
 * tool as an option, and npm passes the words after its own `--` on to the script, so `./` keeps it a path for every tool. Pure.
 * @param {string} file the edited file, relative to the package folder
 * @returns {string} the file, prefixed with `./` when it starts with `-`
 */
const fileArgument = (file) => (file.startsWith('-') ? `./${file}` : file);

/**
 * Checks to run for `file`: [{ name, cmd?, args }]; without `cmd` the package manager runs `args`. Pure.
 * A format script that is broad would format the whole repo, so the tool's own binary (found by `findTool`) runs on
 * the file instead; when that binary is missing the check is skipped. Any other script goes through the package manager only when
 * `trusted`; untrusted, a known formatter call runs as the tool's binary (found, else its bare name on PATH) and anything else
 * is not planned (needsTrust tells the caller to warn).
 */
export function plannedChecks(scripts, file, findTool = () => null, trusted = false) {
  const script = formatScriptOf(scripts);
  if (script === null) return [];
  const target = fileArgument(file);
  if (isBroadScript(script)) {
    const [tool, ...flags] = FORMAT_TOOL;
    const cmd = findTool(tool);
    return cmd ? [{ name: FORMAT_SCRIPT, cmd, args: [...flags, target] }] : [];
  }
  if (trusted) return [{ name: FORMAT_SCRIPT, args: ['run', FORMAT_SCRIPT, '--', target] }];
  const call = formatterCall(script);
  if (call === null) return [];
  const [tool, ...args] = call;
  return [{ name: FORMAT_SCRIPT, cmd: findTool(tool) ?? tool, args: [...args, target] }];
}

/** Finder for the nearest node_modules/.bin/<tool> walking up from `dir` (a monorepo hoists binaries to the root); returns null when absent. */
export function toolFinder(dir) {
  const exe = process.platform === 'win32' ? '.cmd' : '';
  return (tool) => {
    for (let d = dir; ; d = dirname(d)) {
      const bin = join(d, 'node_modules', '.bin', tool + exe);
      if (existsSync(bin)) return bin;
      if (dirname(d) === d) return null;
    }
  };
}

// cmd.exe treats these specially even inside a path; one of them anywhere in the command needs quoting.
const CMD_METACHARS = /[\s&|<>^()%!,;=]/;

/** Command string for a shell spawn: quoted on Windows when it has cmd metacharacters. Pure. */
export function shellCommand(cmd, platform = process.platform) {
  return platform === 'win32' && CMD_METACHARS.test(cmd) ? `"${cmd}"` : cmd;
}

/**
 * Kills `child` and everything it spawned. POSIX: the child leads its own process group (`detached`), so the negative
 * pid reaches grandchildren; Windows: `taskkill /T` walks the tree. Never throws (the process may already be gone).
 */
function killTree(child) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill();
    } catch {
      // already exited: nothing left to kill
    }
  }
}

/**
 * Spawns one check and resolves (never rejects) to { status, stdout, stderr, error, timedOut }. On the deadline it
 * resolves from the timer itself: a grandchild holding the pipes open must not delay `close`.
 * @param {string} pm package manager, used when `check.cmd` is absent
 * @param {{cmd?: string, args: string[], env?: Record<string, string>}} check what to run; `env` is added to this process's environment
 * @param {string} cwd working directory
 * @param {number} timeoutMs kill the process tree after this long
 * @returns {Promise<object> & {kill: () => void}} the promise also carries `kill()` (tree kill, pipes released); it
 *   does nothing once the child has closed, so a recycled pid is never signalled
 */
export function runCheck(pm, check, cwd, timeoutMs) {
  // Windows package managers are .cmd shims and need a shell; SAFE_PATH keeps `file` free of metacharacters.
  const cmd = shellCommand(check.cmd ?? pm);
  let kill = () => {};
  const run = new Promise((resolve) => {
    const env = { ...process.env, ...check.env };
    const child = spawn(cmd, check.args, { cwd, env, shell: process.platform === 'win32', detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let closed = false;
    const release = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      killTree(child);
      child.stdout.destroy();
      child.stderr.destroy();
    };
    kill = release;
    const timer = setTimeout(() => {
      release();
      resolve({ status: null, stdout, stderr, error: null, timedOut: true });
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (error) => {
      closed = true;
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr, error, timedOut: false });
    });
    child.on('close', (status) => {
      closed = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr, error: null, timedOut: false });
    });
  });
  return Object.assign(run, { kill: () => kill() });
}

const outputOf = (r) => `${r.stdout}\n${r.stderr}`;

/** What a check runs, for its failure line: the tool's own binary when it has one (npm never ran then), else `<pm> <check>`. */
const runnerName = (pm, check) => (check.cmd === undefined ? `${pm} ${check.name}` : `${check.cmd} (${check.name})`);

/**
 * Runs the checks in order until the deadline (epoch ms); the first failing check decides. A timeout or an exhausted
 * budget returns [] (never a false failure). Returns the failure lines ([] = all passed).
 */
export async function runStages(checks, ctx) {
  for (const check of checks) {
    const left = ctx.deadline - Date.now();
    if (left <= 0) return []; // out of time: do not block the edit on a slow project
    const result = await runCheck(ctx.pm, check, ctx.cwd, left);
    if (result.timedOut) return [];
    if (result.error) return [`${ctx.rel}:1 HOOK could not run ${runnerName(ctx.pm, check)}: ${result.error.message}`];
    if (result.status !== 0) return diagnostics(outputOf(result), ctx.rel);
  }
  return [];
}

/** The CLAUDE_POST_EDIT_SKIP value the hook may act on, and the warning when a team file's value was ignored (lib/team-switch.mjs). */
export const trustedSkip = (env = process.env, cwd = undefined) => trustedSwitch(env, SKIP_ENV, switchDirs(env, cwd));

/**
 * Runs the format check for `file`.
 * @param {string} file the edited file (absolute)
 * @param {{ skip?: string, env?: Record<string, string|undefined>, cwd?: string }} [options] skip: the trusted CLAUDE_POST_EDIT_SKIP
 *   value (trustedSkip); env and cwd decide the trust (trustedFormat); this process's env by default
 * @returns {Promise<{ failures: string[], refused: { dir: string, ignored: string|null } | null }>} failures: the failure lines ([] = all
 *   passed or nothing to run); refused: the package folder whose format script was not run for want of trust
 */
export async function formatFile(file, { skip = trustedSkip().value, env = process.env, cwd = undefined } = {}) {
  const none = { failures: [], refused: null };
  if (!isCodeFile(file) || !existsSync(file)) return none;
  const dir = findPackageDir(file);
  if (!dir) return none;
  const rel = relative(dir, file).replace(/\\/g, '/');
  if (process.platform === 'win32' && !SAFE_PATH.test(rel)) return none; // shell is on: refuse metacharacters
  let scripts;
  try {
    // a linked package.json is followed once by realpath; the read never waits (lib/plain-file.mjs): a FIFO or device is reported
    // unreadable instead of holding the hook
    scripts = JSON.parse(readPlainFile(realpathSync(join(dir, 'package.json')), PACKAGE_JSON_MAX_BYTES)).scripts;
  } catch (error) {
    return { failures: [`${rel}:1 HOOK unreadable package.json in ${dir}: ${error.message}`], refused: null };
  }
  if (!skipFilter(skip)(FORMAT_SCRIPT)) return none;
  const trust = trustedFormat(env, cwd, dir);
  const refused = !trust.trusted && needsTrust(scripts) ? { dir, ignored: trust.ignored } : null;
  const checks = plannedChecks(scripts, rel, toolFinder(dir), trust.trusted);
  const failures = await runStages(checks, { pm: packageManager(dir), cwd: dir, rel, deadline: Date.now() + BUDGET_MS });
  return { failures, refused };
}

/** The failure lines of formatFile alone ([] = all passed or nothing to run), with this process's env. */
export const checkFile = async (file, skip = trustedSkip().value) => (await formatFile(file, { skip })).failures;

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
  const file = input?.tool_input?.file_path;
  if (typeof file !== 'string') return;
  const skip = trustedSkip(process.env, input.cwd);
  const { failures, refused } = await formatFile(file, { skip: skip.value, cwd: input.cwd });
  // Warn only where the switch would have changed something (a code file), each warning once per session.
  const warnings = [
    skip.ignored !== null && isCodeFile(file) && noticeOnce(input.session_id, SKIP_ENV) ? skip.ignored : null,
    refused !== null && noticeOnce(input.session_id, TRUST_ENV) ? refusedText(refused) : null,
  ].filter((warning) => warning !== null);
  if (failures.length) {
    process.stderr.write([...failures, ...warnings].join('\n') + '\n');
    process.exitCode = 2;
  } else if (warnings.length) {
    process.stdout.write(`${JSON.stringify({ systemMessage: warnings.join('\n') })}\n`);
  }
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
