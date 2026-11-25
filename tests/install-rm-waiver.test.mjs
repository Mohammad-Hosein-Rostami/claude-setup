// Tests for the dangerous-rm waiver of an install (scripts/install/rm-waiver.mjs addRmWaiverLines): which start-up file gets the
// two lines, that a second run adds none, and that --uninstall (scripts/install/uninstall.mjs) takes them out again.
// Exports: none (node:test file). Every case runs the real addRmWaiverLines, record and uninstall on a temp HOME in a cs-test- folder
// with an explicit env (SHELL, ZDOTDIR); nothing touches the real home.
import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeContext } from '../scripts/install/context.mjs';
import { loadRecord, saveRecord } from '../scripts/install/record.mjs';
import { addRmWaiverLines } from '../scripts/install/rm-waiver.mjs';
import { uninstall } from '../scripts/install/uninstall.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const WAIVER_VARIABLE = 'CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS';
const WHY_LINE =
  '# claude-setup: no dangerous-rm prompt in bypass mode; Claude Code reads this variable only at launch, never from settings';
const SH_LINE = `export ${WAIVER_VARIABLE}=1`;
const PS_LINE = `$env:${WAIVER_VARIABLE} = '1'`;
const USER_LINE = 'alias x=y';

// The installer logs every step to the console; a test does not need that output.
afterEach(() => mock.restoreAll());
const silenceConsole = () => mock.method(console, 'log', () => {});

const newHome = () => makeTempDir('rm-waiver-home-');

/** One install step as install.mjs runs it: lock-free, with the record loaded from and saved to ~/.claude like a real run. */
function runInstall(home, { env = {}, psProfile } = {}) {
  silenceConsole();
  const ctx = makeContext(psProfile ? { psProfile } : {}, REPO, { HOME: home, ...env });
  mkdirSync(ctx.claudeDir, { recursive: true });
  const record = loadRecord(ctx);
  addRmWaiverLines(ctx, record);
  saveRecord(ctx, record);
  return ctx;
}

function runUninstall(ctx) {
  silenceConsole();
  uninstall(ctx);
}

const read = (path) => readFileSync(path, 'utf8');
const countOf = (text, line) => text.split(/\r?\n/).filter((row) => row === line).length;

test('zsh with no ~/.zshenv: the file is created with exactly the why-comment and the export line', () => {
  const home = newHome();
  runInstall(home, { env: { SHELL: '/bin/zsh' } });
  assert.equal(read(join(home, '.zshenv')), `${WHY_LINE}\n${SH_LINE}\n`);
});

test('a second run leaves the export line once, and the file as it was', () => {
  const home = newHome();
  const env = { SHELL: '/bin/zsh' };
  runInstall(home, { env });
  const afterFirst = read(join(home, '.zshenv'));
  runInstall(home, { env });
  const text = read(join(home, '.zshenv'));
  assert.equal(countOf(text, SH_LINE), 1);
  assert.equal(countOf(text, WHY_LINE), 1);
  assert.equal(text, afterFirst);
});

test('bash: ~/.bashrc gets the lines and no ~/.zshenv is made', () => {
  const home = newHome();
  runInstall(home, { env: { SHELL: '/bin/bash' } });
  assert.equal(read(join(home, '.bashrc')), `${WHY_LINE}\n${SH_LINE}\n`);
  assert.equal(existsSync(join(home, '.zshenv')), false);
});

test('zsh with ZDOTDIR: the lines go to $ZDOTDIR/.zshenv, not ~/.zshenv', () => {
  const home = newHome();
  const zdotdir = join(home, 'zd');
  runInstall(home, { env: { SHELL: '/bin/zsh', ZDOTDIR: zdotdir } });
  assert.equal(read(join(zdotdir, '.zshenv')), `${WHY_LINE}\n${SH_LINE}\n`);
  assert.equal(existsSync(join(home, '.zshenv')), false);
});

test('a ~/.zshenv whose last line has no newline keeps that line intact and gets the waiver on its own new lines', () => {
  const home = newHome();
  const file = join(home, '.zshenv');
  writeFileSync(file, USER_LINE);
  runInstall(home, { env: { SHELL: '/bin/zsh' } });
  assert.equal(read(file), `${USER_LINE}\n${WHY_LINE}\n${SH_LINE}\n`);
});

test('a PowerShell profile gets the $env: line once, in a profile folder the install made', () => {
  const home = newHome();
  const profile = join(home, 'Documents', 'PowerShell', 'profile.ps1');
  const options = { env: { SHELL: '/usr/bin/fish' }, psProfile: profile };
  runInstall(home, options);
  runInstall(home, options);
  const text = read(profile);
  assert.equal(countOf(text, PS_LINE), 1);
  assert.equal(text, `${WHY_LINE}\n${PS_LINE}\n`);
});

test('fish: no shell start-up file is written', () => {
  const home = newHome();
  runInstall(home, { env: { SHELL: '/usr/bin/fish' } });
  for (const name of ['.zshenv', '.bashrc', '.zshrc', '.profile', '.bash_profile']) {
    assert.equal(existsSync(join(home, name)), false, name);
  }
});

test('uninstall removes a start-up file the install created', () => {
  const home = newHome();
  const ctx = runInstall(home, { env: { SHELL: '/bin/zsh' } });
  assert.equal(existsSync(join(home, '.zshenv')), true, 'precondition: the install wrote it');
  runUninstall(ctx);
  assert.equal(existsSync(join(home, '.zshenv')), false);
});

// Lines, not bytes: the install adds a newline after the user's last line and removeLine does not take it away again.
test('uninstall leaves the user\'s own line in a start-up file the install appended to, and no waiver line', () => {
  const home = newHome();
  const file = join(home, '.zshenv');
  writeFileSync(file, USER_LINE);
  const ctx = runInstall(home, { env: { SHELL: '/bin/zsh' } });
  runUninstall(ctx);
  assert.deepEqual(read(file).split(/\r?\n/).filter(Boolean), [USER_LINE]);
});

test('uninstall removes the PowerShell profile and the folders the install made for it', () => {
  const home = newHome();
  const profileDir = join(home, 'Documents', 'PowerShell');
  const profile = join(profileDir, 'profile.ps1');
  const ctx = runInstall(home, { env: { SHELL: '/usr/bin/fish' }, psProfile: profile });
  assert.equal(existsSync(profile), true, 'precondition: the install wrote it');
  runUninstall(ctx);
  assert.equal(existsSync(profile), false);
  assert.equal(existsSync(dirname(profileDir)), false, 'the folders the install made are gone');
});
