// Tests for home/hooks/disk-clean-start.mjs: the clean-up starts at most once per 24 h, only for a startup of the main session,
// the stamp is written before the start, and the hook exits at once while the clean-up is still running.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startIfDue } from '../home/hooks/disk-clean-start.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/disk-clean-start.mjs', import.meta.url));
const HOUR_MS = 60 * 60 * 1000;
const SESSION = '11111111-2222-4333-8444-555555555555';

function setup() {
  const home = makeTempDir('dcs-home-');
  const started = [];
  const deps = { stampPath: join(home, 'state', 'disk-clean.stamp'), logPath: join(home, 'logs', 'disk-clean.log'), tool: '/the/tool.mjs', nowMs: Date.now(), start: (args) => started.push(args) };
  return { home, started, deps };
}
const startup = { hook_event_name: 'SessionStart', source: 'startup', session_id: SESSION };

test('with no stamp it starts disk-clean --apply for this session and writes the stamp first', () => {
  const { started, deps } = setup();
  assert.equal(startIfDue(startup, { ...deps, start: (args) => { assert.ok(existsSync(deps.stampPath), 'the stamp exists before the start'); started.push(args); } }), 'started');
  assert.deepEqual(started, [['/the/tool.mjs', '--apply', '--session', SESSION]]);
});

test('a stamp younger than 24 h means not due; one older than 24 h starts it again', () => {
  const { started, deps } = setup();
  startIfDue(startup, deps);
  assert.equal(startIfDue(startup, deps), 'not-due');
  const old = new Date(deps.nowMs - 25 * HOUR_MS);
  utimesSync(deps.stampPath, old, old);
  assert.equal(startIfDue(startup, deps), 'started');
  assert.equal(started.length, 2);
});

test('resume, compact, a subagent and garbage input start nothing', () => {
  const { started, deps } = setup();
  for (const input of [{ ...startup, source: 'resume' }, { ...startup, source: 'compact' }, { ...startup, agent_id: 'a1' }, null, 'text', {}]) assert.equal(startIfDue(input, deps), 'skipped');
  assert.deepEqual(started, []);
  assert.equal(existsSync(deps.stampPath), false, 'a skipped call does not use up the 24 h');
});

test('an unsafe session id is not passed on', () => {
  const { started, deps } = setup();
  startIfDue({ ...startup, session_id: '../../etc; rm' }, deps);
  assert.deepEqual(started, [['/the/tool.mjs', '--apply']]);
});

test('the hook process exits at once while the clean-up it started is still running, and the clean-up finishes later', async () => {
  const home = makeTempDir('dcs-run-');
  const marker = join(home, 'cleaned');
  const slowTool = join(home, 'slow-tool.mjs');
  writeFileSync(slowTool, `import { writeFileSync } from 'node:fs';\nawait new Promise((resolve) => setTimeout(resolve, 1500));\nwriteFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' '));\n`);
  const startedAt = Date.now();
  const hook = spawn(process.execPath, [HOOK], { env: { ...process.env, HOME: home, USERPROFILE: home, DISK_CLEAN_TOOL: slowTool }, stdio: ['pipe', 'ignore', 'pipe'] });
  hook.stdin.end(JSON.stringify(startup));
  const code = await new Promise((resolve) => hook.on('close', resolve));
  assert.equal(code, 0);
  assert.ok(Date.now() - startedAt < 1400, 'the hook did not wait for the clean-up');
  assert.equal(existsSync(marker), false, 'the clean-up is still running when the hook has exited');
  const deadline = Date.now() + 10_000;
  while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(readFileSync(marker, 'utf8'), `--apply --session ${SESSION}`);
});

test('a state folder that cannot be made does not fail the hook: exit 0 and a line on stderr', async () => {
  const home = makeTempDir('dcs-bad-');
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'state'), 'a file where the folder should be');
  const hook = spawn(process.execPath, [HOOK], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  hook.stderr.on('data', (chunk) => { stderr += chunk; });
  hook.stdin.end(JSON.stringify(startup));
  assert.equal(await new Promise((resolve) => hook.on('close', resolve)), 0);
  assert.match(stderr, /disk-clean-start:/);
});
