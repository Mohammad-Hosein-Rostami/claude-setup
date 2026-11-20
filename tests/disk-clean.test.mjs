// Tests for home/tools/disk-free/disk-clean.mjs and its lib: each rule removes what it should and keeps the current session, recent
// sessions, symlinks and their targets, and everything outside its root. Every test builds a fake world (claude tmp, projects folder,
// temp folder) inside makeTempDir and passes those roots in: the real folders are never read or touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClean } from '../home/tools/disk-free/disk-clean.mjs';
import { removeInside } from '../home/tools/disk-free/lib/safe-remove.mjs';
import { age, CURRENT, folder, NEWEST, NO_TRANSCRIPT_OLD, NO_TRANSCRIPT_RECENT, OLD, posix, RECENT, transcript, world } from './disk-clean-helpers.mjs';

const TOOL = fileURLToPath(new URL('../home/tools/disk-free/disk-clean.mjs', import.meta.url));
const LIB = fileURLToPath(new URL('../home/tools/disk-free/lib/', import.meta.url));

test('session folders: removed when the transcript and the folder are idle for 3 days; kept when either is recent, and when no transcript is known (counted)', async () => {
  const w = world();
  const scratch = (id, days) => folder(join(w.claudeTmp, '-proj', id, 'scratchpad'), { days }) && join(w.claudeTmp, '-proj', id);
  transcript(w, '-proj', OLD, 4);
  transcript(w, '-proj', RECENT, 1);
  transcript(w, '-proj', NEWEST, 0);
  const folders = { old: scratch(OLD, 4), recent: scratch(RECENT, 1), noOld: scratch(NO_TRANSCRIPT_OLD, 4), noRecent: scratch(NO_TRANSCRIPT_RECENT, 1) };
  for (const path of Object.values(folders)) age(path, path === folders.old || path === folders.noOld ? 4 : 1);
  const summary = await runClean(w.options);
  assert.equal(existsSync(folders.old), false);
  assert.equal(existsSync(folders.noOld), true, 'no transcript here: it may be a session of another config dir, so 4 idle days are not enough');
  assert.equal(existsSync(folders.recent), true);
  assert.equal(existsSync(folders.noRecent), true);
  assert.equal(summary.rules.find((rule) => rule.name === 'session-folders').items, 1);
  assert.equal(summary.keptUnknown, 2, 'both folders without a transcript are counted as kept');
  assert.ok(summary.bytes > 0);
});

test('session folders: the current session (given or newest transcript) is kept even when its transcript is old', async () => {
  const w = world();
  transcript(w, '-proj', CURRENT, 9);
  transcript(w, '-proj', NEWEST, 5);
  transcript(w, '-proj', OLD, 20);
  const paths = [CURRENT, NEWEST, OLD].map((id) => folder(join(w.claudeTmp, '-proj', id), { days: 9 }));
  await runClean({ ...w.options, session: CURRENT });
  assert.deepEqual(paths.map(existsSync), [true, true, false], 'current and newest-transcript sessions stay, the older one goes');
});

test('session folders: a folder that is not named like a session id, or is a symlink, is kept and the link target is untouched', posix, async () => {
  const w = world();
  const notSession = folder(join(w.claudeTmp, '-proj', 'tasks'), { days: 30 });
  const victim = folder(join(w.root, 'victim'), { days: 30, files: { 'keep.txt': 'precious' } });
  mkdirSync(join(w.claudeTmp, '-proj'), { recursive: true });
  symlinkSync(victim, join(w.claudeTmp, '-proj', OLD));
  const linkedSlug = join(w.claudeTmp, '-linked');
  symlinkSync(folder(join(w.root, 'elsewhere', OLD), { days: 30 }).replace(`/${OLD}`, ''), linkedSlug);
  await runClean(w.options);
  assert.equal(existsSync(notSession), true);
  assert.equal(readFileSync(join(victim, 'keep.txt'), 'utf8'), 'precious');
  assert.equal(existsSync(join(w.root, 'elsewhere', OLD, 'f.txt')), true, 'a symlinked project folder is not entered');
});

test('test temp: old cs-test-, cs-run- and old-prefix folders go; fresh ones, wrong shapes, files, links and other folders stay', posix, async () => {
  const w = world();
  const old = ['cs-test-x-AbCdEf', 'cs-run-Zz9Zz9', 'advice-home-Ab12Cd', 'git-tidy-QQQQQQ'].map((name) => folder(join(w.tmp, name), { days: 2 }));
  const keep = [
    folder(join(w.tmp, 'cs-test-fresh-AbCdEf'), { days: 0 }),
    folder(join(w.tmp, 'advice-home-Ab12'), { days: 5 }), // not prefix + 6 characters
    folder(join(w.tmp, 'refs-Ab12Cd'), { days: 5 }), // a generic old prefix: not on the list any more
    folder(join(w.tmp, 'my-project'), { days: 5 }),
  ];
  writeFileSync(join(w.tmp, 'advice-home-FileXX'), 'a file, not a folder');
  age(join(w.tmp, 'advice-home-FileXX'), 5);
  const victim = folder(join(w.root, 'victim'), { days: 5, files: { 'keep.txt': 'precious' } });
  symlinkSync(victim, join(w.tmp, 'advice-home-LinkXX'));
  await runClean(w.options);
  assert.deepEqual(old.map(existsSync), [false, false, false, false]);
  assert.deepEqual(keep.map(existsSync), [true, true, true, true]);
  assert.equal(existsSync(join(w.tmp, 'advice-home-FileXX')), true);
  assert.equal(readFileSync(join(victim, 'keep.txt'), 'utf8'), 'precious');
});

test('temp projects: throwaway-path slugs idle for 3 days go; a fresh one, a real project and the current session\'s folder stay', async () => {
  const w = world();
  const slugs = { oldVar: '-private-var-folders-ab-T-x', oldTmp: '-tmp-thing', oldPrivateTmp: '-private-tmp-claude-501-y', fresh: '-private-var-folders-fresh', real: '-Users-me-project', current: '-tmp-current' };
  for (const [key, slug] of Object.entries(slugs)) folder(join(w.projects, slug), { days: key === 'fresh' ? 0 : 10, files: { 'a.jsonl': '{}' } });
  age(join(w.projects, slugs.fresh, 'a.jsonl'), 0);
  folder(join(w.projects, slugs.current, CURRENT), { days: 10 });
  age(join(w.projects, slugs.current), 10);
  await runClean({ ...w.options, session: CURRENT });
  const survivors = Object.fromEntries(Object.entries(slugs).map(([key, slug]) => [key, existsSync(join(w.projects, slug))]));
  assert.deepEqual(survivors, { oldVar: false, oldTmp: false, oldPrivateTmp: false, fresh: true, real: true, current: true });
});

test('hook state: old counters and markers of the hooks go, fresh ones and anything outside the two folders stay', async () => {
  const w = world();
  const file = (path, days) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, '.'); age(path, days); return path; };
  const old = [file(join(w.tmp, 'claude-post-edit', 'budget', 's1--a1'), 5), file(join(w.tmp, 'claude-post-edit', 'lead-bash', 's2'), 5), file(join(w.tmp, 'claude-skill-router', 'prompt', 's3'), 5)];
  const keep = [file(join(w.tmp, 'claude-post-edit', 'budget', 's4--a1'), 0), file(join(w.tmp, 'claude-other', 'budget', 's5'), 5), file(join(w.tmp, 'claude-post-edit', 'loose-file'), 5)];
  await runClean(w.options);
  assert.deepEqual(old.map(existsSync), [false, false, false]);
  assert.deepEqual(keep.map(existsSync), [true, true, true]);
});

test('a dry run removes nothing and reports the same items and bytes the apply run then removes', async () => {
  const w = world();
  const path = folder(join(w.tmp, 'cs-test-dry-AbCdEf'), { days: 3, files: { 'big.bin': 'x'.repeat(20_000) } });
  const dry = await runClean({ ...w.options, apply: false });
  assert.equal(existsSync(path), true);
  assert.equal(dry.items, 1);
  assert.equal(dry.removed, 0);
  assert.ok(dry.bytes >= 20_000, `bytes ${dry.bytes}`);
  const applied = await runClean(w.options);
  assert.equal(applied.items, dry.items);
  assert.equal(applied.bytes, dry.bytes);
  assert.equal(applied.removed, 1);
  assert.equal(existsSync(path), false);
});

test('a missing root is not an error: nothing to clean', async () => {
  const summary = await runClean({ claudeTmp: '/no/such/dir-a', projects: '/no/such/dir-b', tmp: '/no/such/dir-c', nowMs: Date.now(), budgetMs: 1000, apply: true });
  assert.equal(summary.items, 0);
});

test('removeInside refuses the root itself, a path outside it, a symlink and a path whose parent resolves outside', posix, () => {
  const w = world();
  const root = realpathSync(w.tmp); // the tool passes the real path of the root
  const outside = folder(join(w.root, 'outside'), { days: 9 });
  const inside = folder(join(root, 'inside'), { days: 9 });
  symlinkSync(outside, join(root, 'link'));
  symlinkSync(outside, join(root, 'parent-link'));
  assert.throws(() => removeInside(root, root), /not inside/);
  assert.throws(() => removeInside(root, outside), /not inside/);
  assert.throws(() => removeInside(root, join(root, '..', 'outside')), /not inside/);
  assert.throws(() => removeInside(root, join(root, 'link')), /symlink/);
  assert.throws(() => removeInside(root, join(root, 'parent-link', 'f.txt')), /outside|symlink/);
  assert.equal(existsSync(join(outside, 'f.txt')), true);
  removeInside(root, inside);
  assert.equal(existsSync(inside), false);
});

test('the lib reads folders with opendir (one entry at a time), never readdir (the whole listing in memory)', () => {
  for (const name of ['clean-scan.mjs', 'clean-rules.mjs']) assert.doesNotMatch(readFileSync(join(LIB, name), 'utf8'), /\breaddir(Sync)?\b/, name);
});

test('CLI: --json prints one summary line, a dry run is the default, a bad flag exits 2', () => {
  const w = world();
  folder(join(w.tmp, 'cs-test-cli-AbCdEf'), { days: 3 });
  const roots = ['--claude-tmp', w.claudeTmp, '--projects', w.projects, '--tmp', w.tmp];
  const run = spawnSync(process.execPath, [TOOL, '--json', ...roots], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const summary = JSON.parse(run.stdout);
  assert.equal(summary.apply, false);
  assert.equal(summary.items, 1);
  assert.equal(summary.rules['test-temp'].items, 1);
  assert.equal(existsSync(join(w.tmp, 'cs-test-cli-AbCdEf')), true);
  assert.equal(spawnSync(process.execPath, [TOOL, '--bogus'], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [TOOL, '--now', 'soon'], { encoding: 'utf8' }).status, 2);
  const applied = spawnSync(process.execPath, [TOOL, '--apply', ...roots], { encoding: 'utf8', env: { ...process.env, HOME: w.home } }); // HOME: the run lock lives there
  assert.match(applied.stdout, /1 removed/);
  assert.equal(existsSync(join(w.tmp, 'cs-test-cli-AbCdEf')), false);
});

test('CLI --apply: a second run at the same time does nothing; a run lock older than 6 hours is replaced and released', posix, () => {
  const w = world();
  const path = folder(join(w.tmp, 'cs-run-AbCdEf'), { days: 3 });
  mkdirSync(join(w.home, '.claude', 'state'), { recursive: true });
  const lock = join(w.home, '.claude', 'state', 'disk-clean.run.lock');
  writeFileSync(lock, '');
  const args = [TOOL, '--apply', '--claude-tmp', w.claudeTmp, '--projects', w.projects, '--tmp', w.tmp];
  const run = () => spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, HOME: w.home } });
  assert.match(run().stdout, /another run is working/);
  assert.equal(existsSync(path), true);
  age(lock, 7 / 24);
  assert.match(run().stdout, /1 removed/);
  assert.equal(existsSync(lock), false, 'the lock is released when the run ends');
});
