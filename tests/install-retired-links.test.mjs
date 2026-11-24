// Tests for removeRetiredLinks (scripts/install/links.mjs): an install removes the links an older install made for the retired
// session modes (the `modes` folder link, the mode launcher in ~/.local/bin and ~/.claude/bin) and never deletes the owner's files.
// Exports: none (node:test file). HOME is a temp folder in every case; the last case runs the real installer there (--no-plugins
// --no-tools; the repo's own git hooksPath is set to the value it already has), which needs jq like every install. The read-only
// folder case needs POSIX file modes and a user they bind (not root).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeContext } from '../scripts/install/context.mjs';
import { removeRetiredLinks } from '../scripts/install/links.mjs';
import { RECORD_NAME } from '../scripts/install/record.mjs';
import { LINKS } from '../scripts/install.mjs';
import { posix } from './disk-clean-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));

/** A temp HOME with ~/.claude and ~/.local/bin, the context of an install there, and an empty install record. */
function setup(flags = {}) {
  const home = makeTempDir('retired-links-');
  const ctx = makeContext(flags, REPO, { HOME: home });
  mkdirSync(ctx.claudeDir, { recursive: true });
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  const record = { version: 1, repo: REPO, root: REPO, tag: null, firstLayer: null, made: [], backups: [] };
  return { home, ctx, record };
}

/** A symlink at `path` to a new folder outside ~/.claude (the old repo's home/modes stands in for it). */
function linkToFolder(home, path) {
  const target = join(home, 'old-repo-home', `target-of-${path.split(/[\\/]/).pop()}`);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'kept.md'), 'repo file\n');
  symlinkSync(target, path, 'dir');
  return target;
}

const exists = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};
const recordedPaths = (record) => record.made.map((made) => made.path);

test('a recorded modes link and launcher link are removed, dropped from the record, and their targets kept', () => {
  const { home, ctx, record } = setup();
  const modes = join(ctx.claudeDir, 'modes');
  const ccm = join(home, '.local', 'bin', 'ccm');
  const modesTarget = linkToFolder(home, modes);
  writeFileSync(join(home, 'ccm-target'), '#!/bin/sh\n');
  symlinkSync(join(home, 'ccm-target'), ccm, 'file');
  record.made.push({ kind: 'link', path: modes }, { kind: 'link', path: ccm });
  removeRetiredLinks(ctx, record, LINKS);
  assert.equal(exists(modes), false, 'the modes link is gone');
  assert.equal(exists(ccm), false, 'the launcher link is gone');
  assert.deepEqual(recordedPaths(record), [], 'retired entries leave the record');
  assert.equal(readFileSync(join(modesTarget, 'kept.md'), 'utf8'), 'repo file\n', 'what the link pointed at is untouched');
  assert.equal(readFileSync(join(home, 'ccm-target'), 'utf8'), '#!/bin/sh\n');
  assert.deepEqual(record.backups, []);
});

test('a recorded link whose target is gone is still removed', () => {
  const { home, ctx, record } = setup();
  const modes = join(ctx.claudeDir, 'modes');
  symlinkSync(join(home, 'no-such-folder'), modes, 'dir');
  record.made.push({ kind: 'link', path: modes });
  removeRetiredLinks(ctx, record, LINKS);
  assert.equal(exists(modes), false);
  assert.deepEqual(recordedPaths(record), []);
});

test('a real folder where the record names the old modes link is moved to the backup folder, not deleted', () => {
  const { ctx, record } = setup();
  const modes = join(ctx.claudeDir, 'modes');
  mkdirSync(modes);
  writeFileSync(join(modes, 'my-playbook.md'), 'owner note\n');
  record.made.push({ kind: 'link', path: modes });
  removeRetiredLinks(ctx, record, LINKS);
  assert.equal(record.backups.length, 1, 'the folder is recorded as backed up');
  const [saved] = record.backups;
  assert.equal(saved.path, modes);
  assert.equal(saved.ours, false, 'the owner folder is restored by --uninstall, never deleted as the installer\'s own');
  assert.equal(readFileSync(join(saved.backup, 'my-playbook.md'), 'utf8'), 'owner note\n');
  assert.deepEqual(recordedPaths(record), []);
});

test('an own file where the record names the old launcher link is moved to the backup folder, not deleted', () => {
  const { home, ctx, record } = setup();
  const ccm = join(home, '.local', 'bin', 'ccm');
  writeFileSync(ccm, 'my own script\n');
  record.made.push({ kind: 'link', path: ccm });
  removeRetiredLinks(ctx, record, LINKS);
  assert.equal(record.backups.length, 1);
  assert.equal(readFileSync(record.backups[0].backup, 'utf8'), 'my own script\n');
  assert.equal(record.backups[0].ours, false);
});

test('a recorded launcher copy (Windows without Developer Mode) is moved to the backup folder, not deleted', () => {
  const { ctx, record } = setup();
  const copy = join(ctx.claudeDir, 'bin', 'ccm.cmd');
  mkdirSync(join(ctx.claudeDir, 'bin'));
  writeFileSync(copy, '@echo off\n');
  record.made.push({ kind: 'copy', path: copy });
  removeRetiredLinks(ctx, record, LINKS);
  assert.equal(exists(copy), false);
  assert.equal(readFileSync(record.backups[0].backup, 'utf8'), '@echo off\n');
  assert.equal(record.backups[0].ours, true, 'the installer\'s own copy: --uninstall deletes the backup, never restores it');
  assert.deepEqual(recordedPaths(record), []);
});

test('a recorded link the removal cannot delete stays in the record, and a later run retires it', posix, (t) => {
  const { home, ctx, record } = setup();
  const bin = join(home, '.local', 'bin');
  const ccm = join(bin, 'ccm');
  symlinkSync(join(home, 'no-such-launcher'), ccm, 'file');
  record.made.push({ kind: 'link', path: ccm });
  chmodSync(bin, 0o555);
  t.after(() => chmodSync(bin, 0o755));
  assert.throws(() => removeRetiredLinks(ctx, record, LINKS), { code: 'EACCES' });
  assert.deepEqual(recordedPaths(record), [ccm], 'a failed removal keeps its entry');
  chmodSync(bin, 0o755);
  removeRetiredLinks(ctx, record, LINKS);
  assert.equal(exists(ccm), false, 'the next run removes it');
  assert.deepEqual(recordedPaths(record), []);
});

test('kept links, the commands link, settings.json and unrecorded launcher files are not touched', () => {
  const { home, ctx, record } = setup();
  const rules = join(ctx.claudeDir, 'rules');
  const commands = join(ctx.claudeDir, 'commands');
  const settings = join(ctx.claudeDir, 'settings.json');
  const claude = join(home, '.local', 'bin', 'claude');
  linkToFolder(home, rules);
  linkToFolder(home, commands);
  writeFileSync(settings, '{"owner":1}\n');
  writeFileSync(claude, 'claude code\n');
  record.made.push({ kind: 'link', path: rules }, { kind: 'link', path: commands }, { kind: 'file', path: settings }, { kind: 'dir', path: ctx.claudeDir });
  const before = structuredClone(record.made);
  removeRetiredLinks(ctx, record, LINKS);
  assert.ok(lstatSync(rules).isSymbolicLink(), 'a LINKS item stays');
  assert.ok(lstatSync(commands).isSymbolicLink(), 'the commands link stays');
  assert.equal(readFileSync(settings, 'utf8'), '{"owner":1}\n', 'settings.json is never touched');
  assert.equal(readFileSync(claude, 'utf8'), 'claude code\n', 'an unrecorded launcher-folder file is never looked at');
  assert.deepEqual(record.made, before);
  assert.deepEqual(record.backups, []);
});

test('--dry-run removes nothing and keeps the record', () => {
  const { home, ctx, record } = setup({ dryRun: true });
  const modes = join(ctx.claudeDir, 'modes');
  const real = join(home, '.local', 'bin', 'ccm');
  linkToFolder(home, modes);
  writeFileSync(real, 'own\n');
  record.made.push({ kind: 'link', path: modes }, { kind: 'link', path: real });
  removeRetiredLinks(ctx, record, LINKS);
  assert.ok(lstatSync(modes).isSymbolicLink());
  assert.equal(readFileSync(real, 'utf8'), 'own\n');
  assert.equal(record.made.length, 2);
  assert.equal(existsSync(ctx.backupDir), false);
});

test('the installer itself retires the recorded modes, lead rules and launcher links and leaves other files', () => {
  const { home, ctx } = setup();
  const modes = join(ctx.claudeDir, 'modes');
  const leadRules = join(ctx.claudeDir, 'lead-rules.md');
  const ccm = join(home, '.local', 'bin', 'ccm');
  const claude = join(home, '.local', 'bin', 'claude');
  linkToFolder(home, modes);
  symlinkSync(join(home, 'no-such-rules'), leadRules, 'file');
  symlinkSync(join(home, 'no-such-launcher'), ccm, 'file');
  writeFileSync(claude, 'claude code\n');
  const recordFile = join(ctx.claudeDir, RECORD_NAME);
  const made = [{ kind: 'link', path: modes }, { kind: 'link', path: leadRules }, { kind: 'link', path: ccm }];
  writeFileSync(recordFile, JSON.stringify({ version: 1, repo: REPO, root: REPO, tag: null, firstLayer: null, made, backups: [] }));
  const run = spawnSync(process.execPath, [join(REPO, 'scripts', 'install.mjs'), '--no-plugins', '--no-tools'], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(exists(modes), false);
  assert.equal(exists(leadRules), false);
  assert.equal(exists(ccm), false);
  assert.equal(readFileSync(claude, 'utf8'), 'claude code\n');
  assert.ok(lstatSync(join(ctx.claudeDir, 'statusline.mjs')).isSymbolicLink());
  const saved = JSON.parse(readFileSync(recordFile, 'utf8'));
  assert.ok(!saved.made.some((entry) => [modes, leadRules, ccm].includes(entry.path)), 'the saved record no longer names them');
  assert.ok(!readdirSync(home).some((name) => name.startsWith('.claude-backup-')), 'nothing was backed up');
});

test('install then --uninstall: a recorded launcher copy does not come back, the owner\'s folder does', () => {
  const { home, ctx } = setup();
  const bin = join(ctx.claudeDir, 'bin');
  const copy = join(bin, 'ccm.cmd');
  const modes = join(ctx.claudeDir, 'modes');
  mkdirSync(bin);
  writeFileSync(copy, '@echo off\n');
  mkdirSync(modes);
  writeFileSync(join(modes, 'my-playbook.md'), 'owner note\n');
  const made = [{ kind: 'dir', path: bin }, { kind: 'link', path: modes }, { kind: 'copy', path: copy }];
  writeFileSync(join(ctx.claudeDir, RECORD_NAME), JSON.stringify({ version: 1, repo: REPO, root: REPO, tag: null, firstLayer: null, made, backups: [] }));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const installer = join(REPO, 'scripts', 'install.mjs');
  const install = spawnSync(process.execPath, [installer, '--no-plugins', '--no-tools'], { env, encoding: 'utf8' });
  assert.equal(install.status, 0, install.stderr);
  assert.equal(exists(copy), false);
  const uninstall = spawnSync(process.execPath, [installer, '--uninstall'], { env, encoding: 'utf8' });
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.equal(exists(copy), false, 'the installer\'s own copy stays gone');
  assert.equal(exists(bin), false, 'the folder the installer made is removed once empty');
  assert.equal(readFileSync(join(modes, 'my-playbook.md'), 'utf8'), 'owner note\n', 'the owner folder is put back');
});
