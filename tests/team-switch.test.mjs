// Tests for our skip switches set by a team file (home/hooks/lib/team-switch.mjs; layering-spec.md section 3, lane team-switch): a
// switch that only a project's committed .claude/settings.json sets is ignored with a warning and our check runs; the same key in
// .claude/settings.local.json, or in the shell env with no project file, is honoured; an unreadable team file fails closed. The hook
// that reads a switch (post-edit) is run as Claude Code runs it, with a temp HOME and temp folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { switchDirs, switchNames, trustedSwitch } from '../home/hooks/lib/team-switch.mjs';
import { git as runGit } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { cleanEnv } from './clean-env.mjs';

const hookPath = (name) => fileURLToPath(new URL(`../home/hooks/${name}`, import.meta.url));
const SETTINGS = '.claude/settings.json';
const LOCAL = '.claude/settings.local.json';
const envFile = (key, value) => `${JSON.stringify({ env: { [key]: value } })}\n`;
const IGNORED_BY_TEAM = /team switch (\w+) ignored: the team file .*settings\.json sets it; our check runs/;
const IGNORED_UNREADABLE = /team switch (\w+) ignored: .*cannot be read .*; our check runs/;
const IGNORED_TRACKED_LOCAL = /team switch (\w+) ignored: .*settings\.local\.json sets it but git tracks that file .*; our check runs/;
const LOCAL_IGNORED_BY_GIT = { '.gitignore': `${LOCAL}\nnode_modules/\n` }; // how a project keeps its local file out of git

/** A project folder holding the given files (path relative to it -> text); `git` 'init' makes it a repo, 'commit' commits them too. */
function project(files = {}, git = null) {
  const dir = realpathSync(makeTempDir('team-switch-')); // the real path: the temp folder may be a link (macOS /var), and git and a hook's cwd see the real one
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  if (git === null) return dir;
  runGit(dir, 'init', '-q');
  if (git === 'commit') {
    runGit(dir, 'add', '-A');
    runGit(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'team');
  }
  return dir;
}

/** `run()` with the process in `dir` (a hook runs in the project folder, where "." is that folder), back where it was after. */
function inFolder(dir, run) {
  const before = process.cwd();
  process.chdir(dir);
  try {
    return run();
  } finally {
    process.chdir(before);
  }
}

// The named cases of the lane, for one switch: team file only, local twin, env only, unreadable team file; then the review round's:
// a committed local twin (R2: git tracks it, so it is a team file) and a team file that also sets USERPROFILE to "." (R1: with the
// hook run in the project, "." is the project folder, which must not pass for the home folder). `env`: more hook environment.
const namedCases = (key, value) => [
  { name: 'team file only', files: { [SETTINGS]: envFile(key, value) }, honoured: false, why: IGNORED_BY_TEAM },
  { name: 'local twin', files: { [SETTINGS]: envFile(key, value), [LOCAL]: envFile(key, value), ...LOCAL_IGNORED_BY_GIT }, git: 'init', honoured: true },
  { name: 'env only, no project file', files: {}, honoured: true },
  { name: 'unreadable team file', files: { [SETTINGS]: '{"env": {' }, honoured: false, why: IGNORED_UNREADABLE },
  { name: 'committed local twin', files: { [SETTINGS]: envFile(key, value), [LOCAL]: envFile(key, value) }, git: 'commit', honoured: false, why: IGNORED_TRACKED_LOCAL },
  { name: 'team file sets USERPROFILE "."', files: { [SETTINGS]: `${JSON.stringify({ env: { [key]: value, USERPROFILE: '.' } })}\n` }, env: { USERPROFILE: '.' }, honoured: false, why: IGNORED_BY_TEAM },
];

test('trustedSwitch: team-only switches are ignored with why, local twins and env-only switches are honoured', () => {
  for (const key of ['CLAUDE_POST_EDIT_SKIP', 'ANY_OTHER_SKIP']) { // the lib takes any key: the real switch and a made-up one
    for (const one of namedCases(key, 'all')) {
      const dir = project(one.files, one.git ?? null);
      const env = { [key]: 'all', ...one.env };
      const got = inFolder(dir, () => trustedSwitch(env, key, switchDirs(env, dir)));
      assert.equal(got.value, one.honoured ? 'all' : undefined, `${key}: ${one.name}`);
      if (one.honoured) assert.equal(got.ignored, null, `${key}: ${one.name}`);
      else assert.match(got.ignored, one.why, `${key}: ${one.name}`);
    }
  }
});

test('trustedSwitch: an unset or empty switch is not ignored; no project folder or the home folder honours the switch as before', () => {
  const dir = project({ [SETTINGS]: envFile('CLAUDE_POST_EDIT_SKIP', 'all') });
  assert.deepEqual(trustedSwitch({}, 'CLAUDE_POST_EDIT_SKIP', [dir]), { value: undefined, ignored: null });
  assert.deepEqual(trustedSwitch({ CLAUDE_POST_EDIT_SKIP: '' }, 'CLAUDE_POST_EDIT_SKIP', [dir]), { value: '', ignored: null });
  assert.deepEqual(switchDirs({}, undefined, null, '', 'relative/path'), []);
  // The real home folder's .claude/settings.json is the user's own settings file, never a team file.
  assert.deepEqual(switchDirs({}, userInfo().homedir), []);
  assert.deepEqual(switchDirs({ CLAUDE_PROJECT_DIR: userInfo().homedir }), []);
});

test('R1: HOME and USERPROFILE never make a project folder pass for the home folder (a team file can set them)', () => {
  const dir = project({ [SETTINGS]: envFile('CLAUDE_POST_EDIT_SKIP', 'all') });
  for (const env of [{ USERPROFILE: '.' }, { HOME: '.' }, { HOME: '.', USERPROFILE: '.' }, { HOME: dir, USERPROFILE: dir }]) {
    const all = { CLAUDE_POST_EDIT_SKIP: 'all', ...env };
    assert.deepEqual(inFolder(dir, () => switchDirs(all, dir)), [dir], JSON.stringify(env));
    assert.match(inFolder(dir, () => trustedSwitch(all, 'CLAUDE_POST_EDIT_SKIP', switchDirs(all, dir))).ignored ?? '', IGNORED_BY_TEAM, JSON.stringify(env));
  }
});

test('R2: a settings.local.json that git tracks, or that sits outside any repository, is a team file (fail closed)', () => {
  const both = { [SETTINGS]: envFile('CLAUDE_POST_EDIT_SKIP', 'all'), [LOCAL]: envFile('CLAUDE_POST_EDIT_SKIP', 'all') };
  const localOnly = { [LOCAL]: envFile('CLAUDE_POST_EDIT_SKIP', 'all') };
  for (const [name, dir] of [['committed twin', project(both, 'commit')], ['committed local only', project(localOnly, 'commit')], ['no repository', project(both)]]) {
    assert.match(trustedSwitch({ CLAUDE_POST_EDIT_SKIP: 'all' }, 'CLAUDE_POST_EDIT_SKIP', [dir]).ignored ?? '', IGNORED_TRACKED_LOCAL, name);
  }
  const untracked = project({ ...both, ...LOCAL_IGNORED_BY_GIT }, 'commit'); // the team file committed, the local file ignored by git
  assert.deepEqual(trustedSwitch({ CLAUDE_POST_EDIT_SKIP: 'all' }, 'CLAUDE_POST_EDIT_SKIP', [untracked]), { value: 'all', ignored: null });
  const staged = project(localOnly, 'init');
  runGit(staged, 'add', '-f', LOCAL); // staged counts as tracked: the next commit takes it
  assert.match(trustedSwitch({ CLAUDE_POST_EDIT_SKIP: 'all' }, 'CLAUDE_POST_EDIT_SKIP', [staged]).ignored ?? '', IGNORED_TRACKED_LOCAL, 'staged');
});

test('R5: on Windows a team key in another case is the same switch; elsewhere case is kept', () => {
  const team = project({ [SETTINGS]: envFile('Claude_Post_Edit_Skip', 'all') });
  assert.match(trustedSwitch({ CLAUDE_POST_EDIT_SKIP: 'all' }, 'CLAUDE_POST_EDIT_SKIP', [team], 'win32').ignored ?? '', IGNORED_BY_TEAM);
  assert.equal(trustedSwitch({ CLAUDE_POST_EDIT_SKIP: 'all' }, 'CLAUDE_POST_EDIT_SKIP', [team], 'darwin').value, 'all');
  const twin = project({ [SETTINGS]: envFile('CLAUDE_POST_EDIT_SKIP', 'all'), [LOCAL]: envFile('claude_post_edit_skip', 'all'), ...LOCAL_IGNORED_BY_GIT }, 'init');
  assert.equal(trustedSwitch({ CLAUDE_POST_EDIT_SKIP: 'all' }, 'CLAUDE_POST_EDIT_SKIP', [twin], 'win32').value, 'all', 'a local twin in another case counts on Windows');
  assert.match(trustedSwitch({ CLAUDE_POST_EDIT_SKIP: 'all' }, 'CLAUDE_POST_EDIT_SKIP', [twin], 'linux').ignored ?? '', IGNORED_BY_TEAM);
});

test('trustedSwitch: CLAUDE_PROJECT_DIR and every other known folder count; one team file anywhere ignores the switch', () => {
  const clean = project();
  const team = project({ [SETTINGS]: envFile('CLAUDE_POST_EDIT_SKIP', 'all') });
  assert.deepEqual(switchDirs({ CLAUDE_PROJECT_DIR: clean }, team, clean), [clean, team]);
  assert.equal(trustedSwitch({ CLAUDE_POST_EDIT_SKIP: 'all', CLAUDE_PROJECT_DIR: clean }, 'CLAUDE_POST_EDIT_SKIP', switchDirs({ CLAUDE_PROJECT_DIR: clean }, team)).value, undefined);
  assert.deepEqual([...switchNames({ CLAUDE_POST_EDIT_SKIP: ' types, lint ' }, 'CLAUDE_POST_EDIT_SKIP', [clean])], ['types', 'lint']);
  assert.deepEqual([...switchNames({ CLAUDE_POST_EDIT_SKIP: 'all' }, 'CLAUDE_POST_EDIT_SKIP', [team])], []);
});

test('hostile settings: a link, a huge file and a switch past 200 env keys are all ignored (fail closed); reads change nothing', () => {
  const real = project({ 'x.json': envFile('CLAUDE_POST_EDIT_SKIP', 'all') });
  const linked = project({ '.claude/.keep': '' });
  symlinkSync(join(real, 'x.json'), join(linked, SETTINGS));
  const huge = project({ [SETTINGS]: `{"env":{"CLAUDE_POST_EDIT_SKIP":"all"},"pad":"${'x'.repeat(300 * 1024)}"}` });
  const many = Object.fromEntries([...Array.from({ length: 250 }, (_, i) => [`K${i}`, '1']), ['CLAUDE_POST_EDIT_SKIP', 'all']]);
  const manyKeys = project({ [SETTINGS]: JSON.stringify({ env: many }) });
  for (const [name, dir, why] of [['link', linked, IGNORED_UNREADABLE], ['huge', huge, IGNORED_UNREADABLE], ['250 keys', manyKeys, IGNORED_BY_TEAM]]) {
    const before = statSync(join(dir, SETTINGS), { throwIfNoEntry: false })?.mtimeMs;
    const first = trustedSwitch({ CLAUDE_POST_EDIT_SKIP: 'all' }, 'CLAUDE_POST_EDIT_SKIP', [dir]);
    assert.match(first.ignored ?? '', why, name);
    assert.deepEqual(trustedSwitch({ CLAUDE_POST_EDIT_SKIP: 'all' }, 'CLAUDE_POST_EDIT_SKIP', [dir]), first, `${name}: the same answer twice`);
    assert.equal(statSync(join(dir, SETTINGS), { throwIfNoEntry: false })?.mtimeMs, before, `${name}: nothing written`);
  }
});

// ---- post-edit ----
const posix = { skip: process.platform === 'win32' };

/** A package whose broad format script runs a fake prettier that records each run in ran.txt. */
function formatProject(files, git) {
  const dir = project({ ...files, 'package.json': JSON.stringify({ scripts: { format: 'prettier --write .' } }), 'src/a.ts': 'export const a = 1;\n' }, git);
  const bin = join(dir, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'prettier'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(join(dir, 'ran.txt'))}, 'x');\n`);
  chmodSync(join(bin, 'prettier'), 0o755);
  return dir;
}

test('post-edit: CLAUDE_POST_EDIT_SKIP=all from a team file still formats and warns once per session; local and env-only skip', posix, () => {
  const tmp = makeTempDir('team-switch-tmp-');
  for (const [index, one] of namedCases('CLAUDE_POST_EDIT_SKIP', 'all').entries()) {
    const dir = formatProject(one.files, one.git ?? null);
    const env = cleanEnv({ HOME: tmp, USERPROFILE: tmp, TMPDIR: tmp, TEMP: tmp, TMP: tmp, CLAUDE_PROJECT_DIR: dir, CLAUDE_POST_EDIT_SKIP: 'all', ...one.env });
    const edit = () => spawnSync(process.execPath, [hookPath('post-edit.mjs')], { input: JSON.stringify({ session_id: `post-edit-${index}`, cwd: dir, tool_input: { file_path: join(dir, 'src', 'a.ts') } }), encoding: 'utf8', env, cwd: dir });
    const first = edit();
    const second = edit();
    assert.equal(first.status + second.status, 0, `${one.name}: ${first.stderr}${second.stderr}`);
    assert.equal(existsSync(join(dir, 'ran.txt')) ? readFileSync(join(dir, 'ran.txt'), 'utf8') : '', one.honoured ? '' : 'xx', one.name);
    if (one.honoured) assert.equal(first.stdout, '', one.name);
    else assert.match(JSON.parse(first.stdout).systemMessage, one.why, one.name);
    assert.equal(second.stdout, '', `${one.name}: the warning shows once per session`);
  }
});
