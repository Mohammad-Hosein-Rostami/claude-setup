// Tests of how review-tier calls git (lane r7-delta, fix rounds 4 and 5): which questions go to the lane's own repository, that the
// import is the only reader of the lane's objects, and that every other call runs in the tool's own repository with the fixed flags and
// the clean environment, without the lane's objects, takes shas only, and comes after the import.
// A `git` put first on PATH records each call (spyGit); the lane's repository is a temp repo, HOME and the git config are never the user's.
// What those calls protect against, case by case: review-tier-outside-state.test.mjs, review-tier-object-store.test.mjs,
// review-tier-verified-import.test.mjs and review-tier-import-closure.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { devNull } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { alternatesEntry } from '../home/tools/review-tier/lib/lane-import.mjs';
import { MIN_GIT, TRUSTED_FLAGS, refuseOldGit, trustedEnvironment } from '../home/tools/review-tier/lib/trusted-git.mjs';
import { CLEAN_ENV, addWorktree, git } from './git-tidy-helpers.mjs';
import { spiedRun } from './review-tier-forgery-helpers.mjs';
import { CLI, lane, priorFile, sha256Of } from './review-tier-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const POSIX_ONLY = { skip: process.platform === 'win32' && 'the recording git is a `#!` script' };
const EXEC_FILE = "import { execSync } from 'node:child_process';\nexport const go = (cmd) => execSync(cmd);\n";
const TRUSTED_GIT_VARIABLES = ['GIT_ATTR_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_DIR', 'GIT_GRAFT_FILE', 'GIT_NO_REPLACE_OBJECTS'];
const NO_GRAFT_FILE = join(process.execPath, 'no-grafts');
// Everything the lane's own repository is asked (spec check F11; fix round 5, K6): whether the working folder is inside its work tree,
// its folders, the three refusals, and the sha behind HEAD and a branch.
const REAL_REPOSITORY_CALLS = [
  /^rev-parse --is-inside-work-tree$/, /^rev-parse --show-toplevel$/, /^rev-parse --path-format=absolute --git-common-dir$/,
  /^for-each-ref --count=1 --format=%\(refname\) refs\/replace\/$/, /^rev-parse --is-shallow-repository$/,
  /^show-ref --verify --hash refs\/heads\/(main|master|develop)$/, /^rev-parse --verify --quiet HEAD$/,
];
// Everything the import asks with the lane's objects borrowed: objects by name, and the three listings of what to copy.
const LANE_SIDE_CALLS = [
  /^cat-file --batch-check$/, /^cat-file --batch$/, /^rev-list( [0-9a-f]{40})+$/, /^ls-tree -r -t -z [0-9a-f]{40}$/,
  /^diff-tree -r -z --raw --no-renames --no-abbrev [0-9a-f]{40} [0-9a-f]{40}$/,
];
const READS = new Set(['diff', 'show', 'grep', 'merge-base', 'rev-list', 'rev-parse']);
const view = ({ tier, classes, files, changedLines, range, base, tip, reviews }) => ({ tier, classes, files, changedLines, range, base, tip, reading: reviews[0].requiredReading });

/** A lane with a reviewed commit and a fix, its fix-round arguments, and `spied(args, more)`: the CLI run with the recording git first on PATH (spiedRun). */
function spiedLane() {
  const made = lane();
  const reviewed = made.write('src/run.mjs', 'export const run = (name) => name;\n');
  made.write('src/worker.mjs', EXEC_FILE);
  const prior = priorFile();
  const fixRound = ['--delta', reviewed, '--base', git(made.dir, 'rev-parse', 'refs/heads/main'), '--prior', prior, '--prior-sha256', sha256Of(prior), '--lane-classes', 'logic', '--json'];
  const spied = (args, more = {}) => spiedRun(made.dir, made.log, args, more);
  return { ...made, reviewed, fixRound, spied };
}

test('the clean environment keeps no GIT_* variable of the caller and sets its own six, none of them an object folder, with HOME and XDG_CONFIG_HOME in the temp folder', () => {
  const parent = { PATH: '/bin', LANG: 'C', HOME: '/home/u', XDG_CONFIG_HOME: '/home/u/.config', GIT_DIR: '/x', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_EXTERNAL_DIFF: 'x', git_work_tree: '/y', GIT_ATTR_SOURCE: 'z', GIT_ALTERNATE_OBJECT_DIRECTORIES: '/repo/.git/objects', GIT_OBJECT_DIRECTORY: '/o', GIT_NO_REPLACE_OBJECTS: '0', GIT_GRAFT_FILE: '/g' };
  assert.deepEqual(trustedEnvironment(parent, '/tmp/t'), {
    PATH: '/bin', LANG: 'C', LC_MESSAGES: 'C', GIT_DIR: '/tmp/t', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull,
    GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: NO_GRAFT_FILE, HOME: '/tmp/t', XDG_CONFIG_HOME: '/tmp/t',
  });
  assert.deepEqual(TRUSTED_FLAGS, ['-c', 'core.commitGraph=false', '-c', 'core.multiPackIndex=false', '-c', 'core.precomposeUnicode=false', '-c', 'core.quotePath=false', '-c', `core.attributesFile=${devNull}`, '-c', 'core.ignoreCase=false']);
});

test('spec check K1 (fix 6): git\'s messages are never translated, and every other locale category keeps the value the caller gave it', () => {
  const localeOf = (parent) => Object.fromEntries(Object.entries(trustedEnvironment(parent, '/tmp/t')).filter(([name]) => /^(LANG|LANGUAGE|LC_.*)$/.test(name)));
  assert.deepEqual(localeOf({ LC_ALL: 'de_DE.UTF-8', LANGUAGE: 'de', LANG: 'en_US.UTF-8', LC_CTYPE: 'fr_FR.UTF-8' }), { LANG: 'de_DE.UTF-8', LC_MESSAGES: 'C' });
  assert.deepEqual(localeOf({ LANG: 'en_US.UTF-8', LC_MESSAGES: 'de_DE.UTF-8', LC_CTYPE: 'fr_FR.UTF-8' }), { LANG: 'en_US.UTF-8', LC_CTYPE: 'fr_FR.UTF-8', LC_MESSAGES: 'C' });
  assert.deepEqual(localeOf({ LC_ALL: '', LANG: 'en_US.UTF-8' }), { LANG: 'en_US.UTF-8', LC_MESSAGES: 'C' }, 'an empty LC_ALL sets nothing, as in libc');
  assert.deepEqual(localeOf({}), { LC_MESSAGES: 'C' });
});

test('spec check K1 (fix 6): with a translated locale in the caller\'s environment, every call in the tool\'s repository sees LC_MESSAGES=C and the caller\'s character locale', POSIX_ONLY, () => {
  const { spied, fixRound } = spiedLane();
  // The machine's own LC_CTYPE and the like stay in the second case (no LC_ALL: each category keeps its value); the first drops them.
  const cases = [
    [{ LC_ALL: 'de_DE.UTF-8', LANGUAGE: 'de' }, { LANG: 'de_DE.UTF-8', LC_MESSAGES: 'C' }, true],
    [{ LANG: 'en_US.UTF-8', LC_MESSAGES: 'de_DE.UTF-8', LC_ALL: '' }, { LANG: 'en_US.UTF-8', LC_MESSAGES: 'C' }, false],
  ];
  for (const [parent, expected, onlyMessages] of cases) {
    const { result, trusted, laneSide } = spied(fixRound, parent);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(trusted.length > 0 && laneSide.length > 0);
    for (const { command, env } of [...trusted, ...laneSide]) {
      const label = `${JSON.stringify(parent)}: ${command.join(' ')}`;
      const { LANG, LANGUAGE, LC_ALL, LC_MESSAGES } = env;
      assert.deepEqual(JSON.parse(JSON.stringify({ LANG, LANGUAGE, LC_ALL, LC_MESSAGES })), expected, label);
      if (onlyMessages) assert.deepEqual(Object.keys(env).filter((name) => name.startsWith('LC_')), ['LC_MESSAGES'], label);
    }
  }
});

test('an object folder whose path holds the path delimiter or starts with a quote is written C-quoted, any other path as it is', () => {
  assert.equal(alternatesEntry(join('/repo', '.git', 'objects')), join('/repo', '.git', 'objects'));
  assert.equal(alternatesEntry(`/a${delimiter}b/objects`), `"/a${delimiter}b/objects"`);
  assert.equal(alternatesEntry(`"q${delimiter}\\x/objects`), `"\\"q${delimiter}\\\\x/objects"`);
});

test('git below the floor is refused with the floor and the version found; the floor itself and newer ones pass', () => {
  assert.deepEqual(MIN_GIT, [2, 41]);
  for (const old of ['git version 2.40.9', 'git version 2.32.0', 'git version 2.31.1', 'git version 1.9.5', 'git version 2.9.0 (Apple Git-75)', 'not a version', '']) assert.throws(() => refuseOldGit(old), /review-tier needs git 2\.41 or newer .*found/, old);
  for (const fine of ['git version 2.41.0', 'git version 2.54.0 (Apple Git-157)', 'git version 3.0.0', 'git version 10.1.0.windows.1']) assert.doesNotThrow(() => refuseOldGit(fine), fine);
});

test('an old git on PATH is exit 2 naming the floor, before the lane is read', POSIX_ONLY, () => {
  const { spied, fixRound } = spiedLane();
  const { result, trusted, laneSide } = spied(fixRound, { SPY_GIT_VERSION: 'git version 2.40.9' });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /review-tier needs git 2\.41 or newer .*found "git version 2\.40\.9"/);
  assert.deepEqual([...trusted, ...laneSide].map((call) => call.command.join(' ')), ['--version'], 'nothing ran after the version check');
  assert.ok(!existsSync(trusted[0].env.GIT_DIR), 'the temp repository is removed');
});

test('the lane\'s repository is asked only for its folders, the refusals and the sha behind HEAD and a branch, each once, without the variables that move history', POSIX_ONLY, () => {
  const { dir, spied, fixRound } = spiedLane();
  const moved = { GIT_SHALLOW_FILE: join(dir, '..', 'shallow'), GIT_REPLACE_REF_BASE: 'refs/swap/', GIT_GRAFT_FILE: join(dir, '..', 'grafts'), GIT_NO_REPLACE_OBJECTS: '0' };
  for (const args of [fixRound, ['--landing', '--json'], ['main...HEAD~1', '--json']]) {
    const { result, real } = spied(args, moved);
    assert.equal(result.status, 0, result.stderr);
    const commands = real.map((call) => call.command.join(' '));
    for (const command of commands) assert.ok(REAL_REPOSITORY_CALLS.some((allowed) => allowed.test(command)), `not a question for the lane's repository: git ${command}`);
    assert.equal(new Set(commands).size, commands.length, `a ref is read once: ${commands.join(' | ')}`);
    assert.equal(commands.filter((command) => command.endsWith(' HEAD')).length, 1, 'HEAD is read once');
    for (const { cwd, env } of real) {
      assert.equal(cwd, dir);
      assert.deepEqual([env.GIT_NO_REPLACE_OBJECTS, env.GIT_GRAFT_FILE, env.GIT_SHALLOW_FILE, env.GIT_REPLACE_REF_BASE], ['1', NO_GRAFT_FILE, undefined, undefined]);
    }
  }
});

test('the import is the only reader of the lane\'s objects: it asks for objects by name and three listings, all before the first read', POSIX_ONLY, () => {
  const { dir, spied, fixRound } = spiedLane();
  for (const args of [fixRound, ['--landing', '--json'], ['main...HEAD~1', '--json']]) {
    const { result, laneSide, trusted } = spied(args);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(laneSide.length >= 6, 'the commits, then the trees and files, are listed and read');
    for (const { argv, command, env } of laneSide) {
      assert.ok(LANE_SIDE_CALLS.some((allowed) => allowed.test(command.join(' '))), `not a call of the import: git ${command.join(' ')}`);
      assert.deepEqual(argv.slice(0, TRUSTED_FLAGS.length), TRUSTED_FLAGS, argv.join(' '));
      assert.deepEqual(Object.keys(env).filter((name) => name.startsWith('GIT_')).sort(), ['GIT_ALTERNATE_OBJECT_DIRECTORIES', ...TRUSTED_GIT_VARIABLES]);
      assert.equal(env.GIT_ALTERNATE_OBJECT_DIRECTORIES, join(dir, '.git', 'objects'));
    }
    const firstRead = trusted.find((call) => call.command[0] === 'diff').at;
    assert.ok(laneSide.every((call) => call.at < firstRead), 'the lane\'s objects are not asked again once the diffs start');
  }
});

test('every other git call runs in the tool\'s own repository with the fixed flags and the clean environment and without the lane\'s objects, takes shas only and no pathspec, and reads after the import', POSIX_ONLY, () => {
  const { dir, spied, fixRound, reviewed } = spiedLane();
  git(dir, 'commit', '-q', '--amend', '-m', 'the fix, amended'); // also a rewritten lane further down
  const start = git(dir, 'rev-parse', 'refs/heads/main');
  for (const args of [fixRound, ['--landing', '--json'], [...fixRound.slice(0, 1), git(dir, 'rev-parse', 'HEAD@{1}'), ...fixRound.slice(2)]]) {
    const { result, trusted } = spied(args, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.commitGraph', GIT_CONFIG_VALUE_0: 'true', XDG_CONFIG_HOME: dir, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(dir, '.git', 'objects') });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(trusted.length > 6, 'the reads are recorded');
    for (const { cwd, argv, command, env, attrSource } of trusted) {
      assert.deepEqual(argv.slice(0, TRUSTED_FLAGS.length), TRUSTED_FLAGS, argv.join(' '));
      assert.deepEqual(Object.keys(env).filter((name) => name.startsWith('GIT_')).sort(), TRUSTED_GIT_VARIABLES, command.join(' '));
      assert.deepEqual([env.GIT_CONFIG_NOSYSTEM, env.GIT_CONFIG_GLOBAL, env.GIT_ATTR_NOSYSTEM, env.GIT_NO_REPLACE_OBJECTS, env.GIT_GRAFT_FILE], ['1', devNull, '1', '1', NO_GRAFT_FILE]);
      assert.deepEqual([env.HOME, env.XDG_CONFIG_HOME, basename(cwd)], [env.GIT_DIR, env.GIT_DIR, basename(env.GIT_DIR)], 'HOME, XDG_CONFIG_HOME and the working folder are the temp repository');
      assert.match(basename(env.GIT_DIR), /^review-tier-git-/);
      assert.ok(!command.some((word) => /HEAD|main|lane/.test(word)), `a name reached the trusted reader: git ${command.join(' ')}`);
      assert.equal(attrSource, ['diff', 'grep'].includes(command[0]) ? start : undefined, `attributes come from the lane start for diff and grep only: git ${command.join(' ')}`);
      if (command[0] === 'diff') assert.deepEqual([command.includes('--ignore-submodules=none'), command.at(-1), /^[0-9a-f]{40}(\.{2,3}[0-9a-f]{40})?$/.test(command.at(-2))], [true, '--', true], command.join(' '));
      if (command[0] === 'grep') assert.match(command.slice(-2).join(' '), /^[0-9a-f]{40} --$/);
    }
    const names = trusted.map((call) => call.command[0]);
    const firstWalk = names.findIndex((name, at) => name === 'merge-base' || (name === 'rev-parse' && trusted[at].command.at(-1).endsWith('^{commit}')));
    const firstDiff = names.indexOf('diff');
    assert.ok(firstWalk > names.indexOf('index-pack'), `the commits are imported before a parent is walked: ${names.join(' ')}`);
    assert.equal(names.slice(0, firstDiff).filter((name) => name === 'index-pack').length, 2, `commits, then trees and files, are imported before the first diff: ${names.join(' ')}`);
    assert.ok(names.slice(firstDiff).every((name) => READS.has(name)), `nothing but reads after the first diff: ${names.join(' ')}`);
    assert.ok(!existsSync(trusted[0].env.GIT_DIR) && !existsSync(`${trusted[0].env.GIT_DIR}.pid`), 'the temp repository and its pid file are removed');
  }
  assert.equal(reviewed.length, 40);
});

test('security N22: a replace ref made right after the refusal check changes nothing, and the temp repository is removed after a refused run too', POSIX_ONLY, () => {
  const { dir, spied, fixRound, reviewed } = spiedLane();
  const control = spied(fixRound);
  assert.equal(control.result.status, 0, control.result.stderr);
  const late = spied(fixRound, { SPY_AFTER_REFUSALS: JSON.stringify(['replace', git(dir, 'rev-parse', 'HEAD'), reviewed]) });
  assert.equal(git(dir, 'replace', '-l'), git(dir, 'rev-parse', 'HEAD'), 'the replace ref exists: with it git shows the reviewed commit in place of the fix');
  assert.equal(late.result.status, 0, late.result.stderr);
  assert.deepEqual(view(JSON.parse(late.result.stdout)), view(JSON.parse(control.result.stdout)));
  const refused = spied(fixRound);
  assert.equal(refused.result.status, 2, 'the next run finds the replace ref');
  assert.deepEqual([...refused.trusted, ...refused.laneSide], [], 'and reads nothing');
  git(dir, 'replace', '-d', git(dir, 'rev-parse', 'HEAD'));
  const unknown = spied(['main...nowhere', '--json']);
  assert.equal(unknown.result.status, 2);
  assert.ok(unknown.trusted.length > 0 && !existsSync(unknown.trusted[0].env.GIT_DIR), 'the temp repository of a refused run is removed');
});

test('a lane in a linked worktree, and one in a folder whose name holds the path delimiter, are read like any other', POSIX_ONLY, () => {
  const { dir, json, write } = lane();
  write('src/worker.mjs', EXEC_FILE);
  const control = view(json('--landing'));
  const linked = addWorktree(dir, 'linked', 'lane-copy');
  const run = (cwd) => spawnSync(process.execPath, [CLI, 'main...lane', '--landing', '--json'], { cwd, encoding: 'utf8', env: { ...CLEAN_ENV, REVIEW_TIER_LOG: join(dir, '..', 'log.jsonl') } });
  const fromLinked = run(linked);
  assert.equal(fromLinked.status, 0, fromLinked.stderr);
  assert.deepEqual({ ...view(JSON.parse(fromLinked.stdout)), range: control.range }, control, 'the linked worktree borrows the same objects');
  const odd = join(realpathSync(makeTempDir('review-tier-odd-')), `a${delimiter}b`);
  mkdirSync(odd);
  git(odd, 'clone', '-q', dir, 'copy');
  git(join(odd, 'copy'), 'branch', '-q', 'main', 'origin/main');
  const fromOdd = run(join(odd, 'copy'));
  assert.equal(fromOdd.status, 0, fromOdd.stderr);
  assert.deepEqual({ ...view(JSON.parse(fromOdd.stdout)), range: control.range }, control);
});
