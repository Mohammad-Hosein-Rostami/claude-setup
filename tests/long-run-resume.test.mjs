// Tests of what `resume` refuses and what a resumed boss is told (audit Job A6, H14): --abandon, --skip and --retry need a held
// step; a session with no transcript starts fresh instead of `--resume`; each `tell` message is a file of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeControl, queueTell } from '../home/tools/long-run/lib/control.mjs';
import { readJson } from '../home/tools/long-run/lib/run-store.mjs';
import { cli, createRun, driveRun, journalOf, makeSandbox, readCalls } from './long-run-helpers.mjs';

const oneStep = (box, name) => ({ name, cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'One.' }] });

test('resume --abandon (and --skip, --retry) on a run stopped at run level exits 1 with the fix and starts no boss', () => {
  const box = makeSandbox();
  const paths = createRun(box, oneStep(box, 'stopped'));
  assert.equal(cli(box, ['stop', paths.runId]).status, 0);
  for (const flag of ['--abandon', '--skip', '--retry']) {
    const refused = cli(box, ['resume', paths.runId, flag, '--foreground']);
    assert.equal(refused.status, 1, flag);
    assert.match(refused.stderr, new RegExp(`run ${paths.runId} holds no step \\(it is stopped\\); ${flag} applies to a held step only`));
  }
  assert.equal(readCalls(box).length, 0, 'no boss started');
  assert.equal(readJson(paths.driver).status, 'stopped');
});

test('resume --abandon on a held run still abandons it without a new boss', async () => {
  const box = makeSandbox();
  box.script({ one: ['blocked'] });
  const paths = createRun(box, oneStep(box, 'heldabandon'));
  assert.equal(await driveRun(box, paths), 'held');
  const abandoned = cli(box, ['resume', paths.runId, '--abandon', '--foreground']);
  assert.equal(abandoned.status, 0, abandoned.stderr);
  assert.equal(readCalls(box).length, 1);
  assert.equal(readJson(paths.driver).status, 'abandoned');
});

const flagValue = (args, flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);

test('a session whose transcript is gone is started fresh, not --resume, and the journal says so', async () => {
  const box = makeSandbox();
  box.script({ one: ['blocked', 'done'] });
  const paths = createRun(box, oneStep(box, 'notranscript'));
  assert.equal(await driveRun(box, paths), 'held');
  const lost = journalOf(paths, 'one').sessionId;
  rmSync(join(box.folders.config, 'projects'), { recursive: true, force: true });
  assert.equal(await driveRun(box, paths, { reply: { action: 'retry' } }), 'done');
  const second = readCalls(box)[1];
  assert.equal(flagValue(second.args, '--resume'), null);
  assert.notEqual(flagValue(second.args, '--session-id'), lost);
  assert.ok(journalOf(paths, 'one').notes.includes(`session ${lost} has no transcript: fresh start`));
});

test('tell: each message is a file of its own; the next start takes them all in order (an older runner\'s file first)', () => {
  const box = makeSandbox();
  const paths = createRun(box, oneStep(box, 'tellfiles'));
  writeFileSync(join(paths.control, 'one.tell'), `${JSON.stringify({ message: 'old' })}\n{"torn`);
  queueTell(paths, 'one', 'first');
  queueTell(paths, 'one', 'second');
  assert.equal(readdirSync(paths.control).filter((name) => name.endsWith('.tell')).length, 3);
  const control = makeControl(paths);
  assert.equal(control.hasTell('one'), true);
  assert.deepEqual(control.takeTells('one'), ['old', 'first', 'second']);
  assert.equal(control.hasTell('one'), false);
  assert.deepEqual(readdirSync(paths.control), []);
});
