// Tests for home/hooks/typecheck-gate.mjs: incremental tsc planning, the Stop/SubagentStop contract (exit codes, loop
// guard, log clean-up), the shared tsbuildinfo hand-off and the budget. Runs the real hook against fake projects.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { incrementalTypecheck, runGate } from '../home/hooks/typecheck-gate.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/typecheck-gate.mjs', import.meta.url));
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
  for (const script of ['tsc -b', 'tsc --build', 'vue-tsc --noEmit', 'tsc && x', 'tsc | cat', 'tsc; x', 'tsc > out', 'tsc $X', 'tsc `x`', 'tsc -w', 'tsc --watch', 'tsc --incremental', 'tsc --tsBuildInfoFile x', 'tsc --tsBuildInfoFile=x', 'pnpm exec tsc', 'node fail.js', '']) {
    assert.equal(incrementalTypecheck(script, 5, TSC, INFO), null, script);
  }
  for (const major of [3, 7, 8, Number.NaN]) assert.equal(incrementalTypecheck('tsc --noEmit', major, TSC, INFO), null, String(major));
});

const FAIL_JS = (lines, status = 1) => `${lines.map((l) => `console.log(${JSON.stringify(l)});`).join('\n')}\nprocess.exitCode = ${status};\n`;

// A fake project with logged edits. `tmp` is the redirected temp dir; `run(input, env)` runs the hook for session s1.
async function gateProject({ output = ['src/a.ts(3,1): error TS2322: x'], status = 1, logged = ['src/a.ts'], script = 'node fail.js' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'typecheck-gate-'));
  const proj = join(root, 'proj');
  await mkdir(join(proj, 'src'), { recursive: true });
  await writeFile(join(proj, 'package.json'), JSON.stringify({ scripts: { typecheck: script } }));
  await writeFile(join(proj, 'fail.js'), FAIL_JS(output, status));
  for (const name of ['a.ts', 'b.ts']) await writeFile(join(proj, 'src', name), 'export {};\n');
  const tmp = join(root, 'tmp');
  const edits = join(tmp, 'claude-post-edit', 'edits');
  await mkdir(edits, { recursive: true });
  const log = join(edits, 's1--main');
  if (logged.length) await writeFile(log, logged.map((f) => `${join(proj, f)}\n`).join(''));
  const run = (input = {}, env = {}) =>
    spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ session_id: 's1', hook_event_name: 'Stop', ...input }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_TYPECHECK_AT: '', CLAUDE_POST_EDIT_SKIP: '', TMPDIR: tmp, TEMP: tmp, TMP: tmp, ...env },
    });
  return { proj, tmp, log, run };
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
  assert.deepEqual(await runGate([join(proj, 'src', 'a.ts')], Date.now() - 1), { timedOut: true, lines: [] });
});

test('runGate with nothing to check passes', async () => {
  assert.deepEqual(await runGate([join(tmpdir(), 'nonexistent-file.ts')], Date.now() + 1000), { timedOut: false, lines: [] });
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
  await writeFile(join(proj, 'node_modules', 'typescript', 'package.json'), JSON.stringify({ version: '5.4.2' }));
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
