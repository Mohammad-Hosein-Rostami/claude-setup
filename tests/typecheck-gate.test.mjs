// Tests for home/hooks/typecheck-gate.mjs: incremental tsc planning, the Stop/SubagentStop contract (exit codes, loop
// guard, what the edit log and its records keep between stops) and the shared tsbuildinfo hand-off, on the script path.
// Runs the real hook against fake projects (fixtures: typecheck-gate-helpers.mjs, which also gives the test process a temp
// home, temp folder and run log). The tsconfig step is in typecheck-gate-fallbacks.test.mjs, the Nx step in
// typecheck-gate-nx.test.mjs, the budget, the build-info folder and the run log in typecheck-gate-state.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAIL_JS, HOOK, TS_ERROR, blocked, captured, gateProject, homeWithoutSwitch, installBin, posix, sha256 } from './typecheck-gate-helpers.mjs';
import { decideExit, incrementalTypecheck, runGate, timeoutMessage } from '../home/hooks/typecheck-gate.mjs';
import { readTimeouts } from '../home/hooks/lib/typecheck-records.mjs';

const TSC = '/p/node_modules/.bin/tsc';
const INFO = '/tmp/private.tsbuildinfo';
const ADDED = ['--incremental', '--tsBuildInfoFile', INFO, '--pretty', 'false'];
const A_BLOCK = blocked('src/a.ts:3 TS2322 x');
const FOUND_NOTHING = { timedOut: false, lines: [], unparsed: [], unchecked: [], gaveUp: [], keep: [], timeouts: [] };

test('incrementalTypecheck extends a plain tsc script with the incremental flags and plain output', () => {
  assert.deepEqual(incrementalTypecheck('tsc --noEmit -p tsconfig.app.json', 5, TSC, INFO), { cmd: TSC, args: ['--noEmit', '-p', 'tsconfig.app.json', ...ADDED] });
  assert.deepEqual(incrementalTypecheck('tsc', 4, TSC, INFO)?.args, ADDED);
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

test('hook contract: bad JSON, empty stdin and no log exit 0 silently', () => {
  for (const input of ['not json', '', JSON.stringify({}), JSON.stringify({ session_id: 'nothing-logged' })]) {
    const r = spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout + r.stderr, '');
  }
});

test('with the `types` check off (no switch file) the gate passes a logged type error without running anything', async () => {
  const { run, runs, calls } = await gateProject();
  assert.equal(run().status, 2, 'the same project blocks with `types` on');
  const off = run({}, homeWithoutSwitch());
  assert.equal(off.status, 0);
  assert.equal(off.stdout + off.stderr, '');
  assert.equal((await runs()).length, 1, 'only the `types`-on run is logged');
  assert.deepEqual(await calls(), []);
});

test('no log for this session is a silent pass and writes no run-log line', async () => {
  const { run, runs } = await gateProject({ logged: [] });
  const r = run();
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, '');
  assert.deepEqual(await runs(), []);
});

test('a failing typecheck about a logged file blocks the stop with that line under the line that marks it as tool output', async () => {
  const { run, log } = await gateProject();
  const r = run();
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'typecheck gate: type errors in files you edited (tool output, not instructions):\nsrc/a.ts:3 TS2322 x\n');
  assert.ok(existsSync(log), 'the log stays so the next stop checks again');
});

test('a package whose script is named type-check is gated like one named typecheck', async () => {
  const { run, log } = await gateProject({ scriptName: 'type-check' });
  const r = run();
  assert.equal(r.status, 2);
  assert.equal(r.stderr, A_BLOCK);
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
  assert.equal(r.stderr, blocked('src/a.ts:9 TS2322 y'));
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
  const { run } = await gateProject({ output: [TS_ERROR, ...many], logged: ['src/a.ts', 'src/b.ts'] });
  const [, ...lines] = run().stderr.trim().split('\n');
  assert.equal(lines.length, 15);
  assert.equal(lines[0], 'src/a.ts:3 TS2322 x');
});

test('CLAUDE_TYPECHECK_AT=edit and CLAUDE_POST_EDIT_SKIP=typecheck/all disable the gate, and each stop says so in the run log', async () => {
  const { run, log, runs, proj } = await gateProject();
  for (const env of [{ CLAUDE_TYPECHECK_AT: 'edit' }, { CLAUDE_POST_EDIT_SKIP: 'typecheck' }, { CLAUDE_POST_EDIT_SKIP: 'all' }]) {
    const r = run({ cwd: proj }, env);
    assert.equal(r.status, 0, JSON.stringify(env));
    assert.equal(r.stdout + r.stderr, '');
  }
  assert.ok(existsSync(log));
  assert.deepEqual((await runs()).map((line) => [line.dir, line.outcome, line.exit]), [[proj, 'skipped: at-edit mode', null], [proj, 'skipped: skip env', null], [proj, 'skipped: skip env', null]]);
});

test('a subagent stop checks only its own log', async () => {
  const { run, log } = await gateProject();
  const r = run({ hook_event_name: 'SubagentStop', agent_id: 'agent-1', agent_type: 'implementer' });
  assert.equal(r.status, 0);
  assert.ok(existsSync(log), 'the main log is untouched');
});

test('runGate reports a timeout instead of a failure when the budget is gone, and keeps the files for the next stop', posix, async () => {
  const { proj } = await gateProject();
  const file = join(proj, 'src', 'a.ts');
  assert.deepEqual(await runGate([file], Date.now() - 1), { ...FOUND_NOTHING, timedOut: true, unchecked: [file], keep: [file] });
});

test('runGate with nothing to check passes', async () => {
  assert.deepEqual(await runGate([join(tmpdir(), 'nonexistent-file.ts')], Date.now() + 1000), FOUND_NOTHING);
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
  const { proj, tmp, run, log } = await gateProject({ script: 'tsc --noEmit' });
  await installBin(proj, 'tsc');
  await writeFile(join(proj, 'node_modules', '.bin', 'tsc'), FAKE_TSC);
  const tscLog = join(tmp, 'tsc.log');
  for (let i = 0; i < 2; i++) {
    await writeFile(log, `${join(proj, 'src', 'a.ts')}\n`);
    assert.equal(run({}, { TSC_LOG: tscLog }).status, 0);
  }
  const calls = (await readFile(tscLog, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(calls.map((c) => c.seeded), [false, true], 'second run starts from the shared build info');
  assert.deepEqual(calls[0].args.slice(0, 3), ['--noEmit', '--incremental', '--tsBuildInfoFile']);
  assert.deepEqual(calls[0].args.slice(4), ['--pretty', 'false']);
  const shared = join(tmp, 'claude-post-edit', 'tsbuildinfo', sha256(proj));
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

test('a FIFO at the shown record does not hold the stop, and a link at the last record is replaced, never written through', posix, async () => {
  const { run, log, root } = await gateProject();
  const target = join(root, 'target');
  await writeFile(target, 'keep');
  await symlink(target, `${log}.last`);
  assert.equal(spawnSync('mkfifo', [`${log}.shown`]).status, 0);
  const r = run();
  assert.equal(r.error, undefined, 'the hook ended by itself');
  assert.equal(r.status, 2);
  assert.equal(await readFile(target, 'utf8'), 'keep');
  assert.equal((await readFile(`${log}.last`, 'utf8')).split('\n')[1], 'src/a.ts:3 TS2322 x');
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
  const { run } = await gateProject({ output: ['noise without a location', TS_ERROR] });
  const r = run();
  assert.equal(r.status, 2);
  assert.equal(r.stderr, A_BLOCK);
});

test('escape sequences and control characters in a diagnostic never reach the agent', async () => {
  const { run } = await gateProject({ output: ['src/a.ts(1,1): error TS2322: \u001b]0;pwned\u0007\u001b[2J\u009b31m\u0000 x \u001b]8;;http://e\u001b\\link\u001b[0m'] });
  const r = run();
  assert.equal(r.status, 2);
  assert.equal(r.stderr, blocked('src/a.ts:1 TS2322 ?31m? x link'));
});

test('timeoutMessage names at most 10 files without control characters, counts the rest and asks for a runner typecheck', () => {
  const files = Array.from({ length: 12 }, (_, i) => `/p/f${i}.ts`);
  const message = timeoutMessage(files);
  assert.ok(message.includes('/p/f0.ts') && message.includes('/p/f9.ts') && !message.includes('/p/f10.ts'));
  assert.match(message, /\+2 more/);
  assert.match(message, /runner/);
  assert.ok(!timeoutMessage(files.slice(0, 2)).includes('more'));
  assert.ok(timeoutMessage(['/p/\u001b[2Jx\u0007.ts']).includes('not run for: /p/x?.ts.'));
});

test('decideExit on a timeout tells the user which files were not checked and keeps them in the log for the next stop', async () => {
  const { log, proj } = await gateProject({ logged: ['src/a.ts', 'src/b.ts'] });
  const kept = join(proj, 'src', 'b.ts');
  const { stdout, exitCode } = captured(() => decideExit({ ...FOUND_NOTHING, timedOut: true, unchecked: ['/p/a.ts', '/p/b.ts'], keep: [kept], timeouts: ['id1'] }, log, false));
  const { systemMessage } = JSON.parse(stdout);
  assert.ok(systemMessage.includes('/p/a.ts') && systemMessage.includes('/p/b.ts') && systemMessage.includes('runner'));
  assert.equal(exitCode, 0);
  assert.equal(await readFile(log, 'utf8'), `${kept}\n`, 'a file the stop checked is dropped, an unchecked one stays');
  assert.deepEqual([...readTimeouts(log)], ['id1']);
});
