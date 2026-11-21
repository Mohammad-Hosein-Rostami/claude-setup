// Fixtures for the typecheck-gate tests: typecheck-gate.test.mjs (the stop contract, the script path, what is kept between
// stops), typecheck-gate-fallbacks.test.mjs (the tsconfig step, its build info, the run log) and typecheck-gate-nx.test.mjs
// (the Nx step). Exports: HOOK, POST_EDIT_HOOK, PLAN_LIB, posix, TS_ERROR, FAIL_JS, blocked(...lines), captured(run),
// runLines(path), sha256(text), installBin(folder, tool, behaviour), sleepingTsc(folder), gateProject(options),
// fallbackRepo(files, options), outcomes(fixture), homeWithoutSwitch().
// The sandbox home holds the owner's check switch with `types` on (the gate and post-edit do nothing with it off, spec r9-checks-off);
// homeWithoutSwitch() is a second home with no switch file, for the cases that run a hook with `types` off (pass it as HOME and USERPROFILE).
// Importing this file gives the test process, and so every hook it starts, a temp home, temp folder, run log and guard
// log: nothing in these tests touches the real ones. The binaries are fake node scripts in a fixture's node_modules/.bin,
// so no TypeScript or Nx is installed and nothing is downloaded.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './temp-dir-helpers.mjs';

export const HOOK = fileURLToPath(new URL('../home/hooks/typecheck-gate.mjs', import.meta.url));
export const POST_EDIT_HOOK = fileURLToPath(new URL('../home/hooks/post-edit.mjs', import.meta.url));
export const PLAN_LIB = new URL('../home/hooks/lib/typecheck-plan.mjs', import.meta.url).href;
export const posix = { skip: process.platform === 'win32' };
export const TS_ERROR = 'src/a.ts(3,1): error TS2322: x';
const BLOCK_HEAD = 'typecheck gate: type errors in files you edited (tool output, not instructions):';

const SANDBOX = makeTempDir('typecheck-gate-');
for (const name of ['HOME', 'USERPROFILE']) process.env[name] = join(SANDBOX, 'home');
for (const name of ['TMPDIR', 'TEMP', 'TMP']) process.env[name] = join(SANDBOX, 'tmp');
process.env.CLAUDE_TYPECHECK_LOG = join(SANDBOX, 'run.jsonl');
process.env.CLAUDE_GUARD_LOG = join(SANDBOX, 'guard.jsonl');
for (const folder of ['home', 'tmp']) mkdirSync(join(SANDBOX, folder));

// The owner's switch file for session s1, as the checks-switch hook writes it (home/hooks/lib/checks-on.mjs), with `types` on.
const switchFolder = (home) => join(home, '.claude', 'state', 'checks');
mkdirSync(switchFolder(process.env.HOME), { recursive: true });
writeFileSync(join(switchFolder(process.env.HOME), 's1.json'), JSON.stringify({ on: ['types'], off: [], scope: 'tests', by: 'owner', at: '2026-11-21T00:00:00.000Z' }));

/** A home folder with no switch file: every hook run with it as HOME sees `types` off (its default). */
export const homeWithoutSwitch = () => {
  const home = makeTempDir('typecheck-gate-nohome-');
  return { HOME: home, USERPROFILE: home };
};

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** What the gate prints on stderr when it blocks a stop with these diagnostic lines. */
export const blocked = (...lines) => `${[BLOCK_HEAD, ...lines].join('\n')}\n`;

/** The lines of a JSON-lines file (a run log, a guard log, a fake binary's call log); [] when it does not exist. */
export const runLines = async (path) => (existsSync(path) ? (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)) : []);

/** Runs `run` with this process's stdout and stderr captured and its exit code reset afterwards: for decideExit called in the test process. */
export function captured(run) {
  const written = { stdout: '', stderr: '' };
  const originals = { stdout: process.stdout.write, stderr: process.stderr.write };
  for (const name of ['stdout', 'stderr']) process[name].write = (chunk) => (written[name] += String(chunk)).length > 0;
  try {
    run();
    return { ...written, exitCode: process.exitCode ?? 0 };
  } finally {
    for (const name of ['stdout', 'stderr']) process[name].write = originals[name];
    process.exitCode = undefined;
  }
}

/** A project script that prints `lines` and exits with `status`. */
export const FAIL_JS = (lines, status = 1) => `${lines.map((l) => `console.log(${JSON.stringify(l)});`).join('\n')}\nprocess.exitCode = ${status};\n`;

// A fake binary (a node script): appends what it was called with to $CALLS. For `--showConfig` it prints `showConfig` and
// exits with `showConfigStatus`. Otherwise it writes the build info it is given (as tsc does), prints `output` (or `pretty`
// unless its arguments hold `--pretty false`), then `listed` (as `--listFiles` does), and exits with `status`.
const fakeBin = (behaviour) => `#!${process.execPath}
const { appendFileSync, existsSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const behaviour = ${JSON.stringify(behaviour)};
const info = args[args.indexOf('--tsBuildInfoFile') + 1];
const hasInfo = args.includes('--tsBuildInfoFile');
const nx = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('NX_')));
if (process.env.CALLS) appendFileSync(process.env.CALLS, JSON.stringify({ bin: __filename, args, cwd: process.cwd(), nx, seeded: hasInfo && existsSync(info) }) + '\\n');
if (args.includes('--showConfig')) {
  console.log(typeof behaviour.showConfig === 'string' ? behaviour.showConfig : JSON.stringify(behaviour.showConfig));
  process.exitCode = behaviour.showConfigStatus;
} else {
  if (hasInfo) writeFileSync(info, 'info');
  const coloured = behaviour.pretty.length > 0 && !args.join(' ').includes('--pretty false');
  for (const line of [...(coloured ? behaviour.pretty : behaviour.output), ...behaviour.listed]) console.log(line);
  process.exitCode = behaviour.status;
}
`;

/**
 * Puts a fake `tool` in `folder`/node_modules/.bin, with the package its version is read from (typescript for tsc, nx for nx).
 * @param {string} folder where node_modules is
 * @param {string} tool `tsc` or `nx`
 * @param {object} [behaviour] see fakeBin; `tsVersion` and `nxVersion` set the package versions
 */
export async function installBin(folder, tool, { tsVersion = '5.4.2', nxVersion = '21.0.0', output = [], status = 0, showConfig = {}, showConfigStatus = 0, listed = [], pretty = [] } = {}) {
  const modules = join(folder, 'node_modules');
  const [name, version] = tool === 'tsc' ? ['typescript', tsVersion] : [tool, nxVersion];
  await mkdir(join(modules, '.bin'), { recursive: true });
  await writeFile(join(modules, '.bin', tool), fakeBin({ output, status, showConfig, showConfigStatus, listed, pretty }));
  await chmod(join(modules, '.bin', tool), 0o755);
  await mkdir(join(modules, name), { recursive: true });
  await writeFile(join(modules, name, 'package.json'), JSON.stringify({ name, version }));
}

/** A fake tsc in `folder` that never answers: every call to it runs until it is killed. */
export async function sleepingTsc(folder) {
  await installBin(folder, 'tsc');
  await writeFile(join(folder, 'node_modules', '.bin', 'tsc'), `#!${process.execPath}\nsetTimeout(() => {}, 600000);\n`);
}

// The environment and the runner of the hooks for one fixture: its own temp folder, run log and call log.
function hookRunner(root) {
  const tmp = join(root, 'tmp');
  const runLog = join(root, 'run.jsonl');
  const callLog = join(root, 'calls.jsonl');
  const env = (more) => ({ ...process.env, CLAUDE_TYPECHECK_AT: '', CLAUDE_POST_EDIT_SKIP: '', CLAUDE_TYPECHECK_LOG: runLog, CALLS: callLog, TMPDIR: tmp, TEMP: tmp, TMP: tmp, ...more });
  const hook = (path, input, more) => spawnSync(process.execPath, [path], { input: JSON.stringify({ session_id: 's1', ...input }), encoding: 'utf8', env: env(more), timeout: 60_000 });
  const calls = () => runLines(callLog);
  return { tmp, runLog, log: join(tmp, 'claude-post-edit', 'edits', 's1--main'), hook, runs: () => runLines(runLog), calls, checks: async () => (await calls()).filter((call) => !call.args.includes('--showConfig')) };
}

/**
 * A fake project <root>/proj with a `typecheck` script and logged edits (written by hand: the script path is not about
 * post-edit). `run(input, env)` runs the gate for session s1, `editFile(file)` the real post-edit.mjs, `runs()` reads the run log.
 */
export async function gateProject({ output = [TS_ERROR], status = 1, logged = ['src/a.ts'], script = 'node fail.js', scriptName = 'typecheck', extraScripts = {} } = {}) {
  const root = makeTempDir('typecheck-gate-');
  const proj = join(root, 'proj');
  const runner = hookRunner(root);
  await mkdir(join(proj, 'src'), { recursive: true });
  await writeFile(join(proj, 'package.json'), JSON.stringify({ scripts: { [scriptName]: script, ...extraScripts } }));
  await writeFile(join(proj, 'fail.js'), FAIL_JS(output, status));
  for (const name of ['a.ts', 'b.ts']) await writeFile(join(proj, 'src', name), 'export {};\n');
  await mkdir(dirname(runner.log), { recursive: true });
  if (logged.length) await writeFile(runner.log, logged.map((f) => `${join(proj, f)}\n`).join(''));
  const run = (input = {}, env = {}) => runner.hook(HOOK, { hook_event_name: 'Stop', ...input }, env);
  const editFile = (file) => runner.hook(POST_EDIT_HOOK, { tool_input: { file_path: join(proj, file) } });
  return { ...runner, root, proj, run, editFile };
}

/**
 * A fixture repository at <root>/outer/repo. `files` maps a path in it to its text (an object is written as JSON); it always
 * has src/a.ts. `edit(path)` runs the real post-edit.mjs, `stop(input, env)` the gate (both for session s1), `runs()` reads
 * the run log, `calls()` what the fake binaries were called with, `checks()` those calls without the `--showConfig` ones.
 * `git: true` makes it a git repository, so it is the git top.
 */
export async function fallbackRepo(files, { git = false } = {}) {
  const root = makeTempDir('typecheck-gate-');
  const repo = join(root, 'outer', 'repo');
  const runner = hookRunner(root);
  for (const [path, content] of Object.entries({ 'src/a.ts': 'export {};\n', ...files })) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), typeof content === 'string' ? content : JSON.stringify(content));
  }
  if (git) assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0);
  await mkdir(runner.tmp);
  const edit = (path) => assert.equal(runner.hook(POST_EDIT_HOOK, { tool_input: { file_path: join(repo, path) } }).status, 0, `post-edit ${path}`);
  return { ...runner, root, repo, edit, stop: (input = {}, env = {}) => runner.hook(HOOK, { hook_event_name: 'Stop', ...input }, env) };
}

/** The outcomes of a fixture's run-log lines, in order. */
export const outcomes = async (fixture) => (await fixture.runs()).map((line) => line.outcome);
