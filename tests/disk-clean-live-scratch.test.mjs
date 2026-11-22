// Tests for disk-clean's session-scratch rule (lib/clean-rules.mjs): in a session that runs for days, the scratchpad's cs-test-* and git
// clone folders in which nothing was modified for 2 days go (owner FR5); a newer one, any other name, a link, a linked worktree and a folder
// a lane still writes stay; a finished session's folder is counted once; a killed run's `.removing-*` folder is finished; two --apply runs
// at once remove each folder once. Fake roots only (disk-clean-helpers.mjs world()): the real HOME and scratchpad root are never read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClean } from '../home/tools/disk-free/disk-clean.mjs';
import { age, cliEnv, folder, NEWEST, OLD, posix, sessionFile, transcript, world } from './disk-clean-helpers.mjs';

const TOOL = fileURLToPath(new URL('../home/tools/disk-free/disk-clean.mjs', import.meta.url));
const LIVE = '12345678-0000-4000-8000-00000000000a';
const OLD_DAYS = 3; // past the rule's 2 days
const NEW_DAYS = 1; // inside them

/** The scratchpad of a running session (this test process's pid is alive, so the session-folders rule keeps the whole folder). */
function liveScratchpad(w) {
  sessionFile(w, process.pid, LIVE);
  const scratchpad = join(w.claudeTmp, '-proj', LIVE, 'scratchpad');
  mkdirSync(scratchpad, { recursive: true });
  return scratchpad;
}

/** A folder holding a git repository (a `.git` folder), everything `days` old. */
function cloneFolder(path, days) {
  folder(join(path, '.git'), { days, files: { HEAD: 'ref: refs/heads/main\n' } });
  return folder(path, { days, files: { 'README.md': 'x' } });
}

/** The live session's fixture: what must go and what must stay. */
function fixture(w) {
  const scratchpad = liveScratchpad(w);
  const outside = folder(join(w.root, 'outside-target'), { days: OLD_DAYS });
  const paths = {
    oldTest: folder(join(scratchpad, 'cs-test-x'), { days: OLD_DAYS }),
    oldClone: cloneFolder(join(scratchpad, 'clone'), OLD_DAYS),
    newTest: folder(join(scratchpad, 'cs-test-y'), { days: NEW_DAYS }),
    newClone: cloneFolder(join(scratchpad, 'fresh-clone'), NEW_DAYS),
    otherName: folder(join(scratchpad, 'probe-old'), { days: OLD_DAYS }),
    worktree: folder(join(scratchpad, 'wt'), { days: OLD_DAYS, files: { '.git': 'gitdir: /elsewhere/.git/worktrees/wt\n' } }),
    testFile: join(scratchpad, 'cs-test-notes.txt'),
    link: join(scratchpad, 'cs-test-link'),
    outside,
  };
  writeFileSync(paths.testFile, 'a file, not a folder');
  age(paths.testFile, OLD_DAYS);
  symlinkSync(outside, paths.link);
  return paths;
}

const scratchRule = (summary) => summary.rules.find((rule) => rule.name === 'session-scratch');
const listed = (summary) => scratchRule(summary).sample.map((item) => item.path).sort();
const real = (...paths) => paths.map((path) => realpathSync(path)).sort(); // the rules report real paths (/var is /private/var on macOS)

test('live session: the dry run lists only the cs-test-* and clone folders idle 2 days; --apply removes only those', posix, async () => {
  const w = world();
  const paths = fixture(w);
  const dry = await runClean({ ...w.options, apply: false });
  assert.deepEqual(listed(dry), real(paths.oldClone, paths.oldTest));
  assert.equal(dry.rules.find((rule) => rule.name === 'session-folders').items, 0, 'the running session keeps its folder');
  const applied = await runClean(w.options);
  assert.deepEqual([applied.removed, applied.failed], [2, []]);
  assert.deepEqual([existsSync(paths.oldTest), existsSync(paths.oldClone)], [false, false]);
  for (const kept of ['newTest', 'newClone', 'otherName', 'worktree', 'testFile', 'link']) assert.equal(existsSync(paths[kept]), true, kept);
  assert.equal(existsSync(join(paths.outside, 'f.txt')), true, 'the link is never followed');
});

test('a folder a lane still writes stays: one new file anywhere inside keeps it, also when it appears right before the removal', posix, async () => {
  const w = world();
  const scratchpad = liveScratchpad(w);
  const deep = folder(join(scratchpad, 'cs-test-busy', 'repo', 'src'), { days: NEW_DAYS });
  for (const part of [join(scratchpad, 'cs-test-busy', 'repo'), join(scratchpad, 'cs-test-busy')]) age(part, OLD_DAYS);
  const late = folder(join(scratchpad, 'cs-test-late'), { days: OLD_DAYS });
  const dry = await runClean({ ...w.options, apply: false });
  assert.deepEqual(listed(dry), real(late), `only the idle one: ${deep} was written a day ago`);
  const summary = await runClean({ ...w.options, beforeRemove: (path) => writeFileSync(join(path, 'written-now'), '.') });
  assert.deepEqual([summary.removed, summary.changed, existsSync(late)], [0, 1, true]);
});

test('a finished session folder is counted once (by session-folders), and the current session\'s old cs-test folder is listed', posix, async () => {
  const w = world();
  transcript(w, '-proj', NEWEST, 0); // the newest transcript's session is never removed: OLD must not be it
  transcript(w, '-proj', OLD, 10);
  folder(join(w.claudeTmp, '-proj', OLD, 'scratchpad', 'cs-test-z'), { days: 10 });
  age(join(w.claudeTmp, '-proj', OLD, 'scratchpad'), 10);
  age(join(w.claudeTmp, '-proj', OLD), 10);
  const current = '22222222-0000-4000-8000-00000000000b';
  const currentTest = folder(join(w.claudeTmp, '-proj', current, 'scratchpad', 'cs-test-c'), { days: OLD_DAYS });
  const dry = await runClean({ ...w.options, apply: false, session: current });
  assert.equal(dry.rules.find((rule) => rule.name === 'session-folders').items, 1);
  assert.deepEqual(listed(dry), real(currentTest));
  assert.equal(dry.items, 2);
});

test('crash case: a cs-test folder a killed run left renamed aside is finished; this run\'s own aside name is skipped', posix, async () => {
  const w = world();
  const scratchpad = liveScratchpad(w);
  const leftover = folder(join(scratchpad, '.removing-999999-cs-test-k'), { days: OLD_DAYS });
  const own = folder(join(scratchpad, `.removing-${process.pid}-cs-test-o`), { days: OLD_DAYS });
  const leftoverOther = folder(join(scratchpad, '.removing-999999-notes'), { days: OLD_DAYS });
  const summary = await runClean(w.options);
  assert.deepEqual([summary.removed, existsSync(leftover), existsSync(own), existsSync(leftoverOther)], [1, false, true, true]);
});

test('CLI: two --apply runs at once remove each old folder once, keep the rest and both exit 0', posix, async () => {
  const w = world();
  const paths = fixture(w);
  const args = [TOOL, '--apply', '--json', '--claude-tmp', w.claudeTmp, '--projects', w.projects, '--tmp', w.tmp, '--sessions', w.sessions];
  const runOnce = () => new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env: cliEnv(w) });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('close', (status) => resolve({ status, out }));
  });
  const runs = await Promise.all([runOnce(), runOnce()]);
  assert.deepEqual(runs.map((run) => run.status), [0, 0], runs.map((run) => run.out).join('\n'));
  const removed = runs.map((run) => (run.out.startsWith('{') ? JSON.parse(run.out).removed : 0)).reduce((sum, n) => sum + n, 0);
  assert.equal(removed, 2, runs.map((run) => run.out).join('\n'));
  assert.deepEqual([existsSync(paths.oldTest), existsSync(paths.oldClone), existsSync(paths.newTest), existsSync(paths.otherName)], [false, false, true, true]);
});
