// Tests for the rename-aside of disk-clean: a folder is renamed to `.removing-<pid>-<name>` before it is removed and looked at again, so a
// session that resumes during the removal keeps its work; a folder left aside by a killed run is finished by the next run only after the same
// checks; whatever fails after the rename, the folder goes back to its own name when that is free and the failure line names a path that exists.
// Fake roots only (tests/disk-clean-helpers.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runClean } from '../home/tools/disk-free/disk-clean.mjs';
import { age, folder, NEWEST, OLD, OTHER, posix, sessionFile, sessionFolder, transcript, world } from './disk-clean-helpers.mjs';

const asideOf = (path) => join(join(path, '..'), `.removing-${process.pid}-${path.split('/').at(-1)}`);

// A session that resumes while its folder is being removed: the folder is renamed aside first, so new work goes to a new folder.
const resumeWorld = () => {
  const w = world();
  transcript(w, '-proj', OLD, 10);
  transcript(w, '-proj', NEWEST, 0);
  return { w, path: sessionFolder(w, OLD, 10) };
};

test('a session that registers as running right after its folder was renamed aside gets the folder back, with its files', posix, async () => {
  const { w, path } = resumeWorld();
  const summary = await runClean({ ...w.options, afterMoveAside: () => sessionFile(w, process.pid, OLD) });
  assert.deepEqual([existsSync(join(path, 'f.txt')), existsSync(asideOf(path)), summary.changed, summary.removed], [true, false, 1, 0]);
});

test('a session whose transcript is written right after the rename (resume) gets the folder back; a test temp folder written to likewise', posix, async () => {
  const { w, path } = resumeWorld();
  const tempFolder = folder(join(w.tmp, 'cs-run-AbCdEf'), { days: 3 });
  const summary = await runClean({
    ...w.options,
    afterMoveAside: (aside) => (aside.includes(OLD) ? age(join(w.projects, '-proj', `${OLD}.jsonl`), 0) : writeFileSync(join(aside, 'new.txt'), 'x')),
  });
  assert.deepEqual([existsSync(join(path, 'f.txt')), existsSync(join(tempFolder, 'new.txt')), summary.changed, summary.removed], [true, true, 2, 0]);
});

test('work the resumed session writes to the original path while the old folder is aside is never removed; the old folder goes', posix, async () => {
  const { w, path } = resumeWorld();
  const summary = await runClean({ ...w.options, afterMoveAside: () => { mkdirSync(path); writeFileSync(join(path, 'new-work.txt'), 'x'); } });
  assert.deepEqual([existsSync(join(path, 'new-work.txt')), existsSync(asideOf(path)), summary.removed], [true, false, 1]);
});

test('when the folder cannot be renamed back (the session already wrote there) it stays aside and the run says so', posix, async () => {
  const { w, path } = resumeWorld();
  const summary = await runClean({ ...w.options, afterMoveAside: () => { mkdirSync(path); writeFileSync(join(path, 'new-work.txt'), 'x'); sessionFile(w, process.pid, OLD); } });
  assert.deepEqual([existsSync(join(path, 'new-work.txt')), existsSync(join(asideOf(path), 'f.txt')), summary.failed.length, summary.removed], [true, true, 1, 0]);
  assert.match(summary.failed[0], /stays as .*\.removing-/);
});

test('an error at the look after the rename puts the folder back whole and is listed with the path the folder has', posix, async () => {
  const { w, path } = resumeWorld();
  const summary = await runClean({ ...w.options, afterMoveAside: () => { throw new Error('the look failed'); } });
  assert.deepEqual([existsSync(join(path, 'f.txt')), existsSync(asideOf(path)), summary.removed, summary.changed, summary.failed.length], [true, false, 0, 0, 1]);
  assert.ok(summary.failed[0].endsWith(`: the look failed; the folder was put back at ${realpathSync(path)}`), summary.failed[0]);
});

test('a removal that fails after the rename while the old name was taken: the folder stays aside and the failure names that path, which exists, and both errors', posix, async () => {
  const { w, path } = resumeWorld();
  mkdirSync(join(path, 'open'));
  chmodSync(join(path, 'open'), 0o777); // writable by others: the removal refuses it
  for (const entry of [join(path, 'open'), path]) age(entry, 10);
  const summary = await runClean({ ...w.options, afterMoveAside: () => { mkdirSync(path); writeFileSync(join(path, 'new-work.txt'), 'x'); } });
  assert.deepEqual([existsSync(join(path, 'new-work.txt')), existsSync(join(asideOf(path), 'open')), summary.removed, summary.failed.length], [true, true, 0, 1]);
  const named = /writable by others.*; the folder could not be renamed back \(.*ENOTEMPTY.*\), it stays as (.+), possibly partly emptied$/.exec(summary.failed[0])?.[1];
  assert.equal(named, realpathSync(asideOf(path)), summary.failed[0]);
  chmodSync(join(asideOf(path), 'open'), 0o755);
});

test('a folder that someone moved away after the rename is not said to stay at a path where it is not', posix, async () => {
  const { w, path } = resumeWorld();
  const summary = await runClean({ ...w.options, afterMoveAside: (aside) => renameSync(aside, join(w.root, 'moved-away')) });
  assert.deepEqual([existsSync(join(w.root, 'moved-away', 'f.txt')), summary.removed, summary.failed.length], [true, 0, 1]);
  assert.match(summary.failed[0], /could not be renamed back \(.*\), and it is no longer at .*\.removing-/);
  assert.doesNotMatch(summary.failed[0], /it stays as/);
});

test('a run does not find the folders it renamed aside itself (.removing-<own pid>-*), in any rule; a killed run\'s (another pid) are found', posix, async () => {
  const w = world();
  for (const id of [OLD, OTHER]) transcript(w, '-proj', id, 10);
  transcript(w, '-proj', NEWEST, 0);
  // one aside folder per folder rule: a session folder, a test temp folder, a throwaway project
  const asides = (pid, id, tempName, slug) => [folder(join(w.claudeTmp, '-proj', `.removing-${pid}-${id}`), { days: 10 }), folder(join(w.tmp, `.removing-${pid}-${tempName}`), { days: 3 }), folder(join(w.projects, `.removing-${pid}-${slug}`), { days: 10 })];
  const [own, killed] = [asides(process.pid, OLD, 'cs-run-OwnOwn', '-tmp-own'), asides(4242, OTHER, 'cs-run-Killed', '-tmp-killed')];
  const summary = await runClean({ ...w.options, apply: false });
  assert.equal(summary.items, 3, 'only the three of the killed run');
  await runClean(w.options);
  assert.deepEqual([own.map(existsSync), killed.map(existsSync)], [[true, true, true], [false, false, false]]);
});

test('a run handles each original path once: a leftover of a killed run and a new folder of the same name do not both go in one run', posix, async () => {
  const w = world();
  const both = [folder(join(w.tmp, '.removing-4242-cs-run-AbCdEf'), { days: 3 }), folder(join(w.tmp, 'cs-run-AbCdEf'), { days: 3 })];
  const first = await runClean(w.options);
  assert.deepEqual([first.items, first.removed, both.filter(existsSync).length], [1, 1, 1]);
  const second = await runClean(w.options);
  assert.deepEqual([second.removed, both.filter(existsSync).length], [1, 0]);
});

test('a folder left aside by a killed run is removed by the next run only when the same checks pass for its original name', posix, async () => {
  const w = world();
  for (const id of [OLD, OTHER]) transcript(w, '-proj', id, 10);
  transcript(w, '-proj', NEWEST, 0);
  const leftover = (id) => folder(join(w.claudeTmp, '-proj', `.removing-4242-${id}`), { days: 10 });
  const idle = leftover(OLD);
  const live = leftover(OTHER);
  sessionFile(w, process.pid, OTHER);
  const tempAside = folder(join(w.tmp, '.removing-4242-cs-run-AbCdEf'), { days: 3 });
  const longSlug = `-tmp-${'x'.repeat(225)}`; // renamed aside again it would not fit in a file name: a leftover is removed where it is
  const projectAside = folder(join(w.projects, `.removing-4242-${longSlug}`), { days: 10 });
  const youngAside = folder(join(w.tmp, '.removing-4242-cs-run-ZzZzZz'), { days: 0 });
  const summary = await runClean(w.options);
  assert.deepEqual([existsSync(idle), existsSync(live), existsSync(tempAside), existsSync(youngAside), summary.removed], [false, true, false, true, 3]);
  assert.equal(existsSync(projectAside), false);
});


test('a test temp folder written to between the scan and the first look is kept', posix, async () => {
  const w = world();
  const path = folder(join(w.tmp, 'cs-run-AbCdEf'), { days: 3 });
  const summary = await runClean({ ...w.options, beforeRemove: () => writeFileSync(join(path, 'new.txt'), 'x') });
  assert.deepEqual([existsSync(join(path, 'new.txt')), summary.changed, summary.removed], [true, 1, 0]);
});

test('a session whose transcript appears between the scan and the first look keeps its folder (the transcript of its project is looked at again)', posix, async () => {
  const w = world();
  transcript(w, '-proj', NEWEST, 0);
  const path = sessionFolder(w, OLD, 31); // no transcript at the scan: only a folder idle for 30 days is found then
  const summary = await runClean({ ...w.options, beforeRemove: () => transcript(w, '-proj', OLD, 0) });
  assert.deepEqual([existsSync(join(path, 'f.txt')), summary.changed, summary.removed], [true, 1, 0]);
});

test('a session that is live at the first look is never renamed: the first look comes before the rename', posix, async () => {
  const { w, path } = resumeWorld();
  let renamed = 0;
  const summary = await runClean({ ...w.options, beforeRemove: () => sessionFile(w, process.pid, OLD), afterMoveAside: () => { renamed += 1; } });
  assert.deepEqual([renamed, existsSync(join(path, 'f.txt')), summary.changed], [0, true, 1]);
});
