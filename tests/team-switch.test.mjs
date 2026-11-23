// Tests for our skip switches set by a team file (home/hooks/lib/team-switch.mjs; layering-spec.md section 3, lane team-switch): a
// switch that only a project's committed .claude/settings.json sets is ignored with a warning and our check runs; the same key in
// .claude/settings.local.json, or in the shell env with no project file, is honoured; an unreadable team file fails closed. Each hook
// (done-check, post-edit, skill-router) is run as Claude Code runs it, with a temp HOME and temp folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { switchDirs, switchNames, trustedSwitch } from '../home/hooks/lib/team-switch.mjs';
import { saveBaseline } from '../home/hooks/lib/dirty-baseline.mjs';
import { makeDoneCheckRepo } from './done-check-fixture.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const hookPath = (name) => fileURLToPath(new URL(`../home/hooks/${name}`, import.meta.url));
const SETTINGS = '.claude/settings.json';
const LOCAL = '.claude/settings.local.json';
const envFile = (key, value) => `${JSON.stringify({ env: { [key]: value } })}\n`;
const IGNORED_BY_TEAM = /team switch (\w+) ignored: the team file .*settings\.json sets it; our check runs/;
const IGNORED_UNREADABLE = /team switch (\w+) ignored: .*cannot be read .*; our check runs/;

/** A project folder holding the given files (path relative to it -> text). */
function project(files = {}) {
  const dir = makeTempDir('team-switch-');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

// The four named cases of the lane, for one switch: team file only, local twin, env only, unreadable team file.
const namedCases = (key, value) => [
  { name: 'team file only', files: { [SETTINGS]: envFile(key, value) }, honoured: false, why: IGNORED_BY_TEAM },
  { name: 'local twin', files: { [SETTINGS]: envFile(key, value), [LOCAL]: envFile(key, value) }, honoured: true },
  { name: 'env only, no project file', files: {}, honoured: true },
  { name: 'unreadable team file', files: { [SETTINGS]: '{"env": {' }, honoured: false, why: IGNORED_UNREADABLE },
];

test('trustedSwitch: team-only switches are ignored with why, local twins and env-only switches are honoured', () => {
  for (const key of ['DONE_CHECK_SKIP', 'CLAUDE_POST_EDIT_SKIP', 'CLAUDE_SKILL_ROUTER']) {
    for (const one of namedCases(key, 'all')) {
      const dir = project(one.files);
      const got = trustedSwitch({ [key]: 'all' }, key, switchDirs({}, dir));
      assert.equal(got.value, one.honoured ? 'all' : undefined, `${key}: ${one.name}`);
      if (one.honoured) assert.equal(got.ignored, null, `${key}: ${one.name}`);
      else assert.match(got.ignored, one.why, `${key}: ${one.name}`);
    }
  }
});

test('trustedSwitch: an unset or empty switch is not ignored; no project folder or the home folder honours the switch as before', () => {
  const dir = project({ [SETTINGS]: envFile('DONE_CHECK_SKIP', 'all') });
  assert.deepEqual(trustedSwitch({}, 'DONE_CHECK_SKIP', [dir]), { value: undefined, ignored: null });
  assert.deepEqual(trustedSwitch({ DONE_CHECK_SKIP: '' }, 'DONE_CHECK_SKIP', [dir]), { value: '', ignored: null });
  assert.deepEqual(switchDirs({}, undefined, null, '', 'relative/path'), []);
  // The home folder's .claude/settings.json is the user's own settings file, never a team file.
  assert.deepEqual(switchDirs({ HOME: dir, USERPROFILE: dir }, dir), []);
  assert.equal(trustedSwitch({ DONE_CHECK_SKIP: 'all' }, 'DONE_CHECK_SKIP', switchDirs({ HOME: dir, USERPROFILE: dir }, dir)).value, 'all');
});

test('trustedSwitch: CLAUDE_PROJECT_DIR and every other known folder count; one team file anywhere ignores the switch', () => {
  const clean = project();
  const team = project({ [SETTINGS]: envFile('DONE_CHECK_SKIP', 'all') });
  assert.deepEqual(switchDirs({ CLAUDE_PROJECT_DIR: clean }, team, clean), [clean, team]);
  assert.equal(trustedSwitch({ DONE_CHECK_SKIP: 'all', CLAUDE_PROJECT_DIR: clean }, 'DONE_CHECK_SKIP', switchDirs({ CLAUDE_PROJECT_DIR: clean }, team)).value, undefined);
  assert.deepEqual([...switchNames({ DONE_CHECK_SKIP: ' types, lint ' }, 'DONE_CHECK_SKIP', [clean])], ['types', 'lint']);
  assert.deepEqual([...switchNames({ DONE_CHECK_SKIP: 'all' }, 'DONE_CHECK_SKIP', [team])], []);
});

test('hostile settings: a link, a huge file and a switch past 200 env keys are all ignored (fail closed); reads change nothing', () => {
  const real = project({ 'x.json': envFile('DONE_CHECK_SKIP', 'all') });
  const linked = project({ '.claude/.keep': '' });
  symlinkSync(join(real, 'x.json'), join(linked, SETTINGS));
  const huge = project({ [SETTINGS]: `{"env":{"DONE_CHECK_SKIP":"all"},"pad":"${'x'.repeat(300 * 1024)}"}` });
  const many = Object.fromEntries([...Array.from({ length: 250 }, (_, i) => [`K${i}`, '1']), ['DONE_CHECK_SKIP', 'all']]);
  const manyKeys = project({ [SETTINGS]: JSON.stringify({ env: many }) });
  for (const [name, dir, why] of [['link', linked, IGNORED_UNREADABLE], ['huge', huge, IGNORED_UNREADABLE], ['250 keys', manyKeys, IGNORED_BY_TEAM]]) {
    const before = statSync(join(dir, SETTINGS), { throwIfNoEntry: false })?.mtimeMs;
    const first = trustedSwitch({ DONE_CHECK_SKIP: 'all' }, 'DONE_CHECK_SKIP', [dir]);
    assert.match(first.ignored ?? '', why, name);
    assert.deepEqual(trustedSwitch({ DONE_CHECK_SKIP: 'all' }, 'DONE_CHECK_SKIP', [dir]), first, `${name}: the same answer twice`);
    assert.equal(statSync(join(dir, SETTINGS), { throwIfNoEntry: false })?.mtimeMs, before, `${name}: nothing written`);
  }
});

// ---- done-check ----
const PACKAGE = { name: 'p', private: true, scripts: { typecheck: 'tsc --noEmit' } };
const SOURCES = { 'src/lib.ts': 'export const n: number = 1;\n', 'src/use.ts': "import { n } from './lib';\nexport const t: number = n;\n", 'tsconfig.json': '{"compilerOptions":{"strict":true}}\n' };
const TSC_BROKEN_CALLER = { exit: 2, stdout: "src/use.ts(3,25): error TS2322: Type 'string' is not assignable to type 'number'.\n" };

test('done-check: DONE_CHECK_SKIP=all from a team file runs the checks and says so once; local, env-only are honoured; unreadable fails closed', async (t) => {
  for (const one of namedCases('DONE_CHECK_SKIP', 'all')) {
    const repo = makeDoneCheckRepo({ packageJson: PACKAGE, files: { ...SOURCES, ...one.files }, tools: ['tsc'], replay: { tsc: { exit: 0 } } });
    t.after(repo.cleanup);
    // A subagent that started in the repo at its base (as done-check-hook.test.mjs sets one up), then broke a caller.
    const transcript = join(repo.home, 'team-1--agent-1.jsonl');
    writeFileSync(transcript, `${JSON.stringify({ cwd: repo.dir })}\n`);
    assert.equal(saveBaseline(repo.env, 'team-1', 'agent-1', repo.dir, [], repo.baseSha), true);
    repo.write('src/lib.ts', "export const n: string = '1';\n");
    repo.setTool('tsc', TSC_BROKEN_CALLER);
    const input = { hook_event_name: 'SubagentStop', session_id: 'team-1', agent_id: 'agent-1', agent_type: 'implementer', agent_transcript_path: transcript, cwd: repo.dir, stop_hook_active: false };
    const result = repo.run(hookPath('done-check.mjs'), [], { input: JSON.stringify(input), env: { DONE_CHECK_SKIP: 'all', CLAUDE_PROJECT_DIR: repo.dir } });
    assert.equal(result.status, 0, one.name);
    const out = JSON.parse(result.stdout);
    if (one.honoured) {
      assert.match(out.systemMessage, /skipped by DONE_CHECK_SKIP=all/, one.name);
      assert.deepEqual(repo.calls(), [], one.name);
      continue;
    }
    assert.equal(out.decision, 'block', `${one.name}: the checks ran and found the broken caller`);
    assert.match(out.reason, /src\/use\.ts:3\b[^\n]*TS2322/, one.name);
    assert.match(out.systemMessage, one.why, one.name);
    assert.equal(out.systemMessage.split('team switch').length - 1, 1, `${one.name}: one warning per stop`);
  }
});

// ---- post-edit ----
const posix = { skip: process.platform === 'win32' };

/** A package whose broad format script runs a fake prettier that records each run in ran.txt. */
function formatProject(files) {
  const dir = project({ ...files, 'package.json': JSON.stringify({ scripts: { format: 'prettier --write .' } }), 'src/a.ts': 'export const a = 1;\n' });
  const bin = join(dir, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'prettier'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(join(dir, 'ran.txt'))}, 'x');\n`);
  chmodSync(join(bin, 'prettier'), 0o755);
  return dir;
}

test('post-edit: CLAUDE_POST_EDIT_SKIP=all from a team file still formats and warns once per session; local and env-only skip', posix, () => {
  const tmp = makeTempDir('team-switch-tmp-');
  for (const [index, one] of namedCases('CLAUDE_POST_EDIT_SKIP', 'all').entries()) {
    const dir = formatProject(one.files);
    const env = { ...process.env, HOME: tmp, USERPROFILE: tmp, TMPDIR: tmp, TEMP: tmp, TMP: tmp, CLAUDE_PROJECT_DIR: dir, CLAUDE_POST_EDIT_SKIP: 'all' };
    const edit = () => spawnSync(process.execPath, [hookPath('post-edit.mjs')], { input: JSON.stringify({ session_id: `post-edit-${index}`, cwd: dir, tool_input: { file_path: join(dir, 'src', 'a.ts') } }), encoding: 'utf8', env });
    const first = edit();
    const second = edit();
    assert.equal(first.status + second.status, 0, `${one.name}: ${first.stderr}${second.stderr}`);
    assert.equal(existsSync(join(dir, 'ran.txt')) ? readFileSync(join(dir, 'ran.txt'), 'utf8') : '', one.honoured ? '' : 'xx', one.name);
    if (one.honoured) assert.equal(first.stdout, '', one.name);
    else assert.match(JSON.parse(first.stdout).systemMessage, one.why, one.name);
    assert.equal(second.stdout, '', `${one.name}: the warning shows once per session`);
  }
});
