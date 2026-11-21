// PostToolUse(Edit|Write|MultiEdit): run the project's own format/lint scripts after a code file changes, and log every
// edited code file of a package for typecheck-gate.mjs, which typechecks once when the agent stops and decides there what
// runs or is skipped. CLAUDE_TYPECHECK_AT=edit restores the typecheck after every edit (and turns the gate off: nothing is
// logged). Only scripts that exist in the nearest package.json run.
// A script that targets the whole repo (`prettier --write .`, `nx run-many`) is replaced by the tool's binary on the
// edited file, or skipped; CLAUDE_POST_EDIT_SKIP opts out.
// Format runs first and alone; lint and typecheck (at-edit mode) then run concurrently (sequentially when the lint
// script fixes files); a lint failure about the edited file ends that stage at once and kills the typecheck; a check
// that outlives the deadline is killed with its whole process tree.
// Lint and typecheck run only with `types` on (/check, lib/checks-on.mjs); format always runs (C21), and with `types` off no edit is logged
// for the typecheck gate; with `smart` on (default) every edited file is logged for home/hooks/smart-check.mjs. Silent on success; on failure
// prints at most 15 `file:line RULE-ID message` lines and exits 2. Never evaluates hook input; on Windows (shell on) the relative path must look safe.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CODE_FILE, diagnostics } from './lib/diagnostics.mjs';
import { editLogPath, recordEdit, smartLogOf } from './lib/edit-log.mjs';
import { isOn, sessionIdOf } from './lib/checks-on.mjs';

const SAFE_PATH = /^[\w@+=:,./-]+$/; // no `%`: cmd.exe expands %VAR%
const BUDGET_MS = 18_000; // hook timeout is 20 s
const FILE_SCRIPTS = ['format', 'lint']; // take the edited file after `--`
const TYPECHECK_SCRIPTS = ['typecheck', 'type-check']; // whole project; output is filtered to the edited file; the first that exists runs
const FILE_TOOLS = { format: ['prettier', '--write'], lint: ['eslint'] }; // per-file fallback for broad scripts
const BROAD_SCRIPT = /(^|\s)\.\/?(\s|$)|\*|\brun-many\b|\bnx\b|\bturbo\b|\blerna\b/;
const FIXING_SCRIPT = /\bfix\b|--write\b|--apply\b/; // a lint script that rewrites the file while tsc reads it: keep those checks sequential
/** Env var that opts checks out: "all" or a comma list such as "typecheck,lint". */
export const SKIP_ENV = 'CLAUDE_POST_EDIT_SKIP'; // "all" or e.g. "typecheck,lint"; set in a project's .claude/settings.json env
export const TYPECHECK_AT_ENV = 'CLAUDE_TYPECHECK_AT'; // "edit": typecheck after every edit instead of once at agent stop

/** True when the typecheck runs after every edit (env `CLAUDE_TYPECHECK_AT=edit`) rather than in the stop gate. */
export const typecheckAtEdit = (env = process.env) => env[TYPECHECK_AT_ENV] === 'edit';

export { diagnostics, isSamePath } from './lib/diagnostics.mjs';

export const isCodeFile = (file) => CODE_FILE.test(file);

/**
 * The package script that typechecks the project: the first of `typecheck`, `type-check` that is a string.
 * @param {Record<string, unknown> | undefined} scripts the `scripts` of a package.json
 * @returns {{ name: string, text: string } | null}
 */
export function typecheckScript(scripts) {
  const name = TYPECHECK_SCRIPTS.find((candidate) => typeof scripts?.[candidate] === 'string');
  return name ? { name, text: scripts[name] } : null;
}

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

/** True when a script already targets the whole repo (`prettier --write .`, `eslint src/**`, `nx run-many`, ...). */
export const isBroadScript = (script) => BROAD_SCRIPT.test(script);

/** `skip` env value ("all" or "lint,typecheck") -> predicate on check names. Pure. */
export const skipFilter = (skip = '') => {
  const names = new Set(skip.split(',').map((s) => s.trim()).filter(Boolean));
  return (name) => !names.has('all') && !names.has(name);
};

/**
 * Checks to run for `file`: [{ name, cmd?, args }]; without `cmd` the package manager runs `args`. Pure.
 * A file script that is broad would check the whole repo, so the tool's own binary (found by `findTool`) runs on
 * the file instead; a broad project script (e.g. `nx run-many -t typecheck`) is too slow for a hook and is skipped.
 * The typecheck is planned only in at-edit mode (`atEdit`, default from the env); otherwise the stop gate runs it.
 */
export function plannedChecks(scripts, file, findTool = () => null, atEdit = typecheckAtEdit()) {
  const script = (n) => (typeof scripts?.[n] === 'string' ? scripts[n] : null);
  const fileChecks = FILE_SCRIPTS.flatMap((name) => {
    const s = script(name);
    if (s === null) return [];
    if (!isBroadScript(s)) return [{ name, args: ['run', name, '--', file] }];
    const [tool, ...flags] = FILE_TOOLS[name];
    const cmd = findTool(tool);
    return cmd ? [{ name, cmd, args: [...flags, file] }] : [];
  });
  const typecheck = typecheckScript(scripts);
  const projectChecks = atEdit && typecheck && !isBroadScript(typecheck.text) ? [{ name: 'typecheck', args: ['run', typecheck.name] }] : [];
  return [...fileChecks, ...projectChecks];
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
 * Groups planned checks into stages that run one after another; checks inside a stage run concurrently.
 * Format stays alone and first; lint and typecheck share a stage unless the lint script contains `fix`, `--write` or `--apply`. Pure.
 */
export function stagesFor(checks, scripts) {
  const lint = checks.findIndex((c) => c.name === 'lint');
  const typecheck = checks.findIndex((c) => c.name === 'typecheck');
  const concurrent = lint >= 0 && typecheck === lint + 1 && !FIXING_SCRIPT.test(scripts?.lint ?? '');
  const stages = [];
  checks.forEach((check, i) => {
    if (concurrent && i === typecheck) stages.at(-1).push(check);
    else stages.push([check]);
  });
  return stages;
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

/** Verdict on finished checks, in plan order (lint before typecheck): failure lines, or null when all passed. */
function judge(results, stage, { pm, rel }) {
  for (const [i, r] of results.entries()) {
    if (r.timedOut) return [];
    if (r.error) return [`${rel}:1 HOOK could not run ${pm} ${stage[i].name}: ${r.error.message}`];
    if (r.status !== 0) return diagnostics(outputOf(r), rel);
  }
  return null;
}

// Resolves with the diagnostics of a lint that failed about the edited file; stays pending in every other case.
function lintFailure(stage, runs, rel) {
  return new Promise((resolve) => {
    stage.forEach((check, i) =>
      runs[i].then((r) => {
        if (check.name !== 'lint' || r.error || r.timedOut || r.status === 0) return;
        const lines = diagnostics(outputOf(r), rel);
        if (lines.length) resolve(lines);
      }),
    );
  });
}

// A concurrent stage returns as soon as lint reports failures about the edited file and kills the slower typecheck.
async function runStage(stage, ctx, left) {
  const runs = stage.map((check) => runCheck(ctx.pm, check, ctx.cwd, left));
  const all = Promise.all(runs);
  if (stage.length > 1) {
    const early = await Promise.race([lintFailure(stage, runs, ctx.rel), all.then(() => null)]);
    if (early) {
      runs.forEach((run) => run.kill());
      return early;
    }
  }
  return judge(await all, stage, ctx);
}

/**
 * Runs stages in order until the deadline (epoch ms); results are judged in plan order (lint before typecheck), so
 * the first failing check decides. A lint failure about `rel` ends a concurrent stage at once; a lint failure that
 * only concerns other files waits for the typecheck as before. A timeout or an exhausted budget returns [] (never a
 * false failure). Returns the failure lines ([] = all passed).
 */
export async function runStages(stages, ctx) {
  for (const stage of stages) {
    const left = ctx.deadline - Date.now();
    if (left <= 0) return []; // out of time: do not block the edit on a slow project
    const verdict = await runStage(stage, ctx, left);
    if (verdict) return verdict;
  }
  return [];
}

/** Run planned checks for `file`; resolves to the failure lines ([] = all passed or nothing to run). */
export async function checkFile(file) {
  if (!isCodeFile(file) || !existsSync(file)) return [];
  const dir = findPackageDir(file);
  if (!dir) return [];
  const rel = relative(dir, file).replace(/\\/g, '/');
  if (process.platform === 'win32' && !SAFE_PATH.test(rel)) return []; // shell is on: refuse metacharacters
  let scripts;
  try {
    scripts = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts;
  } catch (error) {
    return [`${rel}:1 HOOK unreadable package.json in ${dir}: ${error.message}`];
  }
  const notSkipped = skipFilter(process.env[SKIP_ENV]);
  const checks = plannedChecks(scripts, rel, toolFinder(dir)).filter((c) => notSkipped(c.name));
  return runStages(stagesFor(checks, scripts), { pm: packageManager(dir), cwd: dir, rel, deadline: Date.now() + BUDGET_MS });
}

// Remember every edited code file of a package for the stop gate. The gate, not this hook, decides what runs for it (the
// typecheck script, the Nx target, the nearest tsconfig) or why it is skipped: a rule here once kept every package without
// a `typecheck` script out of the log, so the gate never ran. A file with no package.json above it is out of scope.
function recordTypecheckEdit(file, input) {
  const logPath = editLogPath(input.session_id, input.agent_id);
  if (logPath && isCodeFile(file) && existsSync(file) && findPackageDir(file)) recordEdit(logPath, file);
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
  const typesOn = isOn('types', sessionIdOf(input));
  if (isAbsolute(file) && isOn('smart', sessionIdOf(input))) recordEdit(smartLogOf(editLogPath(input.session_id, input.agent_id)), file); // for the smart check's Stop hook
  if (!typesOn) process.env[SKIP_ENV] = [process.env[SKIP_ENV], 'lint', 'typecheck'].filter(Boolean).join(','); // format only
  if (typesOn && !typecheckAtEdit()) recordTypecheckEdit(file, input);
  const failures = await checkFile(file);
  if (failures.length) {
    process.stderr.write(failures.join('\n') + '\n');
    process.exitCode = 2;
  }
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
