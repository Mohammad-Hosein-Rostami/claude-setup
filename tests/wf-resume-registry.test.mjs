// Tests for the workflow registry (home/tools/wf-resume/lib/registry.mjs) and its PostToolUse hook (home/hooks/workflow-register.mjs):
// every Workflow launch of a session is written to a small private file, so a later session can list the runs that did not finish.
// Hermetic: a temp HOME and a temp registry folder; no real session is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRun, latestOtherSession, launchRecord, MAX_ARGS_BYTES, MAX_RUNS_PER_SESSION, runsOfSession, saveRun } from '../home/tools/wf-resume/lib/registry.mjs';
import { launchInput, launchResponse, world } from './wf-resume-helpers.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/workflow-register.mjs', import.meta.url));
const NOW_ISO = '2026-11-17T12:00:00.000Z';

test('a launch becomes a record with the fields a resume needs, and the args only as a digest plus the stored args', () => {
  const record = launchRecord(launchInput({ args: { row: '7', branch: 'lane/x' } }), NOW_ISO);
  assert.equal(record.sessionId, 'sess-1');
  assert.equal(record.runId, 'wf_aaa');
  assert.equal(record.name, 'land');
  assert.equal(record.scriptPath, '/s/land-wf_aaa.js');
  assert.equal(record.cwd, '/work/proj');
  assert.equal(record.row, '7');
  assert.equal(record.started, NOW_ISO);
  assert.equal(record.projectDir, '-Users-me-proj');
  assert.match(record.argsDigest, /^[0-9a-f]{12}$/);
  assert.deepEqual(record.args, { row: '7', branch: 'lane/x' });
});

test('the text form of the tool result (Run ID / Script file lines) is read too', () => {
  const text = 'Workflow launched in background. Task ID: w1\nScript file: /s/step-wf_bbb.js\nRun ID: wf_bbb\nYou will be notified';
  const record = launchRecord(launchInput({ response: text, toolInput: { script: 'export const meta = {}' } }), NOW_ISO);
  assert.equal(record.runId, 'wf_bbb');
  assert.equal(record.scriptPath, '/s/step-wf_bbb.js');
});

test('not a launch: another tool, a refused launch, a bad session id or a bad run id give no record', () => {
  assert.equal(launchRecord({ ...launchInput(), tool_name: 'Bash' }, NOW_ISO), null);
  assert.equal(launchRecord(launchInput({ response: 'The journal for workflow run wf_x is not on disk: nothing to resume.' }), NOW_ISO), null);
  assert.equal(launchRecord(launchInput({ session: '../x' }), NOW_ISO), null);
  assert.equal(launchRecord(launchInput({ response: launchResponse('wf/../x', '/s/a.js') }), NOW_ISO), null);
  assert.equal(launchRecord(launchInput({ response: launchResponse('wf_a', 'relative.js'), toolInput: {} }), NOW_ISO), null, 'a script path that is not absolute');
  assert.equal(launchRecord(null, NOW_ISO), null);
});

test('args over the size limit keep only the digest; an unsafe row label is dropped', () => {
  const big = launchRecord(launchInput({ args: { prompt: 'x'.repeat(MAX_ARGS_BYTES + 1), row: 'a b;rm' } }), NOW_ISO);
  assert.equal(big.args, undefined);
  assert.match(big.argsDigest, /^[0-9a-f]{12}$/);
  assert.equal(big.row, null);
});

test('saving a record writes a private file; the same run saved again (a resume) keeps one record and its first start time', async () => {
  const { registryDir } = await world();
  assert.equal(saveRun(registryDir, launchRecord(launchInput({ args: { a: 1 } }), '2026-11-17T10:00:00.000Z')), true);
  assert.equal(saveRun(registryDir, launchRecord(launchInput({ args: { a: 1 } }), NOW_ISO)), true);
  const runs = runsOfSession(registryDir, 'sess-1');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].started, '2026-11-17T10:00:00.000Z');
  assert.equal(runs[0].lastLaunch, NOW_ISO);
  assert.equal(statSync(join(registryDir, 'sess-1.json')).mode & 0o777, 0o600);
  assert.equal(statSync(registryDir).mode & 0o777, 0o700);
});

test('a session keeps only its newest MAX_RUNS_PER_SESSION runs', async () => {
  const { registryDir } = await world();
  for (let at = 0; at < MAX_RUNS_PER_SESSION + 5; at += 1) {
    saveRun(registryDir, launchRecord(launchInput({ runId: `wf_${at}`, response: launchResponse(`wf_${at}`, `/s/a-${at}.js`) }), `2026-11-17T10:${String(at).padStart(2, '0')}:00.000Z`));
  }
  const runs = runsOfSession(registryDir, 'sess-1');
  assert.equal(runs.length, MAX_RUNS_PER_SESSION);
  assert.equal(runs.at(-1).runId, `wf_${MAX_RUNS_PER_SESSION + 4}`);
  assert.equal(runs[0].runId, 'wf_5');
});

test('lines that are not valid records (a planted or damaged file) are ignored', async () => {
  const { registryDir } = await world();
  saveRun(registryDir, launchRecord(launchInput(), NOW_ISO));
  const file = join(registryDir, 'sess-1.json');
  const good = readFileSync(file, 'utf8');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(file, `not json\n{"runId":"../../etc","sessionId":"sess-1"}\n${good}`);
  assert.deepEqual(runsOfSession(registryDir, 'sess-1').map((run) => run.runId), ['wf_aaa']);
});

test('latestOtherSession: the newest other session of the same cwd, never the current one or another cwd', async () => {
  const { registryDir } = await world();
  saveRun(registryDir, launchRecord(launchInput({ session: 'old-1', runId: 'wf_1', response: launchResponse('wf_1', '/s/a.js') }), '2026-11-16T10:00:00.000Z'));
  saveRun(registryDir, launchRecord(launchInput({ session: 'old-2', runId: 'wf_2', response: launchResponse('wf_2', '/s/b.js') }), '2026-11-17T09:00:00.000Z'));
  saveRun(registryDir, launchRecord(launchInput({ session: 'other-cwd', cwd: '/work/else', response: launchResponse('wf_3', '/s/c.js') }), '2026-11-17T11:00:00.000Z'));
  saveRun(registryDir, launchRecord(launchInput({ session: 'now', response: launchResponse('wf_4', '/s/d.js') }), '2026-11-17T11:30:00.000Z'));
  const found = latestOtherSession(registryDir, { cwd: '/work/proj', exceptSession: 'now' });
  assert.equal(found.sessionId, 'old-2');
  assert.deepEqual(found.runs.map((run) => run.runId), ['wf_2']);
  assert.equal(latestOtherSession(registryDir, { cwd: '/work/nowhere', exceptSession: 'now' }), null);
  assert.equal(findRun(registryDir, 'wf_1').sessionId, 'old-1');
  assert.equal(findRun(registryDir, 'wf_missing'), null);
});

test('the hook writes the registry from stdin, prints nothing and exits 0 even on garbage', async () => {
  const { root, registryDir } = await world();
  const env = { ...process.env, HOME: root, USERPROFILE: root };
  const run = (input) => spawnSync(process.execPath, [HOOK], { input, env, encoding: 'utf8' });
  const ok = run(JSON.stringify(launchInput({ args: { row: '3' } })));
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, '');
  const file = join(root, '.claude', 'state', 'workflow-runs', 'sess-1.json');
  assert.match(readFileSync(file, 'utf8'), /"runId":"wf_aaa"/);
  const garbage = run('{ not json');
  assert.equal(garbage.status, 0);
  assert.equal(garbage.stdout, '');
  assert.equal(runsOfSession(registryDir, 'sess-1').length, 0, 'the temp registry folder of this test stays untouched');
});

test('a script path with a control character is not recorded, and the next clean launch still is', () => {
  const bad = launchInput({ response: launchResponse('wf_c', '/s/a\nb.js'), toolInput: {} });
  assert.equal(launchRecord(bad, NOW_ISO), null);
  assert.equal(launchRecord(launchInput(), NOW_ISO).runId, 'wf_aaa');
});
