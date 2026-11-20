// Tests that nothing outside the commits changes what review-tier reads (lane r7-delta, fix round 4): the lane's own config and
// attributes, the user's git files (a global config, `$XDG_CONFIG_HOME/git/attributes`), GIT_* variables of the caller, and the lane's
// working tree. The writer of a fix can write each of them, and none shows in a diff.
// Fixtures: the probes of the security review (p13 E) and of the spec check (p2), rebuilt in temp repos with a temp HOME.
// The object store and the commit-graph: review-tier-object-store.test.mjs. The calls themselves: review-tier-trusted-calls.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLEAN_ENV, git } from './git-tidy-helpers.mjs';
import { CLI, lane, priorFile, sha256Of } from './review-tier-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const GATE_GUARDED = "export function decide(cmd) {\n  if (cmd.includes(';')) return 'deny';\n  return 'allow';\n}\n";
const GATE_OPEN = "export function decide(cmd) {\n  return 'allow';\n}\n";
const CALLER = "import { decide } from './gate.mjs';\nexport function run(c) {\n  return decide(c);\n}\n";
const CALLERS = ['src/gate.mjs:1', 'src/run.mjs:1', 'src/run.mjs:3'];
const QUIET_DRIVER = '[diff "quiet"]\n\txfuncname = ^NEVER MATCHES$\n';
/** The parts of a report a blinded tool would get wrong: what was read, what a reviewer is told to read, and who reviews it. */
const view = ({ tier, classes, files, changedLines, range, hits, reviews }) => ({ tier, classes, files, changedLines, range, hits, reading: reviews[0].requiredReading, lenses: reviews.map(({ agent, model, effort, lens }) => ({ agent, model, effort, lens })) });

/** Probe p13 (E): `decide` and its caller are on the base; the lane's fix only deletes the guard line, so the caller is what a reviewer must read. */
function callerLane() {
  const made = lane();
  git(made.dir, 'checkout', '-q', 'main');
  made.write('src/gate.mjs', GATE_GUARDED);
  made.write('src/run.mjs', CALLER);
  git(made.dir, 'checkout', '-q', '-B', 'lane');
  made.write('README.md', '# r\nusage\n');
  const reviewed = made.write('src/z.mjs', 'export const z = 1;\n');
  made.write('src/gate.mjs', GATE_OPEN);
  const prior = priorFile();
  const fixRound = ['--delta', reviewed, '--base', git(made.dir, 'rev-parse', 'refs/heads/main'), '--prior', prior, '--prior-sha256', sha256Of(prior), '--lane-classes', 'logic,docs', '--json'];
  /** The fix round with `changes` laid over the test environment (a value of undefined removes the variable). */
  const under = (changes) => {
    const env = { ...CLEAN_ENV, REVIEW_TIER_LOG: made.log, ...changes };
    for (const [name, value] of Object.entries(changes)) if (value === undefined) delete env[name];
    const result = spawnSync(process.execPath, [CLI, ...fixRound], { cwd: made.dir, encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    return view(JSON.parse(result.stdout));
  };
  const control = under({});
  assert.deepEqual(control.reading, CALLERS, 'the control round names the changed function and both lines of its caller');
  return { ...made, under, control };
}

/** A temp folder with the given files (path -> text); returns its real path. */
function folderWith(files) {
  const folder = realpathSync(makeTempDir('review-tier-home-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(folder, path, '..'), { recursive: true });
    writeFileSync(join(folder, path), text);
  }
  return folder;
}

test('security S7: a diff driver of the writer (info/attributes + diff.<driver>.xfuncname in the repo config) does not take the callers off the reading list', () => {
  const { dir, under, control } = callerLane();
  mkdirSync(join(dir, '.git', 'info'), { recursive: true });
  writeFileSync(join(dir, '.git', 'info', 'attributes'), '*.mjs diff=quiet\n');
  git(dir, 'config', 'diff.quiet.xfuncname', '^NEVER MATCHES$');
  assert.deepEqual(under({}), control);
});

test('spec check F1: attributes from outside the repository ($XDG_CONFIG_HOME/git/attributes, $HOME/.config/git/attributes) change neither hunk heads nor callers', () => {
  const { under, control } = callerLane();
  for (const attributes of ['*.mjs diff=tex\n', '*.mjs binary\n', '*.mjs -diff\n']) {
    const xdg = folderWith({ 'git/attributes': attributes });
    assert.deepEqual(under({ XDG_CONFIG_HOME: xdg }), control, `XDG_CONFIG_HOME: ${attributes.trim()}`);
    const home = folderWith({ '.config/git/attributes': attributes });
    assert.deepEqual(under({ HOME: home, XDG_CONFIG_HOME: undefined }), control, `HOME: ${attributes.trim()}`);
  }
});

test('spec check F2: the callers come from the commit at HEAD, never from the working tree: an uncommitted caller is not listed, a hidden one still is', () => {
  const { dir, under, control } = callerLane();
  assert.ok(control.reading.includes('src/run.mjs:3'), 'the committed caller is listed');
  // The writer hides the committed caller and plants another one, without a commit: one edit of a tracked file, one staged new file.
  writeFileSync(join(dir, 'src', 'run.mjs'), 'export function run(c) {\n  return c;\n}\n');
  writeFileSync(join(dir, 'src', 'planted.mjs'), "import { decide } from './gate.mjs';\nexport const planted = (c) => decide(c);\n");
  git(dir, 'add', '--', 'src/planted.mjs');
  const dirty = under({});
  assert.deepEqual(dirty, control, 'the working tree and the index change nothing');
  assert.ok(!dirty.reading.some((place) => place.startsWith('src/planted.mjs')), 'the uncommitted caller is not listed');
});

test('GIT_* variables of the caller change nothing: a config, attributes, objects or a repository named through the environment are not read', () => {
  const { under, control } = callerLane();
  const outside = folderWith({ attributes: '*.mjs diff=quiet\n', other: '' });
  const config = folderWith({ gitconfig: `[core]\n\tattributesFile = ${join(outside, 'attributes')}\n${QUIET_DRIVER}` });
  const hostile = [
    { GIT_CONFIG_GLOBAL: join(config, 'gitconfig') },
    { GIT_CONFIG_NOSYSTEM: '0', GIT_CONFIG_SYSTEM: join(config, 'gitconfig') },
    { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.attributesFile', GIT_CONFIG_VALUE_0: join(outside, 'attributes'), GIT_CONFIG_KEY_1: 'diff.quiet.xfuncname', GIT_CONFIG_VALUE_1: '^NEVER MATCHES$' },
    { GIT_CONFIG_PARAMETERS: `'core.attributesFile=${join(outside, 'attributes')}' 'diff.quiet.xfuncname=^NEVER MATCHES$'` },
    { GIT_DIR: join(outside, 'other'), GIT_WORK_TREE: outside, GIT_INDEX_FILE: join(outside, 'index') },
    { GIT_OBJECT_DIRECTORY: join(outside, 'other'), GIT_ALTERNATE_OBJECT_DIRECTORIES: join(outside, 'other') },
    { GIT_ATTR_NOSYSTEM: '0', GIT_ATTR_SOURCE: 'refs/heads/none', GIT_DIFF_OPTS: '--unified=9', GIT_EXTERNAL_DIFF: 'false', GIT_LITERAL_PATHSPECS: '0', GIT_ICASE_PATHSPECS: '1' },
  ];
  for (const variables of hostile) assert.deepEqual(under(variables), control, Object.keys(variables).join());
});

test('a global git config of the user changes nothing: diff.external, diff.noprefix, an attributes file and a diff driver in $HOME/.gitconfig', () => {
  const { under, control } = callerLane();
  const outside = folderWith({ attributes: '*.mjs diff=quiet\n' });
  const home = folderWith({ '.gitconfig': `[diff]\n\texternal = false\n\tnoprefix = true\n\tignoreSubmodules = all\n[core]\n\tattributesFile = ${join(outside, 'attributes')}\n\tcommitGraph = true\n${QUIET_DRIVER}` });
  assert.deepEqual(under({ HOME: home, GIT_CONFIG_GLOBAL: undefined, XDG_CONFIG_HOME: undefined }), control, '$HOME/.gitconfig');
  const xdg = folderWith({ 'git/config': `[diff]\n\texternal = false\n\tnoprefix = true\n[core]\n\tattributesFile = ${join(outside, 'attributes')}\n${QUIET_DRIVER}` });
  assert.deepEqual(under({ HOME: folderWith({}), XDG_CONFIG_HOME: xdg, GIT_CONFIG_GLOBAL: undefined }), control, '$XDG_CONFIG_HOME/git/config');
});
