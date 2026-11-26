// Tests of the system start entries (M6 autostart, M7 schedule; acceptance 11) with an injected runner and a temp HOME, so no real
// launchd agent or scheduled task is made; and of `resume --stale`, which resumes only runs whose driver died.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTOSTART_LABEL, SCHEDULE_LABEL_PREFIX, addSchedule, autostart, cliPath, listSchedules, nodePath, plistText, removeSchedule } from '../home/tools/long-run/lib/os-schedule.mjs';
import { readJson, writeJson } from '../home/tools/long-run/lib/run-store.mjs';
import { cli, createRun, makeSandbox, waitFor } from './long-run-helpers.mjs';

function recorder() {
  const calls = [];
  const runner = (command, args) => {
    calls.push([command, ...args]);
    return { status: 0, stdout: '', stderr: '' };
  };
  return { calls, runner };
}

test('autostart on (macOS): a RunAtLoad agent that runs resume --stale --delay 60 with the PATH of now, loaded with launchctl bootstrap', () => {
  const box = makeSandbox();
  const { calls, runner } = recorder();
  const env = { ...box.env, PATH: '/opt/bin:/usr/bin' };
  autostart('on', { env, platform: 'darwin', runner, uid: 501 });
  const plist = join(box.folders.home, 'Library', 'LaunchAgents', `${AUTOSTART_LABEL}.plist`);
  const text = readFileSync(plist, 'utf8');
  assert.match(text, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(text, /<key>AbandonProcessGroup<\/key><true\/>/);
  assert.match(text, new RegExp(`<string>${cliPath()}</string><string>resume</string><string>--stale</string><string>--delay</string><string>60</string>`));
  assert.match(text, /<key>PATH<\/key><string>\/opt\/bin:\/usr\/bin<\/string>/);
  assert.deepEqual(calls, [['launchctl', 'bootout', `gui/501/${AUTOSTART_LABEL}`], ['launchctl', 'bootstrap', 'gui/501', plist]]);
  assert.equal(autostart('status', { env, platform: 'darwin', runner, uid: 501 }), 'autostart on');
  autostart('off', { env, platform: 'darwin', runner, uid: 501 });
  assert.ok(!existsSync(plist));
});

test('autostart on (Windows): schtasks /Create an ONLOGON task with the quoted node, CLI and arguments', () => {
  const box = makeSandbox();
  const { calls, runner } = recorder();
  autostart('on', { env: box.env, platform: 'win32', runner });
  const [command, ...args] = calls[0];
  assert.equal(command, 'schtasks');
  assert.deepEqual(args.slice(0, 5), ['/Create', '/TN', 'claude-setup\\long-run-resume', '/SC', 'ONLOGON']);
  assert.equal(args[5], '/TR');
  assert.match(args[6], /^".+" ".+long-run\.mjs" "resume" "--stale" "--delay" "60"$/);
  assert.equal(args[7], '/F');
});

test('schedule (macOS): StartCalendarInterval of Hour and Minute (daily), plus Month and Day for one date; remove unloads it', () => {
  const box = makeSandbox();
  const { calls, runner } = recorder();
  const options = { env: box.env, platform: 'darwin', runner, uid: 501 };
  addSchedule({ root: box.root, name: 'nightly', jobPath: '/jobs/nightly.json', account: 'acct-a', at: '02:30', on: null }, options);
  addSchedule({ root: box.root, name: 'once', jobPath: '/jobs/once.json', account: 'acct-a', at: '23:05', on: '2026-12-01' }, options);
  const agents = join(box.folders.home, 'Library', 'LaunchAgents');
  const nightly = readFileSync(join(agents, `${SCHEDULE_LABEL_PREFIX}nightly.plist`), 'utf8');
  assert.match(nightly, /<key>StartCalendarInterval<\/key><dict><key>Hour<\/key><integer>2<\/integer><key>Minute<\/key><integer>30<\/integer><\/dict>/);
  assert.match(nightly, /<string>start<\/string><string>\/jobs\/nightly\.json<\/string><string>--schedule<\/string><string>nightly<\/string>/);
  assert.match(nightly, /<key>RunAtLoad<\/key><false\/>/);
  const once = readFileSync(join(agents, `${SCHEDULE_LABEL_PREFIX}once.plist`), 'utf8');
  assert.match(once, /<dict><key>Month<\/key><integer>12<\/integer><key>Day<\/key><integer>1<\/integer><key>Hour<\/key><integer>23<\/integer><key>Minute<\/key><integer>5<\/integer><\/dict>/);
  assert.deepEqual(listSchedules(box.root).map((one) => [one.name, one.account, one.on]).sort(), [['nightly', 'acct-a', null], ['once', 'acct-a', '2026-12-01']]);
  assert.ok(removeSchedule(box.root, 'once', options));
  assert.ok(!existsSync(join(agents, `${SCHEDULE_LABEL_PREFIX}once.plist`)));
  assert.deepEqual(calls.at(-1), ['launchctl', 'bootout', `gui/501/${SCHEDULE_LABEL_PREFIX}once`]);
  assert.throws(() => addSchedule({ root: box.root, name: 'bad', jobPath: '/j.json', account: 'acct-a', at: '25:00', on: null }, options), /HH:MM/);
});

test('schedule (Windows): schtasks DAILY /ST, or ONCE /ST /SD for one date', () => {
  const box = makeSandbox();
  const { calls, runner } = recorder();
  const options = { env: box.env, platform: 'win32', runner };
  addSchedule({ root: box.root, name: 'nightly', jobPath: 'C:\\jobs\\n.json', account: 'acct-a', at: '02:30', on: null }, options);
  addSchedule({ root: box.root, name: 'once', jobPath: 'C:\\jobs\\o.json', account: 'acct-a', at: '23:05', on: '2026-12-01' }, options);
  assert.deepEqual(calls[0].slice(0, 8), ['schtasks', '/Create', '/TN', 'claude-setup\\long-run-nightly', '/SC', 'DAILY', '/ST', '02:30']);
  assert.deepEqual(calls[1].slice(0, 10), ['schtasks', '/Create', '/TN', 'claude-setup\\long-run-once', '/SC', 'ONCE', '/ST', '23:05', '/SD', '12/01/2026']);
  assert.match(calls[1][11], /"start" "C:\\jobs\\o\.json" "--schedule" "once"$/);
});

/** Writes an empty file `name` in a new folder `dir` under the sandbox and returns the folder. */
function fakeNodeDir(box, dir, name) {
  const folder = join(box.dir, dir);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, name), '');
  return folder;
}

test('nodePath: the first node on PATH, unresolved, even when HOME holds a version manager shim', () => {
  const box = makeSandbox();
  fakeNodeDir(box, join('home', '.volta', 'bin'), 'node');
  const onPath = fakeNodeDir(box, 'node-bin', 'node');
  const later = fakeNodeDir(box, 'later-bin', 'node');
  const env = { HOME: box.folders.home, PATH: ['relative-bin', join(box.dir, 'empty'), onPath, later].join(':') };
  assert.equal(nodePath(env, 'darwin'), join(onPath, 'node'));
});

test('nodePath: no node on PATH falls back to the node running now', () => {
  const box = makeSandbox();
  fakeNodeDir(box, join('home', '.volta', 'bin'), 'node');
  assert.equal(nodePath({ HOME: box.folders.home, PATH: '' }, 'darwin'), process.execPath);
  assert.equal(nodePath({ HOME: box.folders.home }, 'linux'), process.execPath);
});

test('nodePath (Windows): node.exe from Path, split by ;', () => {
  const box = makeSandbox();
  fakeNodeDir(box, 'plain-bin', 'node');
  const withExe = fakeNodeDir(box, 'exe-bin', 'node.exe');
  assert.equal(nodePath({ Path: [join(box.dir, 'plain-bin'), withExe].join(';') }, 'win32'), join(withExe, 'node.exe'));
});

test('plist text escapes XML characters', () => {
  assert.match(plistText({ label: 'l', args: ['a&b<c>'], path: '/bin' }), /<string>a&amp;b&lt;c&gt;<\/string>/);
});

test('resume --stale resumes only a run whose driver died; paused, stopped, held, taken-over and done runs stay as they are', async () => {
  const box = makeSandbox();
  const made = {};
  const states = {
    paused: { status: 'paused' }, stopped: { status: 'stopped' }, held: { status: 'held', hold: { stepId: 'one', status: 'needs-owner' } },
    taken: { status: 'held', hold: { stepId: 'one', status: 'taken-over' } }, done: { status: 'done' },
    stale: { status: 'running', pid: 999999, host: 'gone', beatAt: '2026-01-01T00:00:00.000Z' },
  };
  for (const [name, driver] of Object.entries(states)) {
    made[name] = createRun(box, { name, cwd: box.work(name), steps: [{ id: 'one', prompt: 'One.' }] });
    writeJson(made[name].driver, { startedAt: '2026-01-01T00:00:00.000Z', live: {}, ...driver });
  }
  const result = cli(box, ['resume', '--stale']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`resuming ${made.stale.runId} \\(continue\\)`));
  assert.equal(result.stdout.match(/^resuming /gm).length, 1);
  await waitFor(() => readJson(made.stale.driver)?.status === 'done', 30000, 'the stale run done');
  for (const name of ['paused', 'stopped', 'held', 'taken', 'done']) assert.equal(readJson(made[name].driver).status, states[name].status, name);
});
