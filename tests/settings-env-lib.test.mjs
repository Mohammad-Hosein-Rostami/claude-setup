// Tests for home/hooks/lib/settings-env.mjs: possibleEnvs(env, cwd) (the hook env, then one layered env per start folder: the user
// file, the shared project file, the local files of the start folder, its git root and a linked worktree's main checkout, a later one
// winning; the first file that exists but cannot be read) and envValue(name, env) (the hook env, else the user file only). Every test
// writes its settings into fresh temp folders, never the real ~/.claude; each folder is new, so the per-run read cache never mixes tests.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { envValue, possibleEnvs } from '../home/hooks/lib/settings-env.mjs';
import { linkedWorktree, localFile, sharedFile, writeSettings } from './settings-env-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const SETTINGS_FILE = 'settings.json';
const NAME = 'SETTINGS_ENV_TEST_VALUE';
const OTHER = 'SETTINGS_ENV_TEST_OTHER';

/** A hook env with a fresh config dir and project folder (no HOME: only CLAUDE_CONFIG_DIR names the user file). */
function setup(extra = {}) {
  const configDir = makeTempDir('settings-env-lib-config-');
  const project = makeTempDir('settings-env-lib-proj-');
  return { configDir, project, userFile: join(configDir, SETTINGS_FILE), env: { CLAUDE_CONFIG_DIR: configDir, CLAUDE_PROJECT_DIR: project, ...extra } };
}

test('possibleEnvs: with no settings files the hook env alone, and nothing unreadable', () => {
  const { env, project } = setup();
  const result = possibleEnvs(env, project);
  assert.deepEqual(result, { envs: [env], unreadableFile: null });
  assert.equal(result.envs[0], env, 'the hook env itself, first');
});

test('possibleEnvs: user, shared and local files are layered over the hook env, a later file winning', () => {
  const s = setup({ [NAME]: 'hook', KEEP: 'hook' });
  writeSettings(s.userFile, { env: { [NAME]: 'user', A: 'user', B: 'user' } });
  writeSettings(sharedFile(s.project), { env: { B: 'shared', C: 'shared' } });
  writeSettings(localFile(s.project), { env: { C: 'local' } });
  const { envs, unreadableFile } = possibleEnvs(s.env, s.project);
  assert.equal(unreadableFile, null);
  assert.equal(envs[0][NAME], 'hook', 'the hook env stays as it was');
  assert.deepEqual(envs[1], { ...s.env, [NAME]: 'user', KEEP: 'hook', A: 'user', B: 'shared', C: 'local' });
});

test('possibleEnvs: a shared Fable value is overridden by a local non-Fable one in the layered env', () => {
  const s = setup();
  writeSettings(sharedFile(s.project), { env: { [NAME]: 'claude-fable-1' } });
  writeSettings(localFile(s.project), { env: { [NAME]: 'claude-opus-5-5' } });
  assert.deepEqual(possibleEnvs(s.env, s.project).envs.map((env) => env[NAME]), [undefined, 'claude-opus-5-5', 'claude-opus-5-5']);
});

test("possibleEnvs: from a linked worktree the main checkout's local file wins over the worktree's own", () => {
  const { main, worktree } = linkedWorktree();
  const s = setup({ CLAUDE_PROJECT_DIR: worktree });
  writeSettings(localFile(worktree), { env: { [NAME]: 'worktree', [OTHER]: 'worktree' } });
  writeSettings(localFile(main), { env: { [NAME]: 'main' } });
  writeSettings(sharedFile(main), { env: { SHARED_OF_MAIN: 'read' } }); // the shared file is read from the start folder only
  const layered = possibleEnvs(s.env, worktree).envs[1];
  assert.deepEqual([layered[NAME], layered[OTHER], layered.SHARED_OF_MAIN], ['main', 'worktree', undefined]);
});

test('possibleEnvs: one layered env per start folder, CLAUDE_PROJECT_DIR then the cwd', () => {
  const s = setup();
  const cwd = makeTempDir('settings-env-lib-cwd-');
  writeSettings(sharedFile(s.project), { env: { [NAME]: 'project' } });
  writeSettings(sharedFile(cwd), { env: { [NAME]: 'cwd' } });
  assert.deepEqual(possibleEnvs(s.env, cwd).envs.map((env) => env[NAME]), [undefined, 'project', 'cwd']);
});

test('possibleEnvs: numbers and booleans become text, as Claude Code copies them into the environment', () => {
  const s = setup();
  writeSettings(s.userFile, { env: { N: 1, Z: 0, T: true, F: false, S: ' text ' } });
  const layered = possibleEnvs(s.env, s.project).envs[1];
  assert.deepEqual([layered.N, layered.Z, layered.T, layered.F, layered.S], ['1', '0', 'true', 'false', ' text ']);
});

test('possibleEnvs: the first file that exists but cannot be read is named, and the hook env stands alone', () => {
  const s = setup();
  writeSettings(s.userFile, { env: { [NAME]: 'user' } });
  writeSettings(sharedFile(s.project), '{"env": ');
  writeSettings(localFile(s.project), 'null');
  assert.deepEqual(possibleEnvs(s.env, s.project), { envs: [s.env], unreadableFile: sharedFile(s.project) });
});

test('possibleEnvs: a file where a .claude folder should be is missing, not unreadable', () => {
  const s = setup();
  const configAsFile = join(makeTempDir('settings-env-lib-file-'), 'config');
  writeFileSync(configAsFile, 'x');
  writeFileSync(join(s.project, '.claude'), 'x');
  const env = { ...s.env, CLAUDE_CONFIG_DIR: configAsFile };
  assert.deepEqual(possibleEnvs(env, s.project), { envs: [env], unreadableFile: null });
});

test('possibleEnvs: a cwd that is not text or is missing never throws; CLAUDE_PROJECT_DIR, else the user file, still counts', () => {
  const s = setup();
  writeSettings(sharedFile(s.project), { env: { [NAME]: 'project' } });
  const noProject = setup({ CLAUDE_PROJECT_DIR: undefined });
  writeSettings(noProject.userFile, { env: { [NAME]: 'user' } });
  for (const cwd of [42, null, {}, undefined, '']) {
    assert.deepEqual(possibleEnvs(s.env, cwd).envs.map((env) => env[NAME]), [undefined, 'project'], `cwd ${JSON.stringify(cwd)}`);
    assert.deepEqual(possibleEnvs(noProject.env, cwd).envs.map((env) => env[NAME]), [undefined, 'user'], `no project, cwd ${JSON.stringify(cwd)}`);
  }
});

test('possibleEnvs: a start folder whose path has spaces has its files read', () => {
  const spaced = join(makeTempDir('settings env lib-'), 'my project');
  const s = setup({ CLAUDE_PROJECT_DIR: spaced });
  writeSettings(localFile(spaced), { env: { [NAME]: 'spaced' } });
  assert.equal(possibleEnvs(s.env, spaced).envs[1][NAME], 'spaced');
});

test('possibleEnvs and envValue: each file is read once per run, so a change within the run is not seen', () => {
  const s = setup();
  writeSettings(s.userFile, { env: { [NAME]: 'first' } });
  writeSettings(localFile(s.project), { env: { [OTHER]: 'first' } });
  const before = possibleEnvs(s.env, s.project).envs[1];
  writeSettings(s.userFile, { env: { [NAME]: 'second' } });
  writeSettings(localFile(s.project), { env: { [OTHER]: 'second' } });
  const after = possibleEnvs(s.env, s.project).envs[1];
  assert.deepEqual([before[NAME], before[OTHER], after[NAME], after[OTHER]], ['first', 'first', 'first', 'first']);
  assert.equal(envValue(NAME, s.env), 'first');
});

test('envValue: a hook env that sets the name at all wins, even when empty; else the user file gives it', () => {
  const s = setup();
  writeSettings(s.userFile, { env: { [NAME]: 'file', [OTHER]: 7 } });
  assert.equal(envValue(NAME, { ...s.env, [NAME]: 'hook' }), 'hook');
  assert.equal(envValue(NAME, { ...s.env, [NAME]: '' }), '');
  assert.equal(envValue(NAME, s.env), 'file');
  assert.equal(envValue(OTHER, s.env), '7', 'a number as text');
});

test('envValue: HOME, else USERPROFILE, names the user file when CLAUDE_CONFIG_DIR is unset; with none of them it is unset', () => {
  const home = makeTempDir('settings-env-lib-home-');
  writeSettings(join(home, '.claude', SETTINGS_FILE), { env: { [NAME]: 'home' } });
  assert.equal(envValue(NAME, { HOME: home }), 'home');
  assert.equal(envValue(NAME, { USERPROFILE: home }), 'home');
  assert.equal(envValue(NAME, {}), undefined);
});

test('envValue: an unreadable user file leaves the name unset, even when it lists the name', () => {
  for (const content of [`{"env": {"${NAME}": "x"`, JSON.stringify({ env: { [NAME]: 'x', [OTHER]: null } }), '[]']) {
    const s = setup();
    writeSettings(s.userFile, content);
    assert.equal(envValue(NAME, s.env), undefined, content);
  }
});

test('envValue: the project files never give a value, and a broken one does not hide the user file', () => {
  const s = setup();
  writeSettings(sharedFile(s.project), { env: { [NAME]: 'shared' } });
  writeSettings(localFile(s.project), { env: { [NAME]: 'local' } });
  assert.equal(envValue(NAME, s.env), undefined, 'only project files set it');
  const broken = setup();
  writeSettings(broken.userFile, { env: { [NAME]: 'user' } });
  writeSettings(sharedFile(broken.project), '{');
  assert.equal(envValue(NAME, broken.env), 'user');
});
