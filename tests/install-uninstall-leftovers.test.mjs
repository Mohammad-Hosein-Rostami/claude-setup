// Tests for the leftover list of `install --uninstall` (scripts/install/uninstall.mjs, audit H19): what the uninstall leaves in
// place (a link the owner replaced, a backup whose path exists again) is listed at its end, and a clean undo says nothing is left.
// Exports: none (node:test file). The real installer runs with HOME set to a temp folder (a space in its path) and
// --no-plugins --no-tools (the repo's own git hooksPath is set to the value it already has), which needs jq like every install.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { cleanEnv } from './clean-env.mjs';

const INSTALLER = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));

function run(home, args) {
  return spawnSync(process.execPath, [INSTALLER, ...args], { env: cleanEnv({ HOME: home, USERPROFILE: home }), encoding: 'utf8' });
}

/** The list lines right under the "Left in place" header of an uninstall's output (the run summary follows after a blank line). */
function leftLines(stdout) {
  const lines = stdout.split('\n');
  const start = lines.findIndex((line) => line.startsWith('Left in place'));
  const after = lines.slice(start + 1);
  const end = after.findIndex((line) => !line.startsWith('  - '));
  return after.slice(0, end === -1 ? after.length : end);
}

test('--uninstall lists the link the owner replaced and the backup whose path exists again', () => {
  const home = makeTempDir('uninstall left ');
  const skills = join(home, '.claude', 'skills');
  mkdirSync(skills, { recursive: true });
  writeFileSync(join(skills, 'mine.md'), 'owner skill\n');
  assert.equal(run(home, ['--no-plugins', '--no-tools']).status, 0);
  const backups = readdirSync(home).filter((name) => name.startsWith('.claude-backup-'));
  assert.equal(backups.length, 1, 'the owner\'s skills folder was backed up');
  const saved = join(home, backups[0], '.claude', 'skills');
  rmSync(skills); // the installer's link
  mkdirSync(skills);
  writeFileSync(join(skills, 'new.md'), 'made after the install\n');
  const undo = run(home, ['--uninstall']);
  assert.equal(undo.status, 0, undo.stderr);
  assert.match(undo.stdout, /^Left in place \(2; remove or restore by hand\):$/m);
  assert.deepEqual(leftLines(undo.stdout), [
    `  - ${skills} is no longer the link the installer made; left as it is`,
    `  - ${skills} exists again; its backup stays at ${saved}`,
  ]);
  assert.equal(existsSync(join(saved, 'mine.md')), true, 'the backup is kept');
});

test('a clean --uninstall says nothing is left', () => {
  const home = makeTempDir('uninstall clean ');
  assert.equal(run(home, ['--no-plugins', '--no-tools']).status, 0);
  const undo = run(home, ['--uninstall']);
  assert.equal(undo.status, 0, undo.stderr);
  assert.match(undo.stdout, /^Left in place: nothing the install record names$/m);
  assert.deepEqual(leftLines(undo.stdout), []);
});
