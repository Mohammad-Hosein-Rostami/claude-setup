// Tests for the install lock (lockInstall in scripts/install/record.mjs): one install at a time, so two installs started together
// cannot both load the install record and the later save drop the other's backup entries (review RM1-3).
// Exports: none (node:test file). HOME is a temp folder in every case; the installer runs there with --no-plugins --no-tools,
// which needs jq like every install. INSTALL_RACE_ROUNDS sets the rounds of the two-installs race (default 10). The pid 1 and
// link cases need POSIX (pid 1 is a root process another user may not signal; plain symlinks).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeContext } from '../scripts/install/context.mjs';
import { INSTALL_LOCK_NAME, INSTALL_LOCK_STALE_MS, RECORD_NAME, lockInstall } from '../scripts/install/record.mjs';
import { posix } from './disk-clean-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const MINUTE_MS = 60 * 1000;
const REPO = fileURLToPath(new URL('..', import.meta.url));
const INSTALLER = join(REPO, 'scripts', 'install.mjs');
const RACE_ROUNDS = Number(process.env.INSTALL_RACE_ROUNDS ?? 10);

/** A temp HOME with ~/.claude, its install context and the lock path there. */
function setup() {
  const home = makeTempDir('install-lock-');
  const ctx = makeContext({}, REPO, { HOME: home });
  mkdirSync(ctx.claudeDir, { recursive: true });
  return { home, ctx, lock: join(ctx.claudeDir, INSTALL_LOCK_NAME) };
}

/** The pid of a process that has already exited. */
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

const runInstaller = (home, args = ['--no-plugins', '--no-tools']) =>
  spawnSync(process.execPath, [INSTALLER, ...args], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });

test('the lock names its owner; a second take while the owner lives is refused; released, it can be taken again', () => {
  const { ctx, lock } = setup();
  const release = lockInstall(ctx);
  assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
  assert.throws(() => lockInstall(ctx), /another install is running/);
  release();
  assert.equal(existsSync(lock), false);
  lockInstall(ctx)();
});

test('a lock whose owner process is gone is taken over at once', () => {
  const { ctx, lock } = setup();
  writeFileSync(lock, String(deadPid()));
  const release = lockInstall(ctx);
  assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
  release();
});

/** Sets the lock file's age to `minutes`. */
function ageLock(lock, minutes) {
  const when = new Date(Date.now() - minutes * MINUTE_MS);
  utimesSync(lock, when, when);
}

test('a lock whose text is not a pid is kept while young (its owner may be writing) and broken once old', () => {
  const { ctx, lock } = setup();
  writeFileSync(lock, 'not a pid');
  assert.throws(() => lockInstall(ctx), /another install is running/);
  ageLock(lock, 31);
  lockInstall(ctx)();
});

test('the stale limit is 30 minutes (the docs say so): a lock with no owner written yet is kept at 29 and broken at 31', () => {
  assert.equal(INSTALL_LOCK_STALE_MS, 30 * MINUTE_MS);
  const { ctx, lock } = setup();
  writeFileSync(lock, '');
  assert.throws(() => lockInstall(ctx), /another install is running/);
  ageLock(lock, 29);
  assert.throws(() => lockInstall(ctx), /another install is running/);
  ageLock(lock, 31);
  lockInstall(ctx)();
});

test('a lock of a live owner older than the stale limit is broken (a hung install)', () => {
  const { ctx, lock } = setup();
  writeFileSync(lock, String(process.pid));
  ageLock(lock, 31);
  const release = lockInstall(ctx);
  assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
  release();
});

test('a lock that vanishes between the look and the read (its owner released) is taken, not a crash', () => {
  const { ctx, lock } = setup();
  writeFileSync(lock, String(deadPid()));
  const vanishing = (path) => {
    unlinkSync(path);
    throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
  };
  const release = lockInstall(ctx, vanishing);
  assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
  release();
});

test('a read error of the lock other than ENOENT is not hidden', () => {
  const { ctx, lock } = setup();
  writeFileSync(lock, String(deadPid()));
  const denied = () => {
    throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
  };
  assert.throws(() => lockInstall(ctx, denied), { code: 'EACCES' });
});

test('release removes the lock only while it is still this install\'s: a successor\'s lock stays, a missing lock is no error', () => {
  const { ctx, lock } = setup();
  const release = lockInstall(ctx);
  unlinkSync(lock);
  writeFileSync(lock, '1'); // another install took over the lock after the stale limit
  release();
  assert.equal(readFileSync(lock, 'utf8'), '1');
  unlinkSync(lock);
  release();
  assert.equal(existsSync(lock), false);
});

test('a lock held by another user\'s live process (pid 1) is refused', posix, () => {
  const { ctx, lock } = setup();
  writeFileSync(lock, '1');
  assert.throws(() => lockInstall(ctx), /another install is running/);
});

test('a link at the lock path is never followed: refused even when it points at an ended pid', posix, () => {
  const { home, ctx, lock } = setup();
  writeFileSync(join(home, 'elsewhere'), String(deadPid()));
  symlinkSync(join(home, 'elsewhere'), lock, 'file');
  assert.throws(() => lockInstall(ctx), /another install is running/);
});

test('--dry-run on a HOME without ~/.claude makes no ~/.claude and takes no lock', () => {
  const home = makeTempDir('install-lock-dry-');
  const run = runInstaller(home, ['--dry-run', '--no-plugins', '--no-tools']);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(join(home, '.claude')), false);
});

test('the installer refuses to run while another install holds the lock and leaves the record and the lock alone', () => {
  const { home, ctx, lock } = setup();
  const recordFile = join(ctx.claudeDir, RECORD_NAME);
  const recordText = JSON.stringify({ version: 1, repo: REPO, root: REPO, tag: null, firstLayer: null, made: [], backups: [] });
  writeFileSync(recordFile, recordText);
  writeFileSync(lock, String(process.pid));
  const run = runInstaller(home);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /another install is running/);
  assert.equal(readFileSync(recordFile, 'utf8'), recordText);
  assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
  assert.equal(existsSync(join(ctx.claudeDir, 'rules')), false, 'nothing was linked');
});

test('the installer releases the lock after a run that worked and after one that failed', () => {
  const { home, ctx, lock } = setup();
  assert.equal(runInstaller(home).status, 0);
  assert.equal(existsSync(lock), false);
  writeFileSync(join(ctx.claudeDir, RECORD_NAME), 'not json');
  const failed = runInstaller(home);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /is not valid JSON/);
  assert.equal(existsSync(lock), false);
});

test('on a HOME without ~/.claude, install then --uninstall leaves no ~/.claude behind', () => {
  const home = makeTempDir('install-lock-fresh-');
  assert.equal(runInstaller(home).status, 0);
  const uninstall = runInstaller(home, ['--uninstall']);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.equal(existsSync(join(home, '.claude')), false);
});

test('--uninstall takes the same lock: it is refused while an install holds it, and leaves the record and settings.json alone', () => {
  const { home, ctx, lock } = setup();
  assert.equal(runInstaller(home).status, 0);
  const recordText = readFileSync(join(ctx.claudeDir, RECORD_NAME), 'utf8');
  const settingsText = readFileSync(join(ctx.claudeDir, 'settings.json'), 'utf8');
  writeFileSync(lock, String(process.pid));
  const run = runInstaller(home, ['--uninstall']);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /another install is running/);
  assert.equal(readFileSync(join(ctx.claudeDir, RECORD_NAME), 'utf8'), recordText);
  assert.equal(readFileSync(join(ctx.claudeDir, 'settings.json'), 'utf8'), settingsText);
  assert.equal(readFileSync(lock, 'utf8'), String(process.pid), 'the other install\'s lock is not removed');
});

test('--uninstall releases the lock after a run that worked and after one that failed', () => {
  const { home, ctx, lock } = setup();
  writeFileSync(join(ctx.claudeDir, RECORD_NAME), 'not json');
  const failed = runInstaller(home, ['--uninstall']);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /is not valid JSON/);
  assert.equal(existsSync(lock), false);
  unlinkSync(join(ctx.claudeDir, RECORD_NAME));
  assert.equal(runInstaller(home, ['--uninstall']).status, 0);
  assert.equal(existsSync(lock), false);
});

/** Each place under `home` (own path or a backup folder) that holds `relPath` with the file `name` reading `content`. */
function placesOf(home, relPath, name, content) {
  const roots = [home, ...readdirSync(home).filter((entry) => entry.startsWith('.claude-backup-')).map((entry) => join(home, entry))];
  return roots.map((root) => join(root, relPath)).filter((path) => {
    const file = name ? join(path, name) : path;
    return existsSync(file) && readFileSync(file, 'utf8') === content;
  });
}

/** Two installs on one HOME whose record names the owner's folder and script at retired paths; the lost backup records. */
async function raceOnce(round) {
  const home = makeTempDir('install-lock-race-');
  const claudeDir = join(home, '.claude');
  const bin = join(home, '.local', 'bin');
  mkdirSync(join(claudeDir, 'modes'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  const note = `owner note ${round}\n`;
  const script = `#!/bin/sh\necho mine ${round}\n`;
  writeFileSync(join(claudeDir, 'modes', 'my-playbook.md'), note);
  writeFileSync(join(bin, 'ccm'), script);
  symlinkSync(join(home, 'no-such-launcher'), join(bin, 'ccm-old'), 'file');
  const made = [join(claudeDir, 'modes'), join(bin, 'ccm'), join(bin, 'ccm-old')].map((path) => ({ kind: 'link', path }));
  const recordFile = join(claudeDir, RECORD_NAME);
  writeFileSync(recordFile, JSON.stringify({ version: 1, repo: REPO, root: REPO, tag: null, firstLayer: null, made, backups: [] }));
  const start = () =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [INSTALLER, '--no-plugins', '--no-tools'], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: 'ignore' });
      child.on('close', resolve);
    });
  const codes = await Promise.all([start(), start()]);
  const saved = JSON.parse(readFileSync(recordFile, 'utf8'));
  const items = [
    [join('.claude', 'modes'), 'my-playbook.md', note],
    [join('.local', 'bin', 'ccm'), null, script],
  ];
  const lost = items.filter(([relPath, name, content]) => {
    const places = placesOf(home, relPath, name, content);
    if (places.length !== 1) return true;
    return places[0] !== join(home, relPath) && !saved.backups.some((entry) => entry.backup === places[0]);
  });
  return { lost: lost.length, codes };
}

test(`two installs started together on one HOME lose no backup record (${RACE_ROUNDS} rounds)`, async () => {
  let lost = 0;
  for (let round = 1; round <= RACE_ROUNDS; round += 1) {
    const result = await raceOnce(round);
    lost += result.lost;
    assert.ok(result.codes.includes(0), `round ${round}: one install ran (exit codes ${result.codes})`);
  }
  assert.equal(lost, 0, 'owner items backed up but not named by the saved record, or not in exactly one place');
});

/** An install and an --uninstall started together on a HOME that holds the owner's settings.json: the owner's text must survive. */
async function installVersusUninstall(round) {
  const home = makeTempDir('install-lock-uninstall-');
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  const text = `{"owner": "settings ${round}"}\n`;
  writeFileSync(join(claudeDir, 'settings.json'), text);
  assert.equal(runInstaller(home).status, 0);
  const start = (args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [INSTALLER, ...args], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: 'ignore' });
      child.on('close', resolve);
    });
  await Promise.all([start(['--no-plugins', '--no-tools']), start(['--uninstall'])]);
  const recordFile = join(claudeDir, RECORD_NAME);
  const kept = existsSync(recordFile) ? JSON.parse(readFileSync(recordFile, 'utf8')).backups.filter((entry) => !entry.ours).map((entry) => entry.backup) : [];
  const places = [join(claudeDir, 'settings.json'), ...kept];
  return places.some((path) => existsSync(path) && readFileSync(path, 'utf8') === text);
}

test(`an install and an --uninstall started together never delete the owner's settings.json (${RACE_ROUNDS} rounds)`, async () => {
  let lost = 0;
  for (let round = 1; round <= RACE_ROUNDS; round += 1) if (!(await installVersusUninstall(round))) lost += 1;
  assert.equal(lost, 0, 'rounds where the owner\'s settings text was in no restored file and in no kept backup');
});
