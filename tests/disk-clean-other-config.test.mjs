// Tests for the session folders of sessions this run cannot see (disk-clean, lib/clean-rules.mjs). The scratchpad root is shared by every
// config dir of the user, while a run reads the transcripts and the registry of one config dir: a folder with no transcript there may be a
// running session's of another config dir. It is kept until nothing anywhere in it was modified for 30 days, and "found or unknown" is
// decided again on every look. The hook side (CLAUDE_CONFIG_DIR handed to the child) is in tests/disk-clean-start.test.mjs.
// Fake roots only (tests/disk-clean-helpers.mjs); every CLI run gets the fake world's home, temp folder and scratchpad root (cliEnv).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClean } from '../home/tools/disk-free/disk-clean.mjs';
import { AGE } from '../home/tools/disk-free/lib/clean-rules.mjs';
import { age, cliEnv, DAY_MS, NEWEST, OLD, OTHER, sessionFile, sessionFolder, transcript, world } from './disk-clean-helpers.mjs';

const TOOL = fileURLToPath(new URL('../home/tools/disk-free/disk-clean.mjs', import.meta.url));

test('a running session of another config dir (registered and writing its transcript only there) keeps its scratchpad in a default run, 4 days idle', () => {
  const w = world();
  const otherConfig = { projects: join(w.home, '.claude-plain', 'projects'), sessions: join(w.home, '.claude-plain', 'sessions') };
  for (const dir of [join(w.home, '.claude', 'projects'), join(w.home, '.claude', 'sessions'), otherConfig.sessions]) mkdirSync(dir, { recursive: true });
  sessionFile(otherConfig, process.pid, OLD); // alive, but only the other config dir's registry says so
  transcript(otherConfig, '-proj', OLD, 0); // written today, in the other config dir
  const path = sessionFolder(w, OLD, 4);
  const run = spawnSync(process.execPath, [TOOL, '--apply', '--claude-tmp', w.claudeTmp, '--tmp', w.tmp], { encoding: 'utf8', env: cliEnv(w) });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(join(path, 'f.txt')), true, run.stdout);
  assert.match(run.stdout, /0 items, .* found, 0 removed/);
  assert.match(run.stdout, /^ {2}1 session folder\(s\) kept: no transcript in .*projects \(maybe another config dir\); removed after 30 idle days$/m);
  const json = spawnSync(process.execPath, [TOOL, '--json', '--claude-tmp', w.claudeTmp, '--tmp', w.tmp], { encoding: 'utf8', env: cliEnv(w) });
  assert.equal(JSON.parse(json.stdout).keptUnknown, 1);
});

test('a session folder with no transcript in the scanned projects folder is kept, and counted, while it is idle for 29 days', async () => {
  const w = world();
  transcript(w, '-proj', NEWEST, 0);
  const path = sessionFolder(w, OLD, 29);
  const summary = await runClean(w.options);
  assert.deepEqual([existsSync(path), summary.items, summary.removed, summary.keptUnknown], [true, 0, 0, 1]);
});

test('a session folder with no transcript in the scanned projects folder goes once nothing in it was modified for 31 days', async () => {
  const w = world();
  transcript(w, '-proj', NEWEST, 0);
  const path = sessionFolder(w, OLD, 31);
  const summary = await runClean(w.options);
  assert.deepEqual([existsSync(path), summary.removed, summary.keptUnknown], [false, 1, 0]);
  assert.equal(AGE.unknownSessionFolderMs, 30 * DAY_MS);
});

test('with no transcript the whole tree is walked: a file 5 days old deep inside keeps a folder whose own time is 31 days old', async () => {
  const w = world();
  transcript(w, '-proj', NEWEST, 0);
  const path = sessionFolder(w, OLD, 31);
  mkdirSync(join(path, 'tasks', 'deep'), { recursive: true });
  writeFileSync(join(path, 'tasks', 'deep', 'note.txt'), 'x');
  age(join(path, 'tasks', 'deep', 'note.txt'), 5);
  for (const dir of [join(path, 'tasks', 'deep'), join(path, 'tasks'), path]) age(dir, 31); // deepest first: making an entry updates its parent's time
  const summary = await runClean(w.options);
  assert.deepEqual([existsSync(join(path, 'tasks', 'deep', 'note.txt')), summary.removed, summary.keptUnknown], [true, 0, 1]);
});

test('found or unknown is decided again on every look: a transcript that is gone at the first look, or after the rename, makes the folder unknown and it is kept', async () => {
  for (const hook of ['beforeRemove', 'afterMoveAside']) {
    const w = world();
    transcript(w, '-proj', NEWEST, 0);
    const file = transcript(w, '-proj', OLD, 4);
    const path = sessionFolder(w, OLD, 4); // found and idle at the scan: the 3-day rule would remove it
    const summary = await runClean({ ...w.options, [hook]: () => existsSync(file) && unlinkSync(file) });
    assert.deepEqual([existsSync(join(path, 'f.txt')), summary.removed, summary.changed], [true, 0, 1], hook);
  }
});

test('with no transcript, a session the registry lists as running and the session given with --session keep their folders past 30 days', async () => {
  const w = world();
  transcript(w, '-proj', NEWEST, 0);
  const running = sessionFolder(w, OLD, 40);
  const current = sessionFolder(w, OTHER, 40);
  sessionFile(w, process.pid, OLD);
  const summary = await runClean({ ...w.options, session: OTHER });
  assert.deepEqual([existsSync(running), existsSync(current), summary.removed], [true, true, 0]);
});
