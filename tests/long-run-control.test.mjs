// Tests of the owner's control through the CLI with a detached driver (spec 7.8, 9; acceptance 3, 4, 5, 6): crash resume, pause,
// stop of one step, takeover (lines, open-session refusal, --force), status of the boss sessions, watch, and a crash mid-group.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { endOrphan, KILL_AFTER, startClaude } from '../home/tools/long-run/lib/claude-run.mjs';
import { takeoverLines } from '../home/tools/long-run/lib/control.mjs';
import { isPidAlive, readJson, runPaths } from '../home/tools/long-run/lib/run-store.mjs';
import { TOKEN_A, cli, journalOf, makeSandbox, readCalls, startCli, waitFor } from './long-run-helpers.mjs';

const flagValue = (args, flag) => args[args.indexOf(flag) + 1];

/** Starts `job` detached through the CLI; returns the run's paths once `step` runs. */
async function startRunning(box, job, step) {
  const result = cli(box, ['start', box.writeJob(job)]);
  assert.equal(result.status, 0, result.stderr);
  const runId = /^started (\S+)/m.exec(result.stdout)[1];
  const paths = runPaths(box.root, runId);
  await waitFor(() => readJson(paths.driver)?.live?.[step]?.state === 'running' && readCalls(box).some((call) => call.step === step), 30000, `${step} running`);
  return paths;
}

const driverGone = (paths) => () => !isPidAlive(readJson(paths.driver)?.pid);

test('crash: SIGKILL of the driver while step 2 runs -> status stale -> resume runs step 2 with --resume <same id>, never step 1 again', async () => {
  const box = makeSandbox();
  box.script({ two: ['hang', 'done'] });
  const job = { name: 'crash', cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'One.' }, { id: 'two', prompt: 'Two.' }, { id: 'three', prompt: 'Three.' }] };
  const paths = await startRunning(box, job, 'two');
  process.kill(readJson(paths.driver).pid, 'SIGKILL');
  await waitFor(driverGone(paths), 10000, 'driver gone');
  assert.match(cli(box, ['status']).stdout, new RegExp(`^${paths.runId} stale `, 'm'));
  const resumed = cli(box, ['resume', paths.runId, '--foreground']);
  assert.equal(resumed.status, 0, resumed.stderr);
  const calls = readCalls(box);
  assert.deepEqual(calls.map((call) => call.step), ['one', 'two', 'two', 'three']);
  assert.equal(flagValue(calls[2].args, '--resume'), flagValue(calls[1].args, '--session-id'));
  assert.equal(calls[1].ended, 'SIGINT', 'the child the dead driver left was ended before the resume (never two writers)');
  assert.equal(readJson(paths.driver).status, 'done');
});

test('pause <run>: the child ends on SIGINT, status paused with its session listed, resume continues the same session', async () => {
  const box = makeSandbox();
  box.script({ one: ['hang', 'done'] });
  const paths = await startRunning(box, { name: 'pause', cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'One.' }] }, 'one');
  const running = cli(box, ['status', paths.runId]).stdout;
  const sessionId = journalOf(paths, 'one').sessionId;
  assert.match(running, new RegExp(`session one running account=acct-a id=${sessionId} .*log=${paths.logs}/one\\.1\\.jsonl`));
  assert.equal(cli(box, ['pause', paths.runId]).status, 0);
  await waitFor(() => readJson(paths.driver).status === 'paused' && driverGone(paths)(), 30000, 'paused');
  assert.equal(readCalls(box)[0].ended, 'SIGINT');
  assert.match(cli(box, ['status']).stdout, new RegExp(`^${paths.runId} paused `, 'm'));
  assert.match(cli(box, ['status', paths.runId]).stdout, new RegExp(`session one paused account=acct-a id=${sessionId}`));
  const resumed = cli(box, ['resume', paths.runId, '--foreground']);
  assert.equal(resumed.status, 0, resumed.stderr);
  const calls = readCalls(box);
  assert.equal(flagValue(calls[1].args, '--resume'), sessionId);
  assert.match(calls[1].stdin, /The runner paused or restarted this session/);
});

test('a child that ignores SIGINT and SIGTERM is gone after the SIGKILL step (KILL_AFTER is 10 s / 20 s; shortened here)', async () => {
  assert.deepEqual(KILL_AFTER, { term: 10000, kill: 20000 });
  const box = makeSandbox();
  box.script({ deaf: ['deaf'] });
  const logs = mkdtempSync(join(box.dir, 'logs-'));
  const handle = startClaude({ args: ['-p', '--session-id', 'deaf-session'], prompt: 'x', cwd: box.work('d'), env: box.env, token: TOKEN_A,
    added: { LONG_RUN_STEP: 'deaf' }, logBase: join(logs, 'deaf.1'), killAfter: { term: 300, kill: 600 } });
  await waitFor(() => readCalls(box).length === 1, 10000, 'fake started');
  handle.end('pause');
  const run = await handle.done;
  assert.deepEqual([run.endedBy, run.endedHow, run.signal], ['pause', 'SIGKILL', 'SIGKILL']);
});

test('endOrphan leaves a pid alone whose command line does not name the session (a reused pid)', async () => {
  const outcome = await endOrphan({ pid: process.pid, sessionId: 'not-in-this-command-line', isAlive: () => true });
  assert.equal(outcome, 'none');
});

test('stop <run> <step>: the step fails "stopped by the owner" and is routed by next.failed', async () => {
  const box = makeSandbox();
  box.script({ build: ['hang'] });
  const job = { name: 'stop', cwd: box.work('repo'), steps: [{ id: 'build', prompt: 'Build.', next: { failed: 'fix' } }, { id: 'fix', prompt: 'Fix.', next: { done: 'end' } }] };
  const paths = await startRunning(box, job, 'build');
  assert.equal(cli(box, ['stop', paths.runId, 'build']).status, 0);
  await waitFor(() => readJson(paths.driver)?.status === 'done', 40000, 'run done');
  assert.deepEqual(readCalls(box).map((call) => call.step), ['build', 'fix']);
  assert.deepEqual(journalOf(paths, 'build').final, { status: 'failed', reason: 'stopped by the owner' });
});

test('takeover prints the zsh lines with the account, the quoted folder and the session; resume refuses while the session looks open, --force resumes it with the taken-over follow-up', async () => {
  const box = makeSandbox();
  box.script({ one: ['hang', 'done'] });
  const folder = box.work("my 'odd' dir");
  const paths = await startRunning(box, { name: 'take', cwd: folder, steps: [{ id: 'one', prompt: 'One.' }] }, 'one');
  const result = cli(box, ['takeover', paths.runId, 'one']);
  assert.equal(result.status, 0, result.stderr);
  const sessionId = journalOf(paths, 'one').sessionId;
  const lines = result.stdout.split('\n');
  const at = lines.indexOf('claude-as acct-a');
  assert.ok(at > 0, result.stdout);
  assert.deepEqual(lines.slice(at, at + 3), ['claude-as acct-a', `cd '${folder.replace(/'/g, "'\\''")}'`, `claude --resume ${sessionId} --model claude-opus-5-5`]);
  await waitFor(driverGone(paths), 10000, 'driver ended');
  assert.match(cli(box, ['status', paths.runId]).stdout, new RegExp(`session one taken-over account=acct-a id=${sessionId}`));
  const refused = cli(box, ['resume', paths.runId]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /looks open \(its transcript changed in the last 60 s\); quit it in its terminal first, or resume --force/);
  const forced = cli(box, ['resume', paths.runId, '--force', '--foreground']);
  assert.equal(forced.status, 0, forced.stderr);
  const second = readCalls(box)[1];
  assert.equal(flagValue(second.args, '--resume'), sessionId);
  assert.equal(second.stdin, 'The owner continued this step by hand and has quit. Check what is done, finish what is left, and give your STEP-RESULT line.');
});

test('takeover under platform=win32 prints one PowerShell line with the folder quoted for PowerShell', () => {
  const lines = takeoverLines({ account: 'acct-a', folder: "D:\\work\\my 'odd' dir", sessionId: 'abc', model: 'sonnet', platform: 'win32' });
  assert.deepEqual(lines, ["claude-as acct-a; Set-Location -LiteralPath 'D:\\work\\my ''odd'' dir'; claude --resume abc --model sonnet"]);
});

test('watch prints the new lines of a growing log and ends on SIGINT with exit 0', async () => {
  const box = makeSandbox();
  box.script({ one: ['tool:2500'] });
  const paths = await startRunning(box, { name: 'watch', cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'One.' }] }, 'one');
  const watcher = startCli(box, ['watch', paths.runId, 'one']);
  await waitFor(() => watcher.output.includes('tool result'), 20000, 'a new line in watch');
  watcher.kill('SIGINT');
  const code = await new Promise((resolve) => { watcher.once('close', resolve); });
  assert.equal(code, 0);
  await waitFor(() => readJson(paths.driver)?.status === 'done', 20000, 'run done');
});

test('SIGKILL mid-group, then resume: only the unfinished items run again', async () => {
  const box = makeSandbox();
  box.script({ g1: ['done'], g2: ['done'], g3: ['hang', 'done'] });
  const job = { name: 'midgroup', cwd: box.work('repo'), steps: [{ id: 'pages', parallel: ['g1', 'g2', 'g3'].map((id) => ({ id, prompt: `Page ${id}.`, cwd: box.work(id) })) }] };
  const paths = await startRunning(box, job, 'g3');
  await waitFor(() => ['g1', 'g2'].every((id) => journalOf(paths, id)?.final?.status === 'done'), 20000, 'g1 and g2 done');
  process.kill(readJson(paths.driver).pid, 'SIGKILL');
  await waitFor(driverGone(paths), 10000, 'driver gone');
  const resumed = cli(box, ['resume', paths.runId, '--foreground']);
  assert.equal(resumed.status, 0, resumed.stderr);
  const counts = Object.fromEntries(['g1', 'g2', 'g3'].map((id) => [id, readCalls(box).filter((call) => call.step === id).length]));
  assert.deepEqual(counts, { g1: 1, g2: 1, g3: 2 });
  assert.equal(readJson(paths.driver).status, 'done');
});
