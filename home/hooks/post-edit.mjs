// PostToolUse(Edit|Write|MultiEdit): run the project's own `format` script on a code file after it changes (C21). Only a
// script that exists in the nearest package.json runs.
// A format script that targets the whole repo (`prettier --write .`, `nx run-many`) is replaced by the tool's binary on the
// edited file, or skipped; CLAUDE_POST_EDIT_SKIP opts out ("all" or "format"). A format run that outlives the deadline is
// killed with its whole process tree. Silent on success; on failure prints at most 15 `file:line RULE-ID message` lines and
// exits 2. Never evaluates hook input; on Windows (shell on) the relative path must look safe.
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPlainFile } from './lib/plain-file.mjs';
import { CODE_FILE, diagnostics } from './lib/diagnostics.mjs';

const SAFE_PATH = /^[\w@+=:,./-]+$/; // no `%`: cmd.exe expands %VAR%
const BUDGET_MS = 18_000; // hook timeout is 20 s
const PACKAGE_JSON_MAX_BYTES = 4 * 1024 * 1024; // far above any real package.json; a bigger one is reported unreadable
const FORMAT_SCRIPT = 'format'; // takes the edited file after `--`
const FORMAT_TOOL = ['prettier', '--write']; // per-file fallback for a broad format script
const BROAD_SCRIPT = /(^|\s)\.\/?(\s|$)|\*|\brun-many\b|\bnx\b|\bturbo\b|\blerna\b/;
/** Env var that opts the format run out: "all" or "format". */
export const SKIP_ENV = 'CLAUDE_POST_EDIT_SKIP'; // set in a project's .claude/settings.json env

export { diagnostics, isSamePath } from './lib/diagnostics.mjs';

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

/**
 * Checks to run for `file`: [{ name, cmd?, args }]; without `cmd` the package manager runs `args`. Pure.
 * A format script that is broad would format the whole repo, so the tool's own binary (found by `findTool`) runs on
 * the file instead; when that binary is missing the check is skipped.
 */
export function plannedChecks(scripts, file, findTool = () => null) {
  const script = typeof scripts?.[FORMAT_SCRIPT] === 'string' ? scripts[FORMAT_SCRIPT] : null;
  if (script === null) return [];
  if (!isBroadScript(script)) return [{ name: FORMAT_SCRIPT, args: ['run', FORMAT_SCRIPT, '--', file] }];
  const [tool, ...flags] = FORMAT_TOOL;
  const cmd = findTool(tool);
  return cmd ? [{ name: FORMAT_SCRIPT, cmd, args: [...flags, file] }] : [];
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
    if (result.error) return [`${ctx.rel}:1 HOOK could not run ${ctx.pm} ${check.name}: ${result.error.message}`];
    if (result.status !== 0) return diagnostics(outputOf(result), ctx.rel);
  }
  return [];
}

/** Run the format check for `file`; resolves to the failure lines ([] = all passed or nothing to run). */
export async function checkFile(file) {
  if (!isCodeFile(file) || !existsSync(file)) return [];
  const dir = findPackageDir(file);
  if (!dir) return [];
  const rel = relative(dir, file).replace(/\\/g, '/');
  if (process.platform === 'win32' && !SAFE_PATH.test(rel)) return []; // shell is on: refuse metacharacters
  let scripts;
  try {
    // no wait and no link: a FIFO or device named package.json is reported unreadable instead of holding the hook (lib/plain-file.mjs)
    scripts = JSON.parse(readPlainFile(join(dir, 'package.json'), PACKAGE_JSON_MAX_BYTES)).scripts;
  } catch (error) {
    return [`${rel}:1 HOOK unreadable package.json in ${dir}: ${error.message}`];
  }
  const notSkipped = skipFilter(process.env[SKIP_ENV]);
  const checks = plannedChecks(scripts, rel, toolFinder(dir)).filter((c) => notSkipped(c.name));
  return runStages(checks, { pm: packageManager(dir), cwd: dir, rel, deadline: Date.now() + BUDGET_MS });
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
  const file = input?.tool_input?.file_path;
  if (typeof file !== 'string') return;
  const failures = await checkFile(file);
  if (failures.length) {
    process.stderr.write(failures.join('\n') + '\n');
    process.exitCode = 2;
  }
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
