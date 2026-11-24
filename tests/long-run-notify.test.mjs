// Tests of the notes, keep-awake and system entries (M1, M2, M5; acceptance 11) with injected runners: nothing here shows a real
// note, sends a real push, keeps the machine awake or writes a real launchd or Task Scheduler entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopCommand, notify, ntfyRequest, readNotifyConfig, setupNtfy } from '../home/tools/long-run/lib/notify.mjs';
import { awakeCommand, startAwake } from '../home/tools/long-run/lib/awake.mjs';
import { createRun, driveRun, makeSandbox } from './long-run-helpers.mjs';

const TEXT = 'run x: step "a" held; $(rm -rf ~) `whoami`';

test('desktop notes pass the text as data: osascript argv, PowerShell environment variables, notify-send after --', () => {
  const mac = desktopCommand('darwin', 'long-run', TEXT);
  assert.deepEqual(mac.args, ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', 'long-run', TEXT]);
  assert.equal(mac.command, 'osascript');
  const win = desktopCommand('win32', 'long-run', TEXT);
  assert.equal(win.command, 'powershell.exe');
  assert.ok(!win.args.join(' ').includes(TEXT), 'the text is never inside the script');
  assert.deepEqual(win.env, { LONG_RUN_NOTE_TITLE: 'long-run', LONG_RUN_NOTE_TEXT: TEXT });
  assert.deepEqual(desktopCommand('linux', 'long-run', TEXT), { command: 'notify-send', args: ['--', 'long-run', TEXT], env: {} });
});

test('ntfy: setup writes a 24-character topic (0600); the request body is the phone text only', async () => {
  const box = makeSandbox();
  const link = setupNtfy({ env: box.env });
  const { ntfy } = readNotifyConfig(box.env);
  assert.match(ntfy.topic, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(link, `https://ntfy.sh/${ntfy.topic}`);
  assert.deepEqual(ntfyRequest(ntfy, 'docs: plan needs your answer'), { url: link, init: { method: 'POST', headers: { Title: 'long-run' }, body: 'docs: plan needs your answer' } });
  const sent = [];
  const fetchFn = async (url, init) => { sent.push({ url, body: init.body }); return { ok: true, status: 200 }; };
  const spawnFn = () => ({ once: (event, done) => { if (event === 'close') setImmediate(() => done(0)); } });
  const failures = await notify({ desktop: 'run docs-1: plan held: needs-owner', phone: 'docs: plan needs your answer' }, { env: box.env, fetchFn, spawnFn, platform: 'darwin' });
  assert.deepEqual(failures, []);
  assert.deepEqual(sent, [{ url: link, body: 'docs: plan needs your answer' }]);
  assert.throws(() => setupNtfy({ env: box.env, server: 'http://plain.example' }), /https URL/);
});

test('the driver sends the phone only the job name, the step and a status word, never the question', async () => {
  const box = makeSandbox();
  box.script({ one: ['needs-owner'] });
  const notes = [];
  const paths = createRun(box, { name: 'quiet', cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'Secret plan text.' }] });
  await driveRun(box, paths, { notes });
  assert.deepEqual(notes.map((note) => note.phone), ['quiet: one needs your answer']);
  for (const note of notes) assert.ok(!/colour|Secret/.test(`${note.phone} ${note.desktop}`));
});

test('keep-awake: caffeinate -i -w <pid> on macOS, a hidden PowerShell loop on the pid on Windows, systemd-inhibit on Linux', () => {
  assert.deepEqual(awakeCommand('darwin', 4242), { command: 'caffeinate', args: ['-i', '-w', '4242'] });
  const win = awakeCommand('win32', 4242);
  assert.equal(win.command, 'powershell.exe');
  assert.match(win.args.at(-1), /Get-Process -Id 4242 .*SetThreadExecutionState\(2147483649\)/);
  assert.deepEqual(awakeCommand('linux', 4242, { hasSystemdInhibit: true }).args.slice(-4), ['tail', '--pid=4242', '-f', '/dev/null']);
  assert.equal(awakeCommand('linux', 4242), null);
  assert.throws(() => awakeCommand('darwin', '4242; rm'), /not a pid/);
  const started = [];
  const spawnFn = (command, args, options) => {
    started.push({ command, args, detached: options.detached });
    return { on: () => {}, unref: () => {} };
  };
  assert.equal(startAwake({ platform: 'darwin', pid: 77, spawnFn }), 'keep-awake: caffeinate');
  assert.deepEqual(started, [{ command: 'caffeinate', args: ['-i', '-w', '77'], detached: true }]);
});
