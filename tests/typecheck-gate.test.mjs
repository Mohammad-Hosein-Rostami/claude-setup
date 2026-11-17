// Tests for home/hooks/typecheck-gate.mjs: incremental tsc planning, the Stop/SubagentStop contract (exit codes, loop
// guard, log clean-up), the shared tsbuildinfo hand-off and the budget. Runs the real hook against fake projects.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideExit, incrementalTypecheck, runGate, timeoutMessage, typescriptMajor } from '../home/hooks/typecheck-gate.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/typecheck-gate.mjs', import.meta.url));
const POST_EDIT_HOOK = fileURLToPath(new URL('../home/hooks/post-edit.mjs', import.meta.url));
const posix = { skip: process.platform === 'win32' };
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
  const root = await mkdtemp(join(tmpdir(), 'typecheck-gate-'));
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
  const gateEnv = (env = {}) => ({ ...process.env, CLAUDE_TYPECHECK_AT: '', CLAUDE_POST_EDIT_SKIP: '', TMPDIR: tmp, TEMP: tmp, TMP: tmp, ...env });
  const run = (input = {}, env = {}) =>
    spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: 's1', hook_event_name: 'Stop', ...input }), encoding: 'utf8', env: gateEnv(env) });
  // The PostToolUse hook that logs an edited file for the gate.
  const editFile = (file) =>
    spawnSync(process.execPath, [POST_EDIT_HOOK], { input: JSON.stringify({ session_id: 's1', tool_input: { file_path: join(proj, file) } }), encoding: 'utf8', env: gateEnv() });
  return { proj, tmp, log, run, editFile };
}

test('hook contract: bad JSON, empty stdin and no log exit 0 silently', () => {
  for (const input of ['not json', '', JSON.stringify({}), JSON.stringify({ session_id: 'nothing-logged' })]) {
    const r = spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout + r.stderr, '');
  }
});

test('no log for this session is a silent pass', async () => {
  const { run } = await gateProject({ logged: [] });
  const r = run();
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, '');
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
  const root = await mkdtemp(join(tmpdir(), 'ts-major-'));
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
