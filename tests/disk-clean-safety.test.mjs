// Safety tests for disk-clean, the scan side: a session resumed or running during the run keeps its folder (also when it is registered only after
// the scan), the age limits hold at their boundaries, the registry and transcripts folders must be known, and the scan limits make the totals
// partial. The removal side (roots, owners, swaps, rename aside) is in tests/disk-clean-removal.test.mjs. Fake roots only (tests/disk-clean-helpers.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClean } from '../home/tools/disk-free/disk-clean.mjs';
import { claudeSessionRoot } from '../home/tools/disk-free/disk-free.mjs';
import { rulesFor } from '../home/tools/disk-free/lib/clean-rules.mjs';
import { liveSessionIds } from '../home/tools/disk-free/lib/live-sessions.mjs';
import { touchedSince, treeBytes, walkTree } from '../home/tools/disk-free/lib/clean-scan.mjs';
import { OLD_TEST_PREFIXES } from '../home/tools/disk-free/lib/test-temp-prefixes.mjs';
import { age, CURRENT, folder, NEWEST, OLD, OTHER, posix, sessionFile, sessionFolder, transcript, world } from './disk-clean-helpers.mjs';

const TOOL = fileURLToPath(new URL('../home/tools/disk-free/disk-clean.mjs', import.meta.url));

test('a session resumed during the run (its transcript written after the scan) keeps its folder', async () => {
  const w = world();
  const file = transcript(w, '-proj', OLD, 10);
  transcript(w, '-proj', NEWEST, 0);
  const path = sessionFolder(w, OLD, 10);
  const summary = await runClean({ ...w.options, beforeRemove: () => age(file, 0) }); // the resume: the transcript is written after the scan found the folder idle
  assert.equal(existsSync(path), true);
  assert.equal(summary.removed, 0);
  assert.equal(summary.changed, 1);
});

test('a folder written to during the run is kept although its transcript stays old (folder idle is required too)', async () => {
  const w = world();
  transcript(w, '-proj', OLD, 10);
  transcript(w, '-proj', NEWEST, 0);
  const path = sessionFolder(w, OLD, 10);
  const summary = await runClean({ ...w.options, beforeRemove: () => writeFileSync(join(path, 'fresh.txt'), 'x') });
  assert.equal(existsSync(path), true);
  assert.equal(summary.changed, 1);
});

test('a session whose process is alive keeps its folder; one whose process is gone loses it', async () => {
  const w = world();
  const deadPid = spawnSync(process.execPath, ['-e', '0']).pid; // exited: the pid is free
  for (const id of [OLD, OTHER]) transcript(w, '-proj', id, 10);
  transcript(w, '-proj', NEWEST, 0);
  const alive = sessionFolder(w, OLD, 10);
  const gone = sessionFolder(w, OTHER, 10);
  sessionFile(w, process.pid, OLD);
  sessionFile(w, deadPid, OTHER);
  await runClean(w.options);
  assert.deepEqual([existsSync(alive), existsSync(gone)], [true, false]);
});

test('a running session keeps its throwaway-project folder, also when it has no folder of that id there', async () => {
  const w = world();
  folder(join(w.projects, '-tmp-live'), { days: 10, files: { [`${OLD}.jsonl`]: '{}' } });
  folder(join(w.projects, '-tmp-gone'), { days: 10, files: { [`${OTHER}.jsonl`]: '{}' } });
  sessionFile(w, process.pid, OLD);
  await runClean(w.options);
  assert.deepEqual([existsSync(join(w.projects, '-tmp-live')), existsSync(join(w.projects, '-tmp-gone'))], [true, false]);
});

test('a session folder with a recent file deep inside is kept; the same folder idle goes (touchedSince looks at every entry and every level)', async () => {
  const w = world();
  transcript(w, '-proj', NEWEST, 0);
  for (const id of [OLD, OTHER]) transcript(w, '-proj', id, 10);
  const deep = sessionFolder(w, OLD, 10);
  const idle = sessionFolder(w, OTHER, 10);
  mkdirSync(join(deep, 'a', 'b'), { recursive: true });
  writeFileSync(join(deep, 'a', 'b', 'new.txt'), 'x'); // new, while every folder keeps its old time
  for (const dir of [join(deep, 'a', 'b'), join(deep, 'a'), deep]) age(dir, 10);
  await runClean(w.options);
  assert.deepEqual([existsSync(deep), existsSync(idle)], [true, false]);
});

test('touchedSince: a recent entry in the folder, a gone folder and a walk cut short all count as busy; an idle tree does not', async () => {
  const w = world();
  const idle = folder(join(w.root, 'idle'), { days: 9, files: { a: '1', b: '2', c: '3' } });
  const cutoff = Date.now() - 3 * 86_400_000;
  assert.equal(await touchedSince(idle, cutoff), false);
  writeFileSync(join(idle, 'd'), 'new');
  age(idle, 9);
  assert.equal(await touchedSince(idle, cutoff), true, 'a new entry in a folder with an old time');
  assert.equal(await touchedSince(join(w.root, 'gone'), cutoff), true);
  assert.equal(await touchedSince(folder(join(w.root, 'wide'), { days: 9, files: { a: '1', b: '2', c: '3', d: '4' } }), cutoff, { maxEntries: 2 }), true, 'more entries than the cap');
});

test('walkTree stops at its depth cap and says so; treeBytes does not follow links', posix, async () => {
  const w = world();
  folder(join(w.root, 'deep', 'a', 'b', 'c'), { days: 1 });
  const outcome = {};
  for await (const info of walkTree(join(w.root, 'deep'), { maxDepth: 2 }, outcome)) assert.ok(info);
  assert.equal(outcome.cutShort, true);
  const big = folder(join(w.root, 'big'), { files: { 'big.bin': 'x'.repeat(200_000) } });
  const withLink = folder(join(w.root, 'with-link'));
  symlinkSync(big, join(withLink, 'link'));
  const { bytes, complete } = await treeBytes(withLink, Date.now() + 5000);
  assert.ok(complete && bytes < 100_000, `bytes ${bytes}`);
});

test('age boundaries: 2.5 days is kept and 3.5 days goes for sessions, throwaway projects and hook counters; 0.5 and 1.5 days for test temp', async () => {
  const w = world();
  transcript(w, '-proj', NEWEST, 0);
  transcript(w, '-proj', OLD, 3.5);
  transcript(w, '-proj', OTHER, 2.5);
  const sessions = [sessionFolder(w, OLD, 3.5), sessionFolder(w, OTHER, 2.5)];
  const projects = [folder(join(w.projects, '-tmp-old'), { days: 3.5 }), folder(join(w.projects, '-tmp-young'), { days: 2.5 })];
  const file = (name, days) => { mkdirSync(join(w.tmp, 'claude-post-edit', 'budget'), { recursive: true }); writeFileSync(join(w.tmp, 'claude-post-edit', 'budget', name), '.'); age(join(w.tmp, 'claude-post-edit', 'budget', name), days); return join(w.tmp, 'claude-post-edit', 'budget', name); };
  const hooks = [file('old', 3.5), file('young', 2.5)];
  const tests = [folder(join(w.tmp, 'cs-run-OldOld'), { days: 1.5 }), folder(join(w.tmp, 'cs-run-Young1'), { days: 0.5 })];
  await runClean(w.options);
  for (const [oldOne, youngOne] of [sessions, projects, hooks, tests]) assert.deepEqual([existsSync(oldOne), existsSync(youngOne)], [false, true], oldOne);
});

test('slug anchor: only a slug that STARTS with a temp path is a throwaway project', async () => {
  const w = world();
  const inside = ['-Users-me-private-tmp-x', '-Users-me-tmp-thing', '-home-me-private-var-folders-a'].map((slug) => folder(join(w.projects, slug), { days: 10 }));
  await runClean(w.options);
  assert.deepEqual(inside.map(existsSync), [true, true, true]);
});

test('test temp names: prefix plus exactly 6 characters; a longer or shorter name, a generic old prefix and a bare cs- name stay', async () => {
  const w = world();
  const keep = ['cs-run-AbCdEfG', 'cs-run-AbCdE', 'cs-test-abc', 'cs-other-AbCdEf', 'git-tidy-QQQQQQQ', 'status-report', 'lock-abcdef'].map((name) => folder(join(w.tmp, name), { days: 3 }));
  const go = ['cs-test-AbCdEf', 'cs-test-label-AbCdEf', 'cs-run-AbCdEf'].map((name) => folder(join(w.tmp, name), { days: 3 }));
  await runClean(w.options);
  assert.deepEqual([keep.map(existsSync), go.map(existsSync)], [keep.map(() => true), go.map(() => false)]);
});

test('the old prefix list has no generic names: two or more words, at least 8 characters, no repeats', () => {
  for (const prefix of OLD_TEST_PREFIXES) assert.match(prefix, /^[a-z0-9]+(?:-[a-z0-9]+)+-$/, prefix);
  for (const prefix of OLD_TEST_PREFIXES) assert.ok(prefix.length >= 8, `${prefix} is too short`);
  for (const generic of ['refs-', 'lock-', 'log-', 'hint-', 'perm-', 'steps-', 'resp-', 'status-', 'recall-']) assert.ok(!OLD_TEST_PREFIXES.includes(generic), generic);
  assert.equal(new Set(OLD_TEST_PREFIXES).size, OLD_TEST_PREFIXES.length);
});

test('hook state: a symlinked state folder, a symlinked kind folder and a folder inside a kind folder are never entered or removed', posix, async () => {
  const w = world();
  const elsewhere = folder(join(w.root, 'elsewhere', 'budget'), { days: 10 });
  symlinkSync(join(w.root, 'elsewhere'), join(w.tmp, 'claude-post-edit'));
  mkdirSync(join(w.tmp, 'claude-skill-router'), { recursive: true });
  symlinkSync(join(w.root, 'elsewhere', 'budget'), join(w.tmp, 'claude-skill-router', 'linked-kind'));
  folder(join(w.tmp, 'claude-skill-router', 'real-kind', 'old-folder'), { days: 10 });
  age(join(w.tmp, 'claude-skill-router', 'real-kind'), 10);
  const summary = await runClean(w.options);
  assert.equal(existsSync(join(elsewhere, 'f.txt')), true);
  assert.equal(existsSync(join(w.tmp, 'claude-skill-router', 'real-kind', 'old-folder')), true);
  assert.deepEqual([summary.rules.find((rule) => rule.name === 'hook-state').items, summary.failed.length], [0, 0], 'nothing was even found, so nothing was tried');
});

test('a dry run is partial when the size measuring ran out of time, and when the scan time is over before anything was looked at', async () => {
  const w = world();
  for (const name of ['cs-run-AaAaAa', 'cs-run-BbBbBb']) folder(join(w.tmp, name), { days: 3 });
  const measured = await runClean({ ...w.options, apply: false, budgetMs: -1 });
  assert.deepEqual([measured.items, measured.partial], [2, true]);
  const stopped = await runClean({ ...w.options, apply: false, scanMs: -1 });
  assert.deepEqual([stopped.items, stopped.partial], [0, true], 'the deadline is checked inside the rule loops');
  const whole = await runClean({ ...w.options, apply: false });
  assert.deepEqual([whole.items, whole.partial], [2, false]);
});

test('CLI: the running session id from CLAUDE_CODE_SESSION_ID (or the older CLAUDE_SESSION_ID) is never removed', async () => {
  for (const variable of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID']) {
    const w = world();
    transcript(w, '-proj', CURRENT, 20);
    transcript(w, '-proj', NEWEST, 0);
    const mine = sessionFolder(w, CURRENT, 20);
    const roots = ['--claude-tmp', w.claudeTmp, '--projects', w.projects, '--tmp', w.tmp, '--sessions', w.sessions];
    const env = { ...process.env, HOME: w.home, CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '', [variable]: CURRENT };
    assert.equal(spawnSync(process.execPath, [TOOL, '--apply', ...roots], { env, encoding: 'utf8' }).status, 0);
    assert.equal(existsSync(mine), true, variable);
  }
});

test('a rule stops reading at the scan deadline (a limit that says time is up after 3 looks)', async () => {
  const w = world();
  for (let i = 0; i < 30; i += 1) folder(join(w.tmp, `cs-run-Fr${String(i).padStart(4, '0')}`), { days: 3 });
  let looks = 0;
  const context = { ...w.options, refused: [], timeUp: () => (looks += 1) > 3 };
  const testTempRule = rulesFor().find((rule) => rule.name === 'test-temp');
  const yielded = [];
  for await (const item of testTempRule.find(context)) yielded.push(item);
  assert.equal(yielded.length, 3, 'the rule stops at the first entry after the deadline');
});

test('an error on one item is listed and the run goes on with the next items', async () => {
  const w = world();
  const paths = ['cs-run-AaAaAa', 'cs-run-BbBbBb', 'cs-run-CcCcCc'].map((name) => folder(join(w.tmp, name), { days: 3 }));
  let calls = 0;
  const summary = await runClean({ ...w.options, beforeRemove: () => { if ((calls += 1) === 1) throw new Error('boom'); } });
  assert.deepEqual([summary.failed.length, summary.removed, paths.filter(existsSync).length], [1, 2, 1]);
});

test('a session registered as running after the scan (not before it) keeps its folder: the registry is read again before the removal', async () => {
  const w = world();
  transcript(w, '-proj', OLD, 10);
  transcript(w, '-proj', NEWEST, 0);
  const path = sessionFolder(w, OLD, 10);
  const summary = await runClean({ ...w.options, beforeRemove: () => sessionFile(w, process.pid, OLD) });
  assert.deepEqual([existsSync(path), summary.removed, summary.changed], [true, 0, 1]);
});

test('session folders are kept when the transcripts folder or the sessions registry is missing, relative, a file or unset; the reason is listed', async () => {
  const notAFolder = join(world().root, 'a-file');
  writeFileSync(notAFolder, 'x');
  for (const missing of [{ projects: join(notAFolder, '..', 'none') }, { sessions: join(notAFolder, '..', 'none') }, { sessions: 'relative/sessions' }, { sessions: 'tests' },  { projects: undefined }, { sessions: undefined }, { sessions: notAFolder }]) {
    const w = world();
    transcript(w, '-proj', NEWEST, 0);
    transcript(w, '-proj', OLD, 31); // idle by both rules: with its transcript (the registry cases) and without one (the transcripts folder cases, 30 days)
    const path = sessionFolder(w, OLD, 31);
    const summary = await runClean({ ...w.options, ...missing });
    assert.deepEqual([existsSync(path), summary.removed, summary.refused.length >= 1], [true, 0, true], JSON.stringify(missing));
  }
});

test('an empty or relative home folder makes every rule refuse its root: nothing is removed', async () => {
  for (const home of ['', 'relative-home']) {
    const w = world();
    transcript(w, '-proj', NEWEST, 0);
    transcript(w, '-proj', OLD, 10);
    const session = sessionFolder(w, OLD, 10);
    const testTemp = folder(join(w.tmp, 'cs-run-AbCdEf'), { days: 3 });
    const summary = await runClean({ ...w.options, home });
    assert.deepEqual([existsSync(session), existsSync(testTemp), summary.removed, summary.refused.length], [true, true, 0, 4], JSON.stringify(home));
  }
});

test('CLI: HOME empty or CLAUDE_CONFIG_DIR set means no session folder is removed (the default transcripts and registry are not where Claude Code keeps them)', posix, () => {
  const w = world();
  const defaults = { projects: join(w.home, '.claude', 'projects') }; // the CLI is given no --projects: it reads the default folder of HOME
  transcript(defaults, '-proj', NEWEST, 0);
  transcript(defaults, '-proj', OLD, 10);
  const path = sessionFolder(w, OLD, 10);
  mkdirSync(join(w.home, '.claude', 'sessions'), { recursive: true });
  const args = [TOOL, '--apply', '--claude-tmp', w.claudeTmp, '--tmp', w.tmp];
  const withEnv = (env) => spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: '', HOME: w.home, ...env } });
  assert.match(withEnv({ HOME: '' }).stdout, /nothing done/);
  assert.match(withEnv({ CLAUDE_CONFIG_DIR: join(w.root, 'elsewhere') }).stdout, /SKIPPED/);
  assert.equal(existsSync(path), true);
  assert.match(withEnv({}).stdout, /1 removed/, 'with neither set, the same folder goes (the default folders are used)');
});

test('the session registry: a symlink, a FIFO and a file over 64 KiB named *.json are not read through or waited on; a plain file of a live pid counts', posix, async () => {
  const w = world();
  const real = join(w.root, 'real.json');
  writeFileSync(real, JSON.stringify({ pid: process.pid, sessionId: OLD }));
  symlinkSync(real, join(w.sessions, 'link.json'));
  assert.equal(spawnSync('mkfifo', [join(w.sessions, 'fifo.json')]).status, 0);
  writeFileSync(join(w.sessions, 'big.json'), `${JSON.stringify({ pid: process.pid, sessionId: OTHER })}${' '.repeat(70_000)}`); // valid JSON in its first 64 KiB, so only the size limit refuses it
  assert.deepEqual([...(await liveSessionIds(w.sessions))], [], 'none of them counts');
  sessionFile(w, process.pid, CURRENT);
  assert.deepEqual([...(await liveSessionIds(w.sessions))], [CURRENT]);
});

test('Windows root name: no uid means Claude Code\'s claude-0 under \\tmp, never a made-up name; DISK_FREE_CLAUDE_TMP replaces it', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const getuid = process.getuid;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  process.getuid = undefined;
  try {
    assert.equal(claudeSessionRoot({}), '/tmp/claude-0');
    assert.equal(claudeSessionRoot({ DISK_FREE_CLAUDE_TMP: join(tmpdir(), 'x') }), join(tmpdir(), 'x'));
  } finally {
    Object.defineProperty(process, 'platform', platform);
    process.getuid = getuid;
  }
});

test('the session registry: pid 1 (alive, not ours) counts as running; a pid of 0, below 0, a fraction or a string never does', posix, async () => {
  const w = world();
  sessionFile(w, 1, OLD);
  assert.deepEqual([...(await liveSessionIds(w.sessions))], [OLD]);
  for (const pid of [0, -1, 1.5, '1']) writeFileSync(join(w.sessions, `bad-${pid}.json`), JSON.stringify({ pid, sessionId: OTHER }));
  assert.deepEqual([...(await liveSessionIds(w.sessions))], [OLD]);
});

test('touchedSince: a folder that cannot be opened counts as busy', posix, async () => {
  const w = world();
  const locked = folder(join(w.root, 'locked'), { days: 9 });
  chmodSync(locked, 0o000);
  try {
    assert.equal(await touchedSince(locked, Date.now() - 3 * 86_400_000), process.getuid?.() === 0 ? false : true);
  } finally {
    chmodSync(locked, 0o755);
  }
});
