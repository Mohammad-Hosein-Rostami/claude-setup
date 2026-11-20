// Tests for home/hooks/typecheck-gate.mjs: incremental tsc planning, the Stop/SubagentStop contract (exit codes, loop
// guard, log clean-up), the shared tsbuildinfo hand-off, the budget, the run log and the fallbacks for a package without a
// usable typecheck script (its Nx typecheck target, then the nearest tsconfig.json). Runs the real hooks against fake projects:
// the binaries are fake node scripts in the fixture's node_modules/.bin, so no TypeScript or Nx is installed and nothing is
// downloaded. The test process and every hook it starts get a temp home, temp folder and run log; no test asserts elapsed time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decideExit, incrementalTypecheck, runGate, timeoutMessage, typescriptMajor } from '../home/hooks/typecheck-gate.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/typecheck-gate.mjs', import.meta.url));
const POST_EDIT_HOOK = fileURLToPath(new URL('../home/hooks/post-edit.mjs', import.meta.url));
const PLAN_LIB = new URL('../home/hooks/lib/typecheck-plan.mjs', import.meta.url).href;
const posix = { skip: process.platform === 'win32' };

// Nothing here may touch the real home, temp folder or logs: the test process and every hook it starts get temp ones.
const SANDBOX = makeTempDir('typecheck-gate-');
for (const name of ['HOME', 'USERPROFILE']) process.env[name] = join(SANDBOX, 'home');
for (const name of ['TMPDIR', 'TEMP', 'TMP']) process.env[name] = join(SANDBOX, 'tmp');
process.env.CLAUDE_TYPECHECK_LOG = join(SANDBOX, 'run.jsonl');
process.env.CLAUDE_GUARD_LOG = join(SANDBOX, 'guard.jsonl');
for (const folder of ['home', 'tmp']) mkdirSync(join(SANDBOX, folder));

// The lines of a run log (one JSON object per line); [] when the hook wrote none.
const runLines = async (path) => (existsSync(path) ? (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)) : []);
const TSC = '/p/node_modules/.bin/tsc';
const INFO = '/tmp/private.tsbuildinfo';

test('incrementalTypecheck extends a plain tsc script with the incremental flags', () => {
  assert.deepEqual(incrementalTypecheck('tsc --noEmit -p tsconfig.app.json', 5, TSC, INFO), {
    cmd: TSC,
    args: ['--noEmit', '-p', 'tsconfig.app.json', '--incremental', '--tsBuildInfoFile', INFO],
  });
  assert.deepEqual(incrementalTypecheck('tsc', 4, TSC, INFO)?.args, ['--incremental', '--tsBuildInfoFile', INFO]);
  assert.ok(incrementalTypecheck('tsc --noEmit', 6, TSC, INFO));
});

test('incrementalTypecheck gives up on anything but a plain tsc call on TS 4 to 6', () => {
  for (const script of ['tsc -b', 'tsc --build', 'vue-tsc --noEmit', 'tsc && x', 'tsc | cat', 'tsc; x', 'tsc > out', 'tsc $X', 'tsc `x`', `tsc -p 'a b.json'`, 'tsc -p "a b.json"', `tsc -p x'`, 'tsc -w', 'tsc --watch', 'tsc --incremental', 'tsc --tsBuildInfoFile x', 'tsc --tsBuildInfoFile=x', 'pnpm exec tsc', 'node fail.js', '']) {
    assert.equal(incrementalTypecheck(script, 5, TSC, INFO), null, script);
  }
  for (const major of [3, 7, 8, Number.NaN]) assert.equal(incrementalTypecheck('tsc --noEmit', major, TSC, INFO), null, String(major));
});

test('incrementalTypecheck on win32 needs paths the unquoted Windows shell can take', () => {
  const script = 'tsc --noEmit';
  assert.ok(incrementalTypecheck(script, 5, 'C:\\p\\node_modules\\.bin\\tsc.cmd', 'C:\\t\\info', 'win32'));
  assert.equal(incrementalTypecheck(script, 5, 'C:\\Program Files\\p\\tsc.cmd', 'C:\\t\\info', 'win32'), null);
  assert.equal(incrementalTypecheck(script, 5, 'C:\\p\\tsc.cmd', 'C:\\Users\\Jo Doe\\Temp\\info', 'win32'), null);
  assert.equal(incrementalTypecheck(script, 5, 'C:\\p\\tsc.cmd', 'C:\\t\\100%\\info', 'win32'), null);
  assert.equal(incrementalTypecheck('tsc --noEmit -p a^b.json', 5, 'C:\\p\\tsc.cmd', 'C:\\t\\info', 'win32'), null);
  assert.ok(incrementalTypecheck(script, 5, '/a b/tsc', '/tmp/x y/info', 'linux'), 'posix spawns without a shell: spaces are fine');
});

const FAIL_JS = (lines, status = 1) => `${lines.map((l) => `console.log(${JSON.stringify(l)});`).join('\n')}\nprocess.exitCode = ${status};\n`;

// A fake project with logged edits. `tmp` is the redirected temp dir; `run(input, env)` runs the hook for session s1.
async function gateProject({ output = ['src/a.ts(3,1): error TS2322: x'], status = 1, logged = ['src/a.ts'], script = 'node fail.js', scriptName = 'typecheck', extraScripts = {} } = {}) {
  const root = makeTempDir('typecheck-gate-');
  const proj = join(root, 'proj');
  await mkdir(join(proj, 'src'), { recursive: true });
  await writeFile(join(proj, 'package.json'), JSON.stringify({ scripts: { [scriptName]: script, ...extraScripts } }));
  await writeFile(join(proj, 'fail.js'), FAIL_JS(output, status));
  for (const name of ['a.ts', 'b.ts']) await writeFile(join(proj, 'src', name), 'export {};\n');
  const tmp = join(root, 'tmp');
  const edits = join(tmp, 'claude-post-edit', 'edits');
  await mkdir(edits, { recursive: true });
  const log = join(edits, 's1--main');
  if (logged.length) await writeFile(log, logged.map((f) => `${join(proj, f)}\n`).join(''));
  const runLog = join(root, 'run.jsonl');
  const gateEnv = (env = {}) => ({ ...process.env, CLAUDE_TYPECHECK_AT: '', CLAUDE_POST_EDIT_SKIP: '', CLAUDE_TYPECHECK_LOG: runLog, TMPDIR: tmp, TEMP: tmp, TMP: tmp, ...env });
  const run = (input = {}, env = {}) =>
    spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: 's1', hook_event_name: 'Stop', ...input }), encoding: 'utf8', env: gateEnv(env) });
  // The PostToolUse hook that logs an edited file for the gate.
  const editFile = (file) =>
    spawnSync(process.execPath, [POST_EDIT_HOOK], { input: JSON.stringify({ session_id: 's1', tool_input: { file_path: join(proj, file) } }), encoding: 'utf8', env: gateEnv() });
  return { proj, tmp, log, run, editFile, runs: () => runLines(runLog) };
}

test('hook contract: bad JSON, empty stdin and no log exit 0 silently', () => {
  for (const input of ['not json', '', JSON.stringify({}), JSON.stringify({ session_id: 'nothing-logged' })]) {
    const r = spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout + r.stderr, '');
  }
});

test('no log for this session is a silent pass and writes no run-log line', async () => {
  const { run, runs } = await gateProject({ logged: [] });
  const r = run();
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, '');
  assert.deepEqual(await runs(), []);
});

test('a failing typecheck about a logged file blocks the stop with that line', async () => {
  const { run, log } = await gateProject();
  const r = run();
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'src/a.ts:3 TS2322 x\n');
  assert.ok(existsSync(log), 'the log stays so the next stop checks again');
});

test('a package whose script is named type-check is gated like one named typecheck', async () => {
  const { run, log } = await gateProject({ scriptName: 'type-check' });
  const r = run();
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'src/a.ts:3 TS2322 x\n');
  assert.ok(existsSync(log));
});

test('when both scripts exist the typecheck script runs and type-check does not', async () => {
  const { run } = await gateProject({ script: 'node -e 0', status: 0, extraScripts: { 'type-check': 'node fail.js' } });
  const r = run();
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, '');
});

test('post-edit logs an edit in a type-check package, so the gate checks it at stop', async () => {
  const { run, log, editFile } = await gateProject({ scriptName: 'type-check', logged: [] });
  assert.equal(existsSync(log), false);
  assert.equal(editFile('src/a.ts').status, 0);
  assert.equal(existsSync(log), true);
  assert.equal(run().status, 2);
});

test('the same failure after a retry (stop_hook_active) lets the agent stop with a user message', async () => {
  const { run } = await gateProject();
  assert.equal(run().status, 2);
  const r = run({ stop_hook_active: true });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.match(JSON.parse(r.stdout).systemMessage, /src\/a\.ts:3 TS2322 x/);
});

test('a retry that changed the failure blocks again; stop_hook_active alone does not pass a first failure', async () => {
  const { run, proj } = await gateProject();
  assert.equal(run({ stop_hook_active: true }).status, 2, 'no earlier failure recorded');
  await writeFile(join(proj, 'fail.js'), FAIL_JS(['src/a.ts(9,1): error TS2322: y']));
  const r = run({ stop_hook_active: true });
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'src/a.ts:9 TS2322 y\n');
});

test('a passing typecheck removes the log and stays silent', async () => {
  const { run, log } = await gateProject({ output: [], status: 0 });
  const r = run();
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, '');
  assert.ok(!existsSync(log));
});

test('errors only in unlogged files do not fail the gate', async () => {
  const { run, log } = await gateProject({ output: ['src/b.ts(1,1): error TS2322: elsewhere'] });
  const r = run();
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, '');
  assert.ok(!existsSync(log));
});

test('errors of every logged file in the package are reported together, capped at 15', async () => {
  const many = Array.from({ length: 20 }, (_, i) => `src/b.ts(${i + 1},1): error TS1: m`);
  const { run } = await gateProject({ output: ['src/a.ts(3,1): error TS2322: x', ...many], logged: ['src/a.ts', 'src/b.ts'] });
  const lines = run().stderr.trim().split('\n');
  assert.equal(lines.length, 15);
  assert.equal(lines[0], 'src/a.ts:3 TS2322 x');
});

test('CLAUDE_TYPECHECK_AT=edit and CLAUDE_POST_EDIT_SKIP=typecheck/all disable the gate', async () => {
  const { run, log } = await gateProject();
  for (const env of [{ CLAUDE_TYPECHECK_AT: 'edit' }, { CLAUDE_POST_EDIT_SKIP: 'typecheck' }, { CLAUDE_POST_EDIT_SKIP: 'all' }]) {
    const r = run({}, env);
    assert.equal(r.status, 0, JSON.stringify(env));
    assert.equal(r.stdout + r.stderr, '');
  }
  assert.ok(existsSync(log));
});

test('a subagent stop checks only its own log', async () => {
  const { run, log } = await gateProject();
  const r = run({ hook_event_name: 'SubagentStop', agent_id: 'agent-1', agent_type: 'implementer' });
  assert.equal(r.status, 0);
  assert.ok(existsSync(log), 'the main log is untouched');
});

test('runGate reports a timeout instead of a failure when the budget is gone', posix, async () => {
  const { proj } = await gateProject();
  const file = join(proj, 'src', 'a.ts');
  assert.deepEqual(await runGate([file], Date.now() - 1), { timedOut: true, lines: [], unparsed: [], unchecked: [file] });
});

test('runGate with nothing to check passes', async () => {
  assert.deepEqual(await runGate([join(tmpdir(), 'nonexistent-file.ts')], Date.now() + 1000), { timedOut: false, lines: [], unparsed: [], unchecked: [] });
});

// Fake `tsc` (a node script): records its args and whether the build info existed, then writes the build info.
const FAKE_TSC = `#!${process.execPath}
const { appendFileSync, existsSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const info = args[args.indexOf('--tsBuildInfoFile') + 1];
appendFileSync(process.env.TSC_LOG, JSON.stringify({ args, seeded: existsSync(info) }) + '\\n');
writeFileSync(info, 'info');
`;

test('a plain tsc script runs incrementally and hands its build info to the next run', posix, async () => {
  const { proj, tmp, run } = await gateProject({ script: 'tsc --noEmit' });
  const bin = join(proj, 'node_modules', '.bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'tsc'), FAKE_TSC);
  await chmod(join(bin, 'tsc'), 0o755);
  await mkdir(join(proj, 'node_modules', 'typescript'));
  await writeFile(join(proj, 'node_modules', 'typescript', 'package.json'), JSON.stringify({ name: 'typescript', version: '5.4.2' }));
  const tscLog = join(tmp, 'tsc.log');
  const edits = join(tmp, 'claude-post-edit', 'edits', 's1--main');
  for (let i = 0; i < 2; i++) {
    await writeFile(edits, `${join(proj, 'src', 'a.ts')}\n`);
    assert.equal(run({}, { TSC_LOG: tscLog }).status, 0);
  }
  const calls = (await readFile(tscLog, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(calls.map((c) => c.seeded), [false, true], 'second run starts from the shared build info');
  assert.deepEqual(calls[0].args.slice(0, 3), ['--noEmit', '--incremental', '--tsBuildInfoFile']);
  const shared = join(tmp, 'claude-post-edit', 'tsbuildinfo', createHash('sha256').update(proj).digest('hex'));
  assert.equal(await readFile(shared, 'utf8'), 'info');
  assert.ok(!existsSync(`${calls[0].args[3]}`), 'no private build info left behind');
});

test('a failure the user was already shown does not block again', async () => {
  const { run, log } = await gateProject();
  assert.equal(run().status, 2);
  assert.equal(run({ stop_hook_active: true }).status, 0, 'loop guard: shown to the user');
  const later = run();
  assert.equal(later.status, 0);
  assert.equal(later.stderr, '');
  assert.match(JSON.parse(later.stdout).systemMessage, /src\/a\.ts:3 TS2322 x/);
  assert.ok(existsSync(log), 'the log stays: the errors are still there');
});

test('a different failure after a shown one blocks again, and a pass clears every record', async () => {
  const { run, proj, log } = await gateProject();
  run();
  run({ stop_hook_active: true });
  await writeFile(join(proj, 'fail.js'), FAIL_JS(['src/a.ts(9,1): error TS2322: y']));
  assert.equal(run().status, 2);
  await writeFile(join(proj, 'fail.js'), FAIL_JS([], 0));
  assert.equal(run().status, 0);
  for (const suffix of ['', '.last', '.shown']) assert.ok(!existsSync(`${log}${suffix}`), suffix || 'log');
});

test('when no output line parses the gate only informs the user and never exits 2', async () => {
  const { run, log } = await gateProject({ output: ['error: cannot find tsconfig.json'] });
  const r = run();
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.match(JSON.parse(r.stdout).systemMessage, /cannot find tsconfig\.json/);
  assert.ok(!existsSync(log));
});

test('real diagnostics in a logged file still block next to unparsable noise', async () => {
  const { run } = await gateProject({ output: ['noise without a location', 'src/a.ts(3,1): error TS2322: x'] });
  const r = run();
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'src/a.ts:3 TS2322 x\n');
});

test('timeoutMessage names at most 10 files, counts the rest and asks for a runner typecheck', () => {
  const files = Array.from({ length: 12 }, (_, i) => `/p/f${i}.ts`);
  const message = timeoutMessage(files);
  assert.ok(message.includes('/p/f0.ts') && message.includes('/p/f9.ts') && !message.includes('/p/f10.ts'));
  assert.match(message, /\+2 more/);
  assert.match(message, /runner/);
  assert.ok(!timeoutMessage(files.slice(0, 2)).includes('more'));
});

test('decideExit on a timeout tells the user which files were not checked and still deletes the log', async () => {
  const { log } = await gateProject();
  const written = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => written.push(String(chunk)) > 0;
  try {
    decideExit({ timedOut: true, lines: [], unparsed: [], unchecked: ['/p/a.ts', '/p/b.ts'] }, log, false);
  } finally {
    process.stdout.write = original;
  }
  const { systemMessage } = JSON.parse(written.join(''));
  assert.ok(systemMessage.includes('/p/a.ts') && systemMessage.includes('/p/b.ts') && systemMessage.includes('runner'));
  assert.ok(!existsSync(log));
});

// Lays out node_modules the way an installer would and returns the roots.
async function tscLayout() {
  const root = makeTempDir('ts-major-');
  const writeTs = async (dir, version) => {
    await mkdir(join(dir, 'typescript'), { recursive: true });
    await writeFile(join(dir, 'typescript', 'package.json'), JSON.stringify({ name: 'typescript', version }));
  };
  await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
  return { root, writeTs, tsc: join(root, 'node_modules', '.bin', 'tsc') };
}

test('typescriptMajor reads the package next to the tsc binary, not the nearest one to the project', async () => {
  const { root, writeTs, tsc } = await tscLayout();
  await writeTs(join(root, 'node_modules'), '5.4.2');
  await writeTs(join(root, 'pkg', 'node_modules'), '7.0.0');
  await writeFile(tsc, '');
  assert.equal(typescriptMajor(tsc), 5);
});

test('typescriptMajor follows a symlinked tsc to its package, and gives null without one', posix, async () => {
  const { root, writeTs, tsc } = await tscLayout();
  await writeTs(join(root, 'store'), '6.1.0');
  await mkdir(join(root, 'store', 'typescript', 'bin'));
  await writeFile(join(root, 'store', 'typescript', 'bin', 'tsc'), '');
  await symlink(join(root, 'store', 'typescript', 'bin', 'tsc'), tsc);
  assert.equal(typescriptMajor(tsc), 6);
  const bare = await tscLayout();
  await writeFile(bare.tsc, '');
  assert.equal(typescriptMajor(bare.tsc), null);
});

// --- Fallbacks for a package without a usable typecheck script, the run log and where the binaries may come from ---

// A fake binary for a fixture's node_modules/.bin (a node script): appends what it was called with to $CALLS, writes the
// build info it is given (as tsc does), prints `output` and exits with `status`.
const fakeBin = (output = [], status = 0) => `#!${process.execPath}
const { appendFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const nx = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('NX_')));
appendFileSync(process.env.CALLS, JSON.stringify({ bin: __filename, args, cwd: process.cwd(), nx }) + '\\n');
const at = args.indexOf('--tsBuildInfoFile');
if (at >= 0) writeFileSync(args[at + 1], 'info');
for (const line of ${JSON.stringify(output)}) console.log(line);
process.exitCode = ${status};
`;

// Puts a fake `tool` in `folder`/node_modules/.bin; a fake tsc also gets the typescript package its version is read from.
async function installBin(folder, tool, { output = [], status = 0, tsVersion = '5.4.2' } = {}) {
  const modules = join(folder, 'node_modules');
  await mkdir(join(modules, '.bin'), { recursive: true });
  await writeFile(join(modules, '.bin', tool), fakeBin(output, status));
  await chmod(join(modules, '.bin', tool), 0o755);
  if (tool !== 'tsc') return;
  await mkdir(join(modules, 'typescript'), { recursive: true });
  await writeFile(join(modules, 'typescript', 'package.json'), JSON.stringify({ name: 'typescript', version: tsVersion }));
}

// A fixture repository at <root>/outer/repo. `files` maps a path in it to its text (an object is written as JSON); it always
// has src/a.ts. `edit(path)` runs the real post-edit.mjs, `stop()` the gate (both for session s1), `runs()` reads the run
// log, `calls()` what the fake binaries were called with. `git: true` makes it a git repository, so it is the git top.
async function fallbackRepo(files, { git = false } = {}) {
  const root = makeTempDir('typecheck-gate-');
  const repo = join(root, 'outer', 'repo');
  for (const [path, content] of Object.entries({ 'src/a.ts': 'export {};\n', ...files })) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), typeof content === 'string' ? content : JSON.stringify(content));
  }
  if (git) assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0);
  const tmp = join(root, 'tmp');
  await mkdir(tmp);
  const runLog = join(root, 'run.jsonl');
  const callLog = join(root, 'calls.jsonl');
  const hookEnv = (env) => ({ ...process.env, CLAUDE_TYPECHECK_AT: '', CLAUDE_POST_EDIT_SKIP: '', CLAUDE_TYPECHECK_LOG: runLog, CALLS: callLog, TMPDIR: tmp, TEMP: tmp, TMP: tmp, ...env });
  const hook = (path, input, env) => spawnSync(process.execPath, [path], { input: JSON.stringify({ session_id: 's1', ...input }), encoding: 'utf8', env: hookEnv(env), timeout: 60_000 });
  return {
    root,
    repo,
    tmp,
    runLog,
    log: join(tmp, 'claude-post-edit', 'edits', 's1--main'),
    edit: (path) => assert.equal(hook(POST_EDIT_HOOK, { tool_input: { file_path: join(repo, path) } }).status, 0, `post-edit ${path}`),
    stop: (input = {}, env = {}) => hook(HOOK, { hook_event_name: 'Stop', ...input }, env),
    runs: () => runLines(runLog),
    calls: () => runLines(callLog),
  };
}

const TS_ERROR = 'src/a.ts(3,1): error TS2322: x';
const outcomes = async (fixture) => (await fixture.runs()).map((line) => line.outcome);

test('a package with a tsconfig.json and no typecheck script: post-edit logs the edit, tsc --noEmit runs and its error about the edited file blocks the stop', posix, async () => {
  const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': {}, 'src/b.ts': 'export {};\n' });
  await installBin(fixture.repo, 'tsc', { output: ['noise', 'src/b.ts(1,1): error TS2322: elsewhere', TS_ERROR], status: 2 });
  fixture.edit('src/a.ts');
  const r = fixture.stop();
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'src/a.ts:3 TS2322 x\n', 'only the line about the logged file reaches the agent');
  const [line, ...rest] = await fixture.runs();
  assert.deepEqual(rest, []);
  assert.match(line.outcome, /^ran: tsc --noEmit -p /);
  assert.ok(line.outcome.includes(join(fixture.repo, 'tsconfig.json')));
  assert.deepEqual({ session: line.session, agent: line.agent, dir: line.dir, exit: line.exit }, { session: 's1', agent: 'main', dir: fixture.repo, exit: 2 });
  assert.equal(typeof line.ms, 'number');
  assert.ok(!Number.isNaN(Date.parse(line.ts)));
  assert.ok(existsSync(fixture.log), 'the edit log stays so the next stop checks again');
});

test('a package with neither a typecheck script nor a tsconfig is skipped with the reason and the stop passes', async () => {
  const fixture = await fallbackRepo({ 'package.json': {} });
  fixture.edit('src/a.ts');
  const r = fixture.stop({ hook_event_name: 'SubagentStop' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, '');
  const [line, ...rest] = await fixture.runs();
  assert.deepEqual(rest, []);
  assert.deepEqual({ outcome: line.outcome, exit: line.exit, dir: line.dir }, { outcome: 'skipped: no tsconfig', exit: null, dir: fixture.repo });
  assert.ok(!existsSync(fixture.log), 'nothing is left to check');
});

test('a tsc planted one level above the git top is not run: skipped: no project tsc', posix, async () => {
  const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': {} }, { git: true });
  await installBin(join(fixture.root, 'outer'), 'tsc', { output: [TS_ERROR], status: 2 });
  fixture.edit('src/a.ts');
  const r = fixture.stop();
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, '');
  assert.deepEqual(await fixture.calls(), [], 'the planted tsc never ran');
  assert.deepEqual(await outcomes(fixture), ['skipped: no project tsc']);
});

test('a tsc hoisted to the git top is found from a package below it', posix, async () => {
  const fixture = await fallbackRepo({ 'packages/app/package.json': {}, 'packages/app/tsconfig.json': {}, 'packages/app/src/a.ts': 'export {};\n' }, { git: true });
  await installBin(fixture.repo, 'tsc', { output: [TS_ERROR], status: 2 });
  fixture.edit('packages/app/src/a.ts');
  assert.equal(fixture.stop().status, 2);
  const [call] = await fixture.calls();
  assert.equal(call.cwd.endsWith(join('repo', 'packages', 'app')), true, 'tsc runs in the package folder');
});

test('a plain tsc typecheck script is not extended with a tsc found above the git top', posix, async () => {
  const fixture = await fallbackRepo({ 'package.json': { scripts: { typecheck: 'tsc --noEmit' } } }, { git: true });
  await installBin(join(fixture.root, 'outer'), 'tsc');
  fixture.edit('src/a.ts');
  fixture.stop();
  const direct = (await fixture.calls()).filter((call) => call.args.includes('--tsBuildInfoFile'));
  assert.deepEqual(direct, [], 'the gate itself never starts a tsc from above the git top');
  assert.deepEqual(await outcomes(fixture), ['ran: npm run typecheck']);
});

test('the nearest tsconfig is the first tsconfig.json from the edited file\'s folder up to its package folder, never one above it', posix, async () => {
  const fixture = await fallbackRepo(
    { 'package.json': {}, 'tsconfig.json': {}, 'src/deep/tsconfig.json': {}, 'src/deep/x.ts': 'export {};\n', 'pkg/package.json': {}, 'pkg/src/y.ts': 'export {};\n' },
    { git: true },
  );
  await installBin(fixture.repo, 'tsc');
  for (const path of ['src/a.ts', 'src/deep/x.ts', 'pkg/src/y.ts']) fixture.edit(path);
  assert.equal(fixture.stop().status, 0);
  const projects = (await fixture.calls()).map((call) => call.args[call.args.indexOf('-p') + 1]);
  assert.deepEqual(projects.sort(), [join(fixture.repo, 'src', 'deep', 'tsconfig.json'), join(fixture.repo, 'tsconfig.json')].sort());
  const lines = await fixture.runs();
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.filter((line) => line.dir === join(fixture.repo, 'pkg')).map((line) => line.outcome), ['skipped: no tsconfig'], 'the tsconfig above the package folder is not used');
});

test('a solution tsconfig (references and no files of its own) is skipped, never reported as run', posix, async () => {
  const solutions = [
    '// the Vite template\n{ "files": [], /* none */ "references": [{ "path": "./tsconfig.app.json" }], }\n',
    '{ "include": [], "references": [{ "path": "./tsconfig.app.json" }] }',
    '{ "files": [], "include": [], "references": [{ "path": "./tsconfig.app.json" }] }',
  ];
  for (const tsconfig of solutions) {
    const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': tsconfig });
    await installBin(fixture.repo, 'tsc', { output: [TS_ERROR], status: 2 });
    fixture.edit('src/a.ts');
    assert.equal(fixture.stop().status, 0, tsconfig);
    assert.deepEqual(await fixture.calls(), [], tsconfig);
    assert.deepEqual(await outcomes(fixture), ['skipped: solution tsconfig'], tsconfig);
  }
});

test('a tsconfig with references that also names files of its own is checked', posix, async () => {
  for (const tsconfig of ['{ "include": ["src"], "references": [{ "path": "./other" }] }', '{ "files": [], "include": ["src"], "references": [{ "path": "./other" }] }', '{ "files": [] }']) {
    const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': tsconfig });
    await installBin(fixture.repo, 'tsc', { output: [TS_ERROR], status: 2 });
    fixture.edit('src/a.ts');
    assert.equal(fixture.stop().status, 2, tsconfig);
  }
});

test('a tsconfig.json that cannot be read as one (not JSON, a folder, a FIFO) is skipped and the hook does not wait on it', posix, async () => {
  const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': 'not json', 'lib/package.json': {}, 'lib/tsconfig.json/keep': '', 'lib/b.ts': 'export {};\n', 'fifo/package.json': {}, 'fifo/c.ts': 'export {};\n', 'list/package.json': {}, 'list/tsconfig.json': '[]', 'list/d.ts': 'export {};\n' });
  assert.equal(spawnSync('mkfifo', [join(fixture.repo, 'fifo', 'tsconfig.json')]).status, 0);
  await installBin(fixture.repo, 'tsc', { output: [TS_ERROR], status: 2 });
  for (const path of ['src/a.ts', 'lib/b.ts', 'fifo/c.ts', 'list/d.ts']) fixture.edit(path);
  const r = fixture.stop();
  assert.equal(r.error, undefined, 'the hook ended by itself');
  assert.equal(r.status, 0);
  assert.deepEqual(await fixture.calls(), []);
  assert.deepEqual(await outcomes(fixture), Array(4).fill('skipped: unreadable tsconfig'));
});

// Every file under `folder`, as sorted relative paths.
const filesUnder = async (folder) => (await readdir(folder, { recursive: true })).sort();

test('the tsconfig run sends the build info to the temp folder and writes nothing in the project', posix, async () => {
  const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': { compilerOptions: { composite: true, tsBuildInfoFile: './own.tsbuildinfo' } } });
  await installBin(fixture.repo, 'tsc');
  fixture.edit('src/a.ts');
  const before = await filesUnder(fixture.repo);
  assert.equal(fixture.stop().status, 0);
  const [{ args }] = await fixture.calls();
  assert.deepEqual(args.slice(0, 5), ['--noEmit', '-p', join(fixture.repo, 'tsconfig.json'), '--incremental', '--tsBuildInfoFile']);
  assert.equal(args.length, 6);
  assert.ok(args[5].startsWith(join(fixture.tmp, 'claude-post-edit', 'tsbuildinfo')), args[5]);
  assert.deepEqual(await filesUnder(fixture.repo), before);
  assert.ok(!existsSync(args[5]), 'no private build info left behind');
});

test('a typescript the gate cannot redirect (an unknown major) is skipped, never run without the redirect', posix, async () => {
  const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': {} });
  await installBin(fixture.repo, 'tsc', { output: [TS_ERROR], status: 2, tsVersion: '7.0.0' });
  fixture.edit('src/a.ts');
  assert.equal(fixture.stop().status, 0);
  assert.deepEqual(await fixture.calls(), []);
  assert.deepEqual(await outcomes(fixture), ['skipped: unsupported typescript version']);
});

test('CLAUDE_POST_EDIT_SKIP writes skipped: skip env for each package, runs nothing and keeps the edit log', posix, async () => {
  const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': {}, 'pkg/package.json': {}, 'pkg/y.ts': 'export {};\n' });
  await installBin(fixture.repo, 'tsc', { output: [TS_ERROR], status: 2 });
  for (const path of ['src/a.ts', 'pkg/y.ts']) fixture.edit(path);
  const r = fixture.stop({}, { CLAUDE_POST_EDIT_SKIP: 'typecheck' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, '');
  assert.deepEqual(await fixture.calls(), []);
  assert.deepEqual((await fixture.runs()).map((line) => [line.dir, line.outcome, line.exit]), [[fixture.repo, 'skipped: skip env', null], [join(fixture.repo, 'pkg'), 'skipped: skip env', null]]);
  assert.ok(existsSync(fixture.log));
});

test('a skipped package does not hide a failing one: the stop blocks and the run log names both', posix, async () => {
  const fixture = await fallbackRepo({ 'package.json': {}, 'pkg/package.json': {}, 'pkg/tsconfig.json': {}, 'pkg/src/a.ts': 'export {};\n' });
  await installBin(join(fixture.repo, 'pkg'), 'tsc', { output: [TS_ERROR], status: 2 });
  for (const path of ['src/a.ts', 'pkg/src/a.ts']) fixture.edit(path);
  const r = fixture.stop();
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'src/a.ts:3 TS2322 x\n');
  assert.deepEqual((await fixture.runs()).map((line) => [line.dir, line.outcome.split(' -p ')[0], line.exit]), [[fixture.repo, 'skipped: no tsconfig', null], [join(fixture.repo, 'pkg'), 'ran: tsc --noEmit', 2]]);
});

test('a tsc that cannot be started is exit "error" in the run log and a message to the user, never a block', posix, async () => {
  const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': {} });
  await installBin(fixture.repo, 'tsc');
  await chmod(join(fixture.repo, 'node_modules', '.bin', 'tsc'), 0o644);
  fixture.edit('src/a.ts');
  const r = fixture.stop();
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).systemMessage, /could not run typecheck/);
  assert.deepEqual((await fixture.runs()).map((line) => line.exit), ['error']);
});

test('a check that outlives the budget is killed and logged as a timeout; the check after it is not started', posix, async () => {
  const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': {}, 'src/deep/tsconfig.json': {}, 'src/deep/x.ts': 'export {};\n' });
  await installBin(fixture.repo, 'tsc');
  await writeFile(join(fixture.repo, 'node_modules', '.bin', 'tsc'), `#!${process.execPath}\nsetTimeout(() => {}, 600000);\n`);
  const files = [join(fixture.repo, 'src', 'a.ts'), join(fixture.repo, 'src', 'deep', 'x.ts')];
  const recorded = [];
  const result = await runGate(files, Date.now() + 500, (entry) => recorded.push(entry));
  assert.deepEqual(result, { timedOut: true, lines: [], unparsed: [], unchecked: files });
  assert.deepEqual(recorded.map((entry) => [entry.outcome.split(' ')[0], entry.exit]), [['ran:', 'timeout'], ['skipped:', null]]);
  assert.equal(recorded[1].outcome, 'skipped: budget spent');
  assert.deepEqual(await readdir(join(tmpdir(), 'claude-post-edit', 'tsbuildinfo')).catch(() => []), [], 'the private build info of the killed run is removed');
});

test('runGate with the budget gone records skipped: budget spent for every package', async () => {
  const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': {}, 'pkg/package.json': {}, 'pkg/y.ts': 'export {};\n' });
  const files = [join(fixture.repo, 'src', 'a.ts'), join(fixture.repo, 'pkg', 'y.ts')];
  const recorded = [];
  const result = await runGate(files, Date.now() - 1, (entry) => recorded.push(entry));
  assert.deepEqual(result, { timedOut: true, lines: [], unparsed: [], unchecked: files });
  assert.deepEqual(recorded.map((entry) => [entry.dir, entry.outcome, entry.exit]), [[fixture.repo, 'skipped: budget spent', null], [join(fixture.repo, 'pkg'), 'skipped: budget spent', null]]);
});

test('the run log takes no line once it holds MAX_RUN_LOG_BYTES', posix, async () => {
  const { MAX_RUN_LOG_BYTES } = await import(pathToFileURL(HOOK).href);
  assert.equal(Number.isInteger(MAX_RUN_LOG_BYTES) && MAX_RUN_LOG_BYTES > 0, true);
  const fixture = await fallbackRepo({ 'package.json': {} });
  const oneLineShort = `${'x'.repeat(MAX_RUN_LOG_BYTES - 10)}\n`;
  await writeFile(fixture.runLog, oneLineShort);
  fixture.edit('src/a.ts');
  assert.equal(fixture.stop().status, 0);
  assert.equal(statSync(fixture.runLog).size, oneLineShort.length, 'a line that would pass the cap is not written');
});

test('a link at the run-log path is never written and changes no decision', posix, async () => {
  const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': {} });
  await installBin(fixture.repo, 'tsc', { output: [TS_ERROR], status: 2 });
  const target = join(fixture.root, 'elsewhere');
  await writeFile(target, '');
  await symlink(target, fixture.runLog);
  fixture.edit('src/a.ts');
  assert.equal(fixture.stop().status, 2);
  assert.equal(await readFile(target, 'utf8'), '');
});

test('on win32 a tsconfig command is skipped when a path cannot go through the unquoted shell', async () => {
  const { tsconfigTypecheck } = await import(PLAN_LIB);
  const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': {} });
  await installBin(fixture.repo, 'tsc');
  const tsc = join(fixture.repo, 'node_modules', '.bin', 'tsc');
  const tsconfig = join(fixture.repo, 'tsconfig.json');
  assert.deepEqual(tsconfigTypecheck(tsconfig, tsc, '/t/info', 'linux'), { cmd: tsc, args: ['--noEmit', '-p', tsconfig, '--incremental', '--tsBuildInfoFile', '/t/info'] });
  assert.deepEqual(tsconfigTypecheck(tsconfig, tsc, '/t/info', 'win32'), { cmd: tsc, args: ['--noEmit', '-p', tsconfig, '--incremental', '--tsBuildInfoFile', '/t/info'] });
  assert.deepEqual(tsconfigTypecheck(tsconfig, tsc, 'C:\\Users\\Jo Doe\\info', 'win32'), { skipped: 'unsafe path on Windows' });
  assert.deepEqual(tsconfigTypecheck(tsconfig, tsc, '/t/100%/info', 'win32'), { skipped: 'unsafe path on Windows' });
});

// --- The Nx typecheck target ---

const NX_BROAD = { scripts: { typecheck: 'nx run-many -t typecheck' } };
const NX_ERROR = 'libs/a/src/x.ts(2,1): error TS2322: bad';

// An Nx workspace (nx.json and a fake nx at the git top) with one package, libs/a, whose typecheck script is broad.
async function nxRepo(packageFiles, { nxOutput = [NX_ERROR], nxStatus = 1 } = {}) {
  const inPackage = Object.fromEntries(Object.entries({ 'package.json': NX_BROAD, 'src/x.ts': 'export {};\n', ...packageFiles }).map(([path, content]) => [`libs/a/${path}`, content]));
  const fixture = await fallbackRepo({ 'nx.json': {}, 'package.json': {}, ...inPackage }, { git: true });
  await installBin(fixture.repo, 'nx', { output: nxOutput, status: nxStatus });
  fixture.edit('libs/a/src/x.ts');
  return fixture;
}

test('an Nx project with a typecheck target: nx runs that one project with the daemon, the cloud and the terminal UI off', posix, async () => {
  const fixture = await nxRepo({ 'project.json': { name: 'a', targets: { typecheck: {} } } });
  const r = fixture.stop();
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'libs/a/src/x.ts:2 TS2322 bad\n');
  const [call, ...rest] = await fixture.calls();
  assert.deepEqual(rest, []);
  assert.deepEqual(call.args, ['run', 'a:typecheck', '--skip-nx-cache']);
  assert.equal(call.bin.endsWith(join('repo', 'node_modules', '.bin', 'nx')), true);
  assert.equal(call.cwd.endsWith(join('outer', 'repo')), true, 'nx runs at the git top');
  for (const [name, value] of [['NX_DAEMON', 'false'], ['NX_NO_CLOUD', 'true'], ['NX_TUI', 'false']]) assert.equal(call.nx[name], value, name);
  assert.deepEqual(await outcomes(fixture), ['ran: nx run a:typecheck --skip-nx-cache']);
});

test('the Nx target is also read from package.json (nx.targets.typecheck), named by the package', posix, async () => {
  const fixture = await nxRepo({ 'package.json': { ...NX_BROAD, name: '@org/a', nx: { targets: { typecheck: {} } } } });
  assert.equal(fixture.stop().status, 2);
  assert.deepEqual((await fixture.calls()).map((call) => call.args), [['run', '@org/a:typecheck', '--skip-nx-cache']]);
});

test('order per package: a usable typecheck script, then the Nx target, then the nearest tsconfig, then skipped', posix, async () => {
  const target = { name: 'a', targets: { typecheck: {} } };
  const script = await nxRepo({ 'package.json': { scripts: { typecheck: 'node -e 0' } }, 'project.json': target, 'tsconfig.json': {} });
  await installBin(script.repo, 'tsc');
  assert.equal(script.stop().status, 0);
  assert.deepEqual([await script.calls(), await outcomes(script)], [[], ['ran: npm run typecheck']], 'the script wins');

  const nx = await nxRepo({ 'project.json': target, 'tsconfig.json': {} });
  await installBin(nx.repo, 'tsc');
  nx.stop();
  assert.deepEqual((await nx.calls()).map((call) => call.args[0]), ['run'], 'the Nx target wins over the tsconfig');

  const tsconfig = await nxRepo({ 'tsconfig.json': {} });
  await installBin(tsconfig.repo, 'tsc');
  tsconfig.stop();
  assert.deepEqual((await tsconfig.calls()).map((call) => call.args[0]), ['--noEmit'], 'a broad script with no Nx target goes on to the tsconfig');

  const nothing = await nxRepo({});
  assert.equal(nothing.stop().status, 0);
  assert.deepEqual([await nothing.calls(), await outcomes(nothing)], [[], ['skipped: broad script, no nx target']]);
});

test('no Nx run without nx.json at the git top, a typecheck target in the package folder, a plain project name and the top\'s own nx', posix, async () => {
  const shapes = [
    { 'project.json': { name: 'a', targets: { build: {} } } },
    { 'project.json': { name: 'a', targets: { typecheck: 'tsc' } } },
    { 'project.json': { targets: { typecheck: {} } }, 'package.json': { ...NX_BROAD, name: 7 } },
    ...['-x', 'a b', 'a;b', 'a:b', '$(x)', ''].map((name) => ({ 'project.json': { name, targets: { typecheck: {} } } })),
  ];
  for (const shape of shapes) {
    const fixture = await nxRepo(shape);
    assert.equal(fixture.stop().status, 0, JSON.stringify(shape));
    assert.deepEqual([await fixture.calls(), await outcomes(fixture)], [[], ['skipped: broad script, no nx target']], JSON.stringify(shape));
  }
  const noWorkspace = await fallbackRepo({ 'libs/a/package.json': NX_BROAD, 'libs/a/project.json': { name: 'a', targets: { typecheck: {} } }, 'libs/a/src/x.ts': 'export {};\n' }, { git: true });
  await installBin(noWorkspace.repo, 'nx', { output: [NX_ERROR], status: 1 });
  noWorkspace.edit('libs/a/src/x.ts');
  assert.equal(noWorkspace.stop().status, 0);
  assert.deepEqual(await noWorkspace.calls(), [], 'no nx.json at the git top');
  const nxBelowTop = await fallbackRepo({ 'nx.json': {}, 'libs/a/package.json': NX_BROAD, 'libs/a/project.json': { name: 'a', targets: { typecheck: {} } }, 'libs/a/src/x.ts': 'export {};\n' }, { git: true });
  await installBin(join(nxBelowTop.repo, 'libs', 'a'), 'nx', { output: [NX_ERROR], status: 1 });
  await installBin(join(nxBelowTop.root, 'outer'), 'nx', { output: [NX_ERROR], status: 1 });
  nxBelowTop.edit('libs/a/src/x.ts');
  assert.equal(nxBelowTop.stop().status, 0);
  assert.deepEqual(await nxBelowTop.calls(), [], 'only the nx of the git top runs');
});

test('on win32 an nx whose path cannot go through the unquoted shell is skipped', async () => {
  const { nxTypecheck } = await import(PLAN_LIB);
  const workspace = { 'nx.json': {}, 'package.json': {}, 'project.json': { name: 'a', targets: { typecheck: {} } } };
  const plain = await fallbackRepo(workspace);
  await installBin(plain.repo, 'nx');
  assert.deepEqual(nxTypecheck(plain.repo, [plain.repo], 'linux').args, ['run', 'a:typecheck', '--skip-nx-cache']);
  const spaced = await fallbackRepo(Object.fromEntries(Object.entries(workspace).map(([path, content]) => [`my app/${path}`, content])));
  const folder = join(spaced.repo, 'my app');
  await mkdir(join(folder, 'node_modules', '.bin'), { recursive: true });
  await writeFile(join(folder, 'node_modules', '.bin', 'nx.cmd'), '');
  assert.deepEqual(nxTypecheck(folder, [folder], 'win32'), { skipped: 'unsafe path on Windows' });
});
