// PostToolUse(Edit|Write|MultiEdit): run the project's own format/lint/typecheck scripts after a code file changes.
// Only scripts that exist in the nearest package.json run. A script that targets the whole repo (`prettier --write .`,
// `nx run-many`) is replaced by the tool's binary on the edited file, or skipped; CLAUDE_POST_EDIT_SKIP opts out.
// Silent on success; on failure prints at most 15 `file:line RULE-ID message` lines to stderr and exits 2. Never evaluates hook input; on Windows (shell on) the relative path must look safe.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const SAFE_PATH = /^[\w@%+=:,./-]+$/;
const MAX_LINES = 15;
const BUDGET_MS = 18_000; // hook timeout is 20 s
const FILE_SCRIPTS = ['format', 'lint']; // take the edited file after `--`
const PROJECT_SCRIPTS = ['typecheck']; // whole project; output is filtered to the edited file
const FILE_TOOLS = { format: ['prettier', '--write'], lint: ['eslint'] }; // per-file fallback for broad scripts
const BROAD_SCRIPT = /(^|\s)\.\/?(\s|$)|\*|\brun-many\b|\bnx\b|\bturbo\b|\blerna\b/;
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
const COLON_LINE = /^(.+?):(\d+)(?::\d+)?:? (?:(?:error|warning)\s+)?(.*)$/;
const RULE_SEPARATOR = /\s{2,}(?=\S+$)/; // eslint prints the rule id after two or more spaces

/** "message  rule-id" -> "rule-id message"; messages without a rule id get the generic id LINT. */
function withRule(text) {
  const [message, rule] = text.split(RULE_SEPARATOR);
  return rule ? `${rule} ${message}` : `LINT ${text}`;
}

/** Failure output -> at most 15 `file:line RULE-ID message` lines about `file`; falls back to the raw tail. Pure. */
export function diagnostics(output, file) {
  const norm = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');
  const target = norm(file);
  const aboutTarget = (p) => target.endsWith(norm(p)) || norm(p).endsWith(`/${target}`);
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const found = [];
  let aboutOtherFiles = false;
  for (const l of lines) {
    const t = TSC_LINE.exec(l);
    const c = t ? null : COLON_LINE.exec(l);
    const path = t?.[1] ?? c?.[1];
    if (path === undefined) continue;
    if (!aboutTarget(path)) aboutOtherFiles = true;
    else if (t) found.push(`${norm(t[1])}:${t[2]} ${t[3]} ${t[4]}`);
    else found.push(`${norm(c[1])}:${c[2]} ${withRule(c[3])}`);
  }
  // Failures only in other files are not this edit's problem: do not block on them.
  if (!found.length && aboutOtherFiles) return [];
  return (found.length ? found : lines.slice(-MAX_LINES)).slice(0, MAX_LINES);
}

function runCheck(pm, check, cwd, timeout) {
  // Windows package managers are .cmd shims and need a shell; SAFE_PATH keeps `file` free of metacharacters.
  const quote = process.platform === 'win32' && /\s/.test(check.cmd ?? '');
  const cmd = quote ? `"${check.cmd}"` : (check.cmd ?? pm);
  return spawnSync(cmd, check.args, { cwd, encoding: 'utf8', timeout, shell: process.platform === 'win32' });
}

/** Run planned checks for `file`; returns the failure lines ([] = all passed or nothing to run). */
export function checkFile(file) {
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
  const pm = packageManager(dir);
  const deadline = Date.now() + BUDGET_MS;
  const notSkipped = skipFilter(process.env[SKIP_ENV]);
  for (const check of plannedChecks(scripts, rel, toolFinder(dir)).filter((c) => notSkipped(c.name))) {
    const left = deadline - Date.now();
    if (left <= 0) return []; // out of time: do not block the edit on a slow project
    const r = runCheck(pm, check, dir, left);
    if (r.error) {
      if (r.error.code === 'ETIMEDOUT') return [];
      return [`${rel}:1 HOOK could not run ${pm} ${check.name}: ${r.error.message}`];
    }
    if (r.status !== 0) return diagnostics(`${r.stdout}\n${r.stderr}`, rel);
  }
  return [];
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
  const failures = checkFile(file);
  if (failures.length) {
    process.stderr.write(failures.join('\n') + '\n');
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
