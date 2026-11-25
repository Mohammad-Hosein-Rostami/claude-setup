// Tests for the plugin step of the installer (installPlugins and enabledPluginIds in scripts/install/tools.mjs): only the
// plugins the merged settings (base < os < local) turn on are installed, each id is one argument, nothing is uninstalled,
// an unreadable plugins.json or settings file stops the step before any plugin command, and a hostile id is refused.
// Exports: none (node:test file). A fake `claude` on PATH records each call's arguments (and whether the install lock was held)
// as one JSON line; HOME, USERPROFILE and TMPDIR are temp folders in every case. Needs jq, like every install; the fake CLI is
// a script with a shebang, so the cases that run it need POSIX.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InstallError, OS_NAME, makeContext } from '../scripts/install/context.mjs';
import { INSTALL_LOCK_NAME } from '../scripts/install/record.mjs';
import { mergedSettings } from '../scripts/install/settings.mjs';
import { enabledPluginIds, installPlugins } from '../scripts/install/tools.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { cleanEnv } from './clean-env.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const INSTALLER = join(REPO, 'scripts', 'install.mjs');
const posix = { skip: process.platform === 'win32' && 'the fake claude CLI is a shebang script' };
const OFFICIAL = { name: 'claude-plugins-official', source: 'github:anthropics/claude-plugins-official' };
const DIRECTORY = { name: 'anthropic-plugin-directory', source: 'built-in (Anthropic Directory); no add needed' };
const MANIFEST = { marketplaces: [DIRECTORY, OFFICIAL, { name: 'gitkraken', source: 'installed by the GitKraken app', optional: true }] };
const HOSTILE_IDS = ['two words@market', 'x@market;touch pwned', '"quoted"@market', '$(id)@market', 'a@b@c', '--force@market', 'nl\n@market'];

/** A folder with a fake `claude` that appends {argv, locked} to $FAKE_CLAUDE_LOG and exits 0. */
function fakeClaudeBin() {
  const bin = makeTempDir('install-plugins-bin-');
  const script = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    'const locked = Boolean(process.env.FAKE_CLAUDE_LOCK) && fs.existsSync(process.env.FAKE_CLAUDE_LOCK);',
    'fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv: process.argv.slice(2), locked }) + "\\n");',
  ].join('\n');
  writeFileSync(join(bin, 'claude'), `${script}\n`);
  chmodSync(join(bin, 'claude'), 0o755);
  return bin;
}
const FAKE_BIN = process.platform === 'win32' ? '' : fakeClaudeBin();

/** The calls the fake CLI saw: [{argv, locked}]. */
const callsIn = (log) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((row) => JSON.parse(row)) : []);
const installCalls = (calls) => calls.filter(({ argv }) => argv[0] === 'plugin' && argv[1] === 'install');

/**
 * A fake checkout: plugins/plugins.json, settings/base.json, an optional settings/local.json and the real merge program.
 * A string layer is written as it is (an unreadable file); an object as JSON.
 */
function checkout({ base, local, manifest = MANIFEST }) {
  const dir = makeTempDir('install-plugins-repo-');
  for (const sub of ['plugins', 'settings', 'scripts']) mkdirSync(join(dir, sub));
  const write = (path, value) => writeFileSync(join(dir, path), typeof value === 'string' ? value : JSON.stringify(value));
  write('plugins/plugins.json', manifest);
  write('settings/base.json', base);
  if (local !== undefined) write('settings/local.json', local);
  copyFileSync(join(REPO, 'scripts', 'merge-settings.jq'), join(dir, 'scripts', 'merge-settings.jq'));
  return dir;
}

/**
 * Runs installPlugins in this process on a fake checkout, with the fake CLI first on PATH and the console captured.
 * @returns {{ctx: object, calls: object[], out: string, error: unknown}} the context, the CLI calls, all console text, a throw
 */
function runStep(t, layers, { dryRun = false } = {}) {
  const dir = checkout(layers);
  const home = makeTempDir('install-plugins-home-');
  const log = join(home, 'claude-calls.jsonl');
  const ctx = { ...makeContext({ dryRun }, dir, { HOME: home }), os: OS_NAME };
  const savedPath = process.env.PATH;
  process.env.PATH = `${FAKE_BIN}${delimiter}${savedPath}`;
  process.env.FAKE_CLAUDE_LOG = log;
  const lines = [];
  const capture = (...args) => lines.push(args.join(' '));
  t.mock.method(console, 'log', capture);
  t.mock.method(console, 'error', capture);
  let error;
  try {
    installPlugins(ctx);
  } catch (thrown) {
    error = thrown;
  } finally {
    t.mock.restoreAll();
    process.env.PATH = savedPath;
    delete process.env.FAKE_CLAUDE_LOG;
  }
  return { ctx, calls: callsIn(log), out: lines.join('\n'), error };
}

test('enabledPluginIds: only value true counts, in file order; a missing key is none; a non-object stops', () => {
  const settings = { enabledPlugins: { 'b@m': true, 'off@m': false, 'odd@m': 'true', 'a@m': true } };
  assert.deepEqual(enabledPluginIds(settings), { ids: ['b@m', 'a@m'], refused: [] });
  assert.deepEqual(enabledPluginIds({}), { ids: [], refused: [] });
  for (const bad of [null, ['a@m'], 'a@m', 1]) {
    assert.throws(() => enabledPluginIds({ enabledPlugins: bad }), (error) => error instanceof InstallError && /enabledPlugins that is not an object; no plugin was installed/.test(error.message));
  }
});

test('enabledPluginIds: an id with a space, quote, ; or other shell sign is refused by the name check', () => {
  const settings = { enabledPlugins: Object.fromEntries([...HOSTILE_IDS, 'ok-1.x_y@claude-plugins-official'].map((id) => [id, true])) };
  assert.deepEqual(enabledPluginIds(settings), { ids: ['ok-1.x_y@claude-plugins-official'], refused: HOSTILE_IDS });
});

test('only the merged true plugins are installed (local wins over base), each id one argument, only needed marketplaces', posix, (t) => {
  const base = { enabledPlugins: { 'figma@claude-plugins-official': true, 'miro@claude-plugins-official': false, 'context7@anthropic-plugin-directory': true, 'gitkraken-hooks@gitkraken': true } };
  const local = { enabledPlugins: { 'context7@anthropic-plugin-directory': false, 'miro@claude-plugins-official': true } };
  const { ctx, calls, error } = runStep(t, { base, local });
  assert.equal(error, undefined);
  assert.deepEqual(installCalls(calls).map(({ argv }) => argv), [
    ['plugin', 'install', 'figma@claude-plugins-official'],
    ['plugin', 'install', 'miro@claude-plugins-official'],
  ]);
  assert.deepEqual(calls.filter(({ argv }) => argv[1] === 'marketplace' && argv[2] === 'add').map(({ argv }) => argv), [['plugin', 'marketplace', 'add', 'anthropics/claude-plugins-official']]);
  assert.deepEqual(ctx.failures, []);
});

test('plugins that are off are never uninstalled or disabled: the only plugin commands are the help probe, marketplace add and install', posix, (t) => {
  const base = { enabledPlugins: { 'figma@claude-plugins-official': true, 'kotlin-lsp@claude-plugins-official': false } };
  const { calls } = runStep(t, { base });
  const verbs = calls.map(({ argv }) => argv.slice(0, 3).join(' '));
  assert.deepEqual([...new Set(verbs)], ['plugin marketplace --help', 'plugin marketplace add', 'plugin install figma@claude-plugins-official']);
  assert.ok(!calls.some(({ argv }) => argv.includes('kotlin-lsp@claude-plugins-official')), 'the plugin that is off is never named to the CLI');
});

test('no plugin on (empty, all false, or only the GitKraken one): zero CLI calls and one line saying so', posix, (t) => {
  for (const enabledPlugins of [undefined, {}, { 'figma@claude-plugins-official': false, 'miro@claude-plugins-official': false }, { 'gitkraken-hooks@gitkraken': true }]) {
    const { calls, out, error } = runStep(t, { base: enabledPlugins === undefined ? {} : { enabledPlugins } });
    assert.equal(error, undefined);
    assert.deepEqual(calls, [], 'not even the help probe runs');
    assert.equal(out, 'No plugin to install: the merged settings (enabledPlugins) turn none on.');
  }
});

test('a hostile id in local.json is refused, named quoted in the failures, and never reaches the CLI', posix, (t) => {
  const base = { enabledPlugins: { 'figma@claude-plugins-official': true } };
  const local = { enabledPlugins: { 'x@m; touch pwned': true, '"q"@m': true } };
  const { ctx, calls } = runStep(t, { base, local });
  assert.deepEqual(installCalls(calls).map(({ argv }) => argv), [['plugin', 'install', 'figma@claude-plugins-official']]);
  assert.ok(!calls.some(({ argv }) => argv.some((arg) => arg.includes('pwned') || arg.includes('"q"'))));
  assert.deepEqual(ctx.failures, [
    `plugin "x@m; touch pwned" refused: not a name@marketplace id of letters, digits, '.', '_' and '-'`,
    `plugin "\\"q\\"@m" refused: not a name@marketplace id of letters, digits, '.', '_' and '-'`,
  ]);
});

test('an unreadable plugins.json or settings layer stops the step with why, before any CLI call', posix, (t) => {
  const base = { enabledPlugins: { 'figma@claude-plugins-official': true } };
  const cases = [
    [{ base, manifest: '{ not json' }, /plugins\.json cannot be read \(.*\); no plugin was installed/],
    [{ base, manifest: { marketplaces: 'github:x/y' } }, /plugins\.json holds a "marketplaces" that is not a list; no plugin was installed/],
    [{ base, local: '{ not json' }, /jq could not merge .*local\.json/],
    [{ base: { enabledPlugins: ['figma@claude-plugins-official'] } }, /enabledPlugins that is not an object/],
  ];
  for (const [layers, why] of cases) {
    const { calls, error } = runStep(t, layers);
    assert.ok(error instanceof InstallError, `an InstallError, got ${error}`);
    assert.match(error.message, why);
    assert.deepEqual(calls, []);
  }
});

test('--dry-run step: the install lines are printed, not run; only the help probe calls the CLI', posix, (t) => {
  const base = { enabledPlugins: { 'figma@claude-plugins-official': true, 'miro@claude-plugins-official': false } };
  const { calls, out } = runStep(t, { base }, { dryRun: true });
  assert.deepEqual(calls.map(({ argv }) => argv), [['plugin', 'marketplace', '--help']]);
  assert.match(out, /^\[dry-run\] claude plugin install figma@claude-plugins-official$/m);
  assert.doesNotMatch(out, /miro/);
});

/** The repo's merged enabledPlugins split into the ids the installer must install and the ids it must not. */
function repoPluginSplit(home) {
  const merged = mergedSettings({ root: REPO, repo: REPO, os: OS_NAME, claudeDir: join(home, '.claude') }, null);
  const entries = Object.entries(merged.enabledPlugins);
  const on = entries.filter(([id, value]) => value === true && !id.endsWith('@gitkraken')).map(([id]) => id);
  return { on, off: entries.filter(([, value]) => value !== true).map(([id]) => id) };
}

/** Runs the real installer with a temp HOME, USERPROFILE and TMPDIR and the fake CLI first on PATH. */
function runInstaller(args) {
  const home = makeTempDir('install-plugins-run-');
  const log = join(makeTempDir('install-plugins-log-'), 'claude-calls.jsonl');
  const env = cleanEnv({ HOME: home, USERPROFILE: home, TMPDIR: makeTempDir('install-plugins-tmp-'), PATH: `${FAKE_BIN}${delimiter}${process.env.PATH}`, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_LOCK: join(home, '.claude', INSTALL_LOCK_NAME) });
  const run = spawnSync(process.execPath, [INSTALLER, ...args], { env, encoding: 'utf8' });
  return { home, run, calls: callsIn(log) };
}

test('named case: install --dry-run lists claude plugin install only for the merged true plugins, none of the false ones', posix, () => {
  const { home, run, calls } = runInstaller(['--dry-run', '--no-tools']);
  assert.equal(run.status, 0, run.stderr);
  const { on, off } = repoPluginSplit(home);
  assert.ok(on.length > 0 && off.length > 0, 'the repo settings turn some plugins on and some off');
  const listed = [...run.stdout.matchAll(/^\[dry-run\] claude plugin install (\S+)$/gm)].map((match) => match[1]);
  assert.deepEqual(listed, on);
  for (const id of off) assert.ok(!run.stdout.includes(id), `${id} is off and is not named`);
  assert.deepEqual(installCalls(calls), [], 'dry-run runs no install');
  assert.deepEqual(readdirSync(home), [], 'nothing is written under HOME');
});

test('a real install (fake CLI) installs the merged true plugins one argument each, inside the install lock', posix, () => {
  const { home, run, calls } = runInstaller(['--no-tools']);
  assert.equal(run.status, 0, run.stderr);
  const installs = installCalls(calls);
  assert.deepEqual(installs.map(({ argv }) => argv), repoPluginSplit(home).on.map((id) => ['plugin', 'install', id]));
  assert.ok(installs.every(({ locked }) => locked), 'every plugin install runs while the install lock is held');
  assert.equal(existsSync(join(home, '.claude', INSTALL_LOCK_NAME)), false, 'the lock is released at the end');
});

test('Windows: install.ps1 holds no plugin step of its own and runs install.mjs, whose one plugin step is installPlugins', () => {
  const ps1 = readFileSync(join(REPO, 'scripts', 'install.ps1'), 'utf8');
  assert.match(ps1, /Join-Path \$Repo 'scripts\\install\.mjs'/);
  assert.doesNotMatch(ps1, /plugin install|plugins\.json/);
  const mjs = readFileSync(INSTALLER, 'utf8');
  assert.equal(mjs.match(/tools\.installPlugins\(ctx\)/g)?.length, 1);
});
