// PostToolUse(Edit|Write|MultiEdit): run the project's own format/lint/typecheck scripts after a code file changes.
// Only scripts that exist in the nearest package.json run. A script that targets the whole repo (`prettier --write .`,
// `nx run-many`) is replaced by the tool's binary on the edited file, or skipped; CLAUDE_POST_EDIT_SKIP opts out.
// Format runs first and alone; lint and typecheck then run concurrently (sequentially when the lint script fixes files; a check that outlives the deadline is killed with its whole process tree).
// Silent on success; on failure prints at most 15 `file:line RULE-ID message` lines to stderr and exits 2. Never evaluates hook input; on Windows (shell on) the relative path must look safe.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const SAFE_PATH = /^[\w@+=:,./-]+$/; // no `%`: cmd.exe expands %VAR%
const MAX_LINES = 15;
const BUDGET_MS = 18_000; // hook timeout is 20 s
const FILE_SCRIPTS = ['format', 'lint']; // take the edited file after `--`
const PROJECT_SCRIPTS = ['typecheck']; // whole project; output is filtered to the edited file
const FILE_TOOLS = { format: ['prettier', '--write'], lint: ['eslint'] }; // per-file fallback for broad scripts
const BROAD_SCRIPT = /(^|\s)\.\/?(\s|$)|\*|\brun-many\b|\bnx\b|\bturbo\b|\blerna\b/;
const FIXING_SCRIPT = /\bfix\b|--write\b|--apply\b/; // a lint script that rewrites the file while tsc reads it: keep those checks sequential
const SKIP_ENV = 'CLAUDE_POST_EDIT_SKIP'; // "all" or e.g. "typecheck,lint"; set in a project's .claude/settings.json env

export const isCodeFile = (file) => CODE_FILE.test(file);

function findPackageDir(file) {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

function packageManager(dir) {
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
 */
export function plannedChecks(scripts, file, findTool = () => null) {
  const script = (n) => (typeof scripts?.[n] === 'string' ? scripts[n] : null);
  const fileChecks = FILE_SCRIPTS.flatMap((name) => {
    const s = script(name);
    if (s === null) return [];
    if (!isBroadScript(s)) return [{ name, args: ['run', name, '--', file] }];
    const [tool, ...flags] = FILE_TOOLS[name];
    const cmd = findTool(tool);
    return cmd ? [{ name, cmd, args: [...flags, file] }] : [];
  });
  const projectChecks = PROJECT_SCRIPTS.filter((n) => script(n) !== null && !isBroadScript(script(n)));
  return [...fileChecks, ...projectChecks.map((name) => ({ name, args: ['run', name] }))];
}

// Nearest node_modules/.bin/<tool> walking up from `dir` (a monorepo hoists binaries to the root).
function toolFinder(dir) {
  const exe = process.platform === 'win32' ? '.cmd' : '';
  return (tool) => {
    for (let d = dir; ; d = dirname(d)) {
      const bin = join(d, 'node_modules', '.bin', tool + exe);
      if (existsSync(bin)) return bin;
      if (dirname(d) === d) return null;
    }
  };
}

const TSC_LINE = /^(.+?)\((\d+),\d+\): (?:error|warning) (TS\d+): (.*)$/;
// `path:line[:col]: message` (tsc --pretty false, eslint unix format); the lookahead keeps stylish rows out.
const COLON_LINE = /^(?!\d+:)(.+?):(\d+)(?::\d+)?:? (?:(?:error|warning)\s+)?(.*)$/;
const STYLISH_ROW = /^(\d+):\d+\s+(?:error|warning)\s+(.*)$/; // eslint default format row under a file header
const RULE_SEPARATOR = /\s{2,}(?=\S+$)/; // eslint prints the rule id after two or more spaces

/** "message  rule-id" -> "rule-id message"; messages without a rule id get the generic id LINT. */
function withRule(text) {
  const [message, rule] = text.split(RULE_SEPARATOR);
  return rule ? `${rule} ${message}` : `LINT ${text}`;
}

const normPath = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');

/** Whether a reported path is `target`: equal, or one is the other behind a `/` boundary (abs vs relative path). */
export function isSamePath(reported, target) {
  const p = normPath(reported);
  const t = normPath(target);
  return p === t || p.endsWith(`/${t}`) || t.endsWith(`/${p}`);
}

// An eslint stylish file header: a path-looking line without `:line`; pnpm's `> pkg@1 lint /dir` banner is not one.
const isStylishHeader = (l) => !l.startsWith('>') && !/:\d+/.test(l) && (CODE_FILE.test(l) || /[\\/]/.test(l));

/** One output line -> { path, text } for a `path:line message` diagnostic, or null; `header` is the stylish file in effect. */
function parseDiagnostic(l, header) {
  const t = TSC_LINE.exec(l);
  if (t) return { path: t[1], text: `${t[2]} ${t[3]} ${t[4]}` };
  const s = header ? STYLISH_ROW.exec(l) : null;
  if (s) return { path: header, text: `${s[1]} ${withRule(s[2])}` };
  const c = COLON_LINE.exec(l);
  return c ? { path: c[1], text: `${c[2]} ${withRule(c[3])}` } : null;
}

/**
 * Failure output (tsc, eslint stylish or unix format) -> at most 15 `file:line RULE-ID message` lines about `file`;
 * falls back to the raw tail. Failures that only concern other files yield [] so they do not block. Pure.
 */
export function diagnostics(output, file) {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const found = [];
  let aboutOtherFiles = false;
  let header = null;
  for (const l of lines) {
    const d = parseDiagnostic(l, header);
    if (!d) {
      if (isStylishHeader(l)) header = l;
      continue;
    }
    if (isSamePath(d.path, file)) found.push(`${normPath(d.path)}:${d.text}`);
    else aboutOtherFiles = true;
  }
  if (!found.length && aboutOtherFiles) return [];
  return (found.length ? found : lines.slice(-MAX_LINES)).slice(0, MAX_LINES);
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

// Async spawn that resolves (never rejects) to { status, stdout, stderr, error, timedOut }. On the deadline it resolves
// from the timer itself: a grandchild holding the pipes open must not delay `close`.
function runCheck(pm, check, cwd, timeoutMs) {
  // Windows package managers are .cmd shims and need a shell; SAFE_PATH keeps `file` free of metacharacters.
  const cmd = shellCommand(check.cmd ?? pm);
  return new Promise((resolve) => {
    const child = spawn(cmd, check.args, { cwd, shell: process.platform === 'win32', detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      killTree(child);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ status: null, stdout, stderr, error: null, timedOut: true });
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr, error, timedOut: false });
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, error: null, timedOut: false });
    });
  });
}

/**
 * Runs stages in order until the deadline (epoch ms); results are judged in plan order (lint before typecheck), so
 * the first failing check decides. A timeout or an exhausted budget returns [] (never a false failure).
 * Returns the failure lines ([] = all passed).
 */
export async function runStages(stages, { pm, cwd, rel, deadline }) {
  for (const stage of stages) {
    const left = deadline - Date.now();
    if (left <= 0) return []; // out of time: do not block the edit on a slow project
    const results = await Promise.all(stage.map((check) => runCheck(pm, check, cwd, left)));
    for (const [i, r] of results.entries()) {
      if (r.timedOut) return [];
      if (r.error) return [`${rel}:1 HOOK could not run ${pm} ${stage[i].name}: ${r.error.message}`];
      if (r.status !== 0) return diagnostics(`${r.stdout}\n${r.stderr}`, rel);
    }
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
