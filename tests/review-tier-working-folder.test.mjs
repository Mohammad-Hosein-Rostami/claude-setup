// Tests of where review-tier asks the lane's own repository (lane r7-delta, fix round 5, B14 and K6): always in its working folder, and
// only when that folder is inside its work tree. A `core.worktree` setting in the lane's config made `--show-toplevel` name another
// repository, whose HEAD and objects the tool then read while the runner reported the lane's real HEAD (probe p27 of the security
// review); an absorbed submodule sets `core.worktree` honestly and must keep working (probe pE of the spec check).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { CLEAN_ENV, addWorktree, git } from './git-tidy-helpers.mjs';
import { CLI, lane, priorFile, sha256Of } from './review-tier-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const GATE_OPEN = "export function decide(cmd) {\n  return 'allow';\n}\n";
const GATE_GUARDED = "export function decide(cmd) {\n  if (cmd.includes(';')) return 'deny';\n  return 'allow';\n}\n";
const GATE_RUNS = "import { execSync } from 'node:child_process';\nexport function decide(cmd) {\n  if (cmd.includes(';')) return 'deny';\n  execSync(cmd);\n  return 'allow';\n}\n";
const view = ({ tier, classes, files, changedLines, base, tip, fileClasses }) => ({ tier, classes, files, changedLines, base, tip, fileClasses });
/** The CLI run in `cwd`, which need not be the top folder of a repository made by lane(). */
const runIn = (cwd, log, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...CLEAN_ENV, REVIEW_TIER_LOG: log } });

test('security B14 (probe p27): a core.worktree setting that points the lane\'s worktree at another repository is exit 2, not a review of that other repository', () => {
  const { dir, log, write } = lane();
  git(dir, 'checkout', '-q', 'main');
  const start = write('src/gate.mjs', GATE_OPEN);
  const worktree = addWorktree(dir, 'w', 'lane-t');
  const commitIn = (folder, message) => { git(folder, 'commit', '-q', '-a', '-m', message); return git(folder, 'rev-parse', 'HEAD'); };
  const put = (folder, path, text) => spawnSync(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], process.argv[2])', join(folder, path), text]);
  put(worktree, 'src/gate.mjs', GATE_GUARDED);
  const reviewed = commitIn(worktree, 'feat: guard');
  put(worktree, 'src/gate.mjs', GATE_RUNS);
  const fix = commitIn(worktree, 'fix: run the command');
  const prior = priorFile();
  const fixRound = ['--delta', reviewed, '--base', start, '--prior', prior, '--prior-sha256', sha256Of(prior), '--lane-classes', 'logic,docs', '--json'];
  const control = runIn(worktree, log, ...fixRound);
  assert.equal(control.status, 0, control.stderr);
  assert.deepEqual([JSON.parse(control.stdout).tier, JSON.parse(control.stdout).tip], [2, fix], 'the control round reads the fix and its execSync call');
  // The other repository: a clone at the reviewed commit with a docs-only commit on top.
  const other = join(realpathSync(makeTempDir('review-tier-other-')), 'x');
  git(join(other, '..'), 'clone', '-q', dir, other);
  git(other, 'checkout', '-q', reviewed);
  put(other, 'base.txt', 'docs only\n');
  git(other, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-a', '-m', 'docs only');
  git(worktree, 'config', 'extensions.worktreeConfig', 'true');
  git(worktree, 'config', '--worktree', 'core.worktree', other);
  assert.equal(git(worktree, 'rev-parse', 'HEAD'), fix, 'the runner still reads the real fix as HEAD');
  assert.equal(realpathSync(git(worktree, 'rev-parse', '--show-toplevel')), realpathSync(other), 'while git names the other repository as the top folder');
  for (const args of [fixRound, ['main...HEAD', '--json'], ['--json']]) {
    const redirected = runIn(worktree, log, ...args);
    assert.equal(redirected.status, 2, `${args[0]}: ${redirected.stderr}\n${redirected.stdout.slice(0, 300)}`);
    assert.equal(redirected.stdout, '', 'no review set is printed');
    assert.match(redirected.stderr, /is not inside the work tree of its git repository .*core\.worktree/);
  }
});

test('spec check K6 (probe pE): a lane inside an absorbed submodule, whose own git dir sets core.worktree, is reviewed like any other', () => {
  const root = realpathSync(makeTempDir('review-tier-submodule-'));
  const [library, app] = [join(root, 'lib'), join(root, 'app')];
  for (const repo of [library, app]) {
    git(root, 'init', '-q', '-b', 'main', repo);
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'first');
  }
  git(app, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', library, 'vendor/lib');
  const inside = join(app, 'vendor', 'lib');
  assert.notEqual(git(inside, 'config', '--get', 'core.worktree'), '', 'the submodule\'s git dir sets core.worktree itself');
  git(inside, 'checkout', '-q', '-b', 'lane');
  spawnSync(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], process.argv[2])', join(inside, 'run.mjs'), GATE_RUNS]);
  git(inside, 'add', '--', 'run.mjs');
  git(inside, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'feat: run');
  const result = runIn(inside, join(root, 'log.jsonl'), 'main...HEAD', '--json');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual([report.files, report.classes.includes('security'), report.tip], [1, true, git(inside, 'rev-parse', 'HEAD')]);
});

test('the lane is read from a sub-folder of its work tree like from its top folder; the .git folder and a bare repository are exit 2', () => {
  const { dir, log, write } = lane();
  write('src/deep/run.mjs', GATE_RUNS);
  const top = runIn(dir, log, 'main...HEAD', '--json');
  const deep = runIn(join(dir, 'src', 'deep'), log, 'main...HEAD', '--json');
  assert.equal(deep.status, 0, deep.stderr);
  assert.deepEqual(view(JSON.parse(deep.stdout)), view(JSON.parse(top.stdout)));
  const bare = join(realpathSync(makeTempDir('review-tier-bare-')), 'bare.git');
  git(join(bare, '..'), 'clone', '-q', '--bare', dir, bare);
  for (const folder of [join(dir, '.git'), bare]) {
    const result = runIn(folder, log, 'main...HEAD', '--json');
    assert.equal(result.status, 2, `${folder}: ${result.stderr}`);
    assert.match(result.stderr, /is not inside the work tree of its git repository/);
  }
  const nowhere = realpathSync(makeTempDir('review-tier-nowhere-'));
  mkdirSync(join(nowhere, 'plain'));
  const outside = spawnSync(process.execPath, [CLI, '--json'], { cwd: join(nowhere, 'plain'), encoding: 'utf8', env: { ...CLEAN_ENV, REVIEW_TIER_LOG: log, GIT_CEILING_DIRECTORIES: nowhere } });
  assert.equal(outside.status, 1, 'a folder in no repository stays "git failed"');
  assert.match(outside.stderr, /git failed: /);
});
