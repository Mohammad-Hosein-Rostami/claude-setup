// Tests for the personal layer of an install (scripts/install/personal.mjs and personal-folder.mjs, through scripts/install.mjs): the generated
// ~/.claude/CLAUDE.md, personal/ made from personal.example/, the owner's notes (untracked, or deleted by a pull) moved out of home/project-notes, the
// project-notes link, --uninstall, and the callers that follow the new layout (isNewMachine).
// Exports: none (node:test file). Every installer run uses a temp HOME and a copy of the repo in a cs-test- folder (git init'ed,
// only home/project-notes/README.md tracked there), with --no-plugins --no-tools; it needs jq and git like every install.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_MD_MARKER, checkImportPath, claudeMdText, importPath } from '../scripts/install/personal.mjs';
import { isNewMachine } from '../scripts/install/settings.mjs';
import { INSTALL_LOCK_STALE_MS, RECORD_NAME } from '../scripts/install/record.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { cleanEnv } from './clean-env.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const skip = spawnSync('jq', ['--version']).status === 0 ? false : 'jq not installed';
const COPIED = ['scripts', 'settings', 'personal.example', 'home', '.gitignore'];
const git = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });

/** A copy of the repo at `<cs-test folder>/<name>`: a git repo whose only tracked file is home/project-notes/README.md. */
function checkout(name = 'repo') {
  const repo = join(realpathSync(makeTempDir('personal-repo-')), name); // the installer names its repo by real path (/tmp is a link)
  const kept = (src) => {
    const rel = relative(REPO, src).split(sep);
    if (rel.includes('node_modules')) return false;
    return !(rel[0] === 'home' && rel[1] === 'project-notes' && rel[2] && rel[2] !== 'README.md');
  };
  for (const part of COPIED) cpSync(join(REPO, part), join(repo, part), { recursive: true, filter: kept, verbatimSymlinks: true });
  git(repo, 'init', '-q');
  git(repo, 'add', 'home/project-notes/README.md');
  return repo;
}

const newHome = () => makeTempDir('personal-home-');
function run(repo, home, ...flags) {
  const args = [join(repo, 'scripts', 'install.mjs'), ...flags, ...(flags.includes('--uninstall') ? [] : ['--no-plugins', '--no-tools'])];
  return spawnSync(process.execPath, args, { env: cleanEnv({ HOME: home, USERPROFILE: home }), encoding: 'utf8' });
}
const claudeMd = (home) => join(home, '.claude', 'CLAUDE.md');
const backups = (home) => readdirSync(home).filter((name) => name.startsWith('.claude-backup-'));
const exists = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};
const expected = (repo, withPersonal = true) =>
  [
    `${CLAUDE_MD_MARKER}; edit ${repo}/home/CLAUDE.md (shared) or ${repo}/personal/CLAUDE.md (yours) -->`,
    `@${repo}/home/CLAUDE.md`,
    ...(withPersonal ? [`@${repo}/personal/CLAUDE.md`] : []),
    '',
  ].join('\n');

test('fresh HOME: CLAUDE.md is a regular file of the marker and both imports; personal/ comes from the template as a git repo', { skip }, () => {
  const repo = checkout();
  const home = newHome();
  const result = run(repo, home);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(lstatSync(claudeMd(home)).isFile(), 'a regular file, not a link');
  assert.equal(readFileSync(claudeMd(home), 'utf8'), expected(repo));
  for (const file of ['CLAUDE.md', 'share-deny.txt', join('project-notes', 'README.md')]) {
    assert.equal(readFileSync(join(repo, 'personal', file), 'utf8'), readFileSync(join(repo, 'personal.example', file), 'utf8'), file);
  }
  assert.ok(existsSync(join(repo, 'personal', '.git')), 'personal/ is its own git repo');
  const personal = join(repo, 'personal');
  assert.equal(git(personal, 'log', '--format=%s|%ae').stdout, 'personal layer: first commit by scripts/install.sh|install@claude-setup.invalid\n', 'one first commit; no git identity in the temp HOME: the stand-in');
  assert.equal(git(personal, 'status', '--porcelain').stdout, '', 'every template file is in that commit');
  assert.equal(readlinkSync(join(home, '.claude', 'project-notes')), join(repo, 'personal', 'project-notes'));
  assert.doesNotMatch(git(repo, 'clean', '-fdxn').stdout, /^Would remove personal\//m, 'git clean -fdx in the clone skips personal/');
  assert.deepEqual(readdirSync(repo).filter((name) => name.startsWith('.personal-')), [], 'no staging folder is left');
  assert.deepEqual(backups(home), []);
});

test('a second run writes nothing and makes no backup', { skip }, () => {
  const repo = checkout();
  const home = newHome();
  assert.equal(run(repo, home).status, 0);
  const before = lstatSync(claudeMd(home)).mtimeMs;
  const record = readFileSync(join(home, '.claude', RECORD_NAME), 'utf8');
  const again = run(repo, home);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /ok CLAUDE\.md/);
  assert.equal(lstatSync(claudeMd(home)).mtimeMs, before);
  assert.equal(readFileSync(join(home, '.claude', RECORD_NAME), 'utf8'), record);
  assert.deepEqual(backups(home), []);
});

test('an existing personal/ (a repo with a commit) is never overwritten; no personal/CLAUDE.md means no third line', { skip }, () => {
  const repo = checkout();
  const personal = join(repo, 'personal');
  mkdirSync(join(personal, 'project-notes'), { recursive: true });
  writeFileSync(join(personal, 'project-notes', 'mine.md'), 'my note\n');
  git(personal, 'init', '-q');
  git(personal, 'add', '-A');
  git(personal, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'mine');
  const head = git(personal, 'rev-parse', 'HEAD').stdout;
  const home = newHome();
  assert.equal(run(repo, home).status, 0);
  assert.equal(readFileSync(claudeMd(home), 'utf8'), expected(repo, false), 'line 3 only when personal/CLAUDE.md exists');
  assert.deepEqual(readdirSync(personal).sort(), ['.git', 'project-notes'], 'no template file added');
  assert.equal(readFileSync(join(personal, 'project-notes', 'mine.md'), 'utf8'), 'my note\n');
  assert.equal(git(personal, 'rev-parse', 'HEAD').stdout, head);
  writeFileSync(join(personal, 'CLAUDE.md'), '');
  assert.equal(run(repo, home).status, 0);
  assert.equal(readFileSync(claudeMd(home), 'utf8'), expected(repo), 'an empty personal/CLAUDE.md still exists: line 3');
  assert.deepEqual(backups(home), [], 'the text the installer wrote before is replaced without a backup');
  assert.equal(readFileSync(join(personal, 'CLAUDE.md'), 'utf8'), '');
});

test('a re-install backs up a CLAUDE.md that starts with the marker but holds the user\'s own lines', { skip }, () => {
  const repo = checkout();
  const home = newHome();
  assert.equal(run(repo, home).status, 0);
  const edited = `${expected(repo)}- mine\n`;
  writeFileSync(claudeMd(home), edited);
  const again = run(repo, home);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(claudeMd(home), 'utf8'), expected(repo));
  const [saved] = backups(home);
  assert.equal(readFileSync(join(home, saved, '.claude', 'CLAUDE.md'), 'utf8'), edited, 'the edited file is in the backup folder');
});

test('the record lists CLAUDE.md under written with its sha256, never under made (an older uninstaller deletes made kinds it does not know)', { skip }, () => {
  const repo = checkout();
  const home = newHome();
  assert.equal(run(repo, home).status, 0);
  const record = JSON.parse(readFileSync(join(home, '.claude', RECORD_NAME), 'utf8'));
  assert.deepEqual(record.made.filter((entry) => entry.path === claudeMd(home)), []);
  assert.deepEqual(record.written, [{ path: claudeMd(home), sha256: createHash('sha256').update(expected(repo)).digest('hex') }]);
});

test('a repo path with whitespace exits 1 naming it, and nothing under HOME changes', { skip }, () => {
  const repo = checkout('my repo');
  const home = newHome();
  const result = run(repo, home);
  assert.equal(result.status, 1, result.stdout);
  assert.ok(result.stderr.includes(JSON.stringify(repo)), result.stderr);
  assert.deepEqual(readdirSync(home), []);
  assert.equal(existsSync(join(repo, 'personal')), false);
});

test('odd paths are refused, plain and Windows ones are written with forward slashes', () => {
  for (const bad of ['/a b/repo', '/a@b/repo', '/a#b/repo', "/a'b/repo", '/a"b/repo', '/räpo', 'relative/repo']) {
    assert.throws(() => checkImportPath(bad), { exitCode: 1, message: new RegExp(JSON.stringify(bad).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')) }, bad);
  }
  for (const good of ['/Users/x/claude-setup', 'C:\\Users\\RUNNER~1\\claude-setup', '/tmp/cs-test-a_b.c']) checkImportPath(good);
  assert.equal(importPath('C:\\Users\\x\\claude-setup'), 'C:/Users/x/claude-setup');
  const text = claudeMdText({ root: 'C:\\Users\\x\\cs', repo: 'C:\\Users\\x\\cs' }, true);
  assert.match(text, /^@C:\/Users\/x\/cs\/home\/CLAUDE\.md$/m);
  assert.match(text, /^@C:\/Users\/x\/cs\/personal\/CLAUDE\.md$/m);
});

test('an old CLAUDE.md link into home/ is replaced without a backup, recorded or not', { skip }, () => {
  for (const recorded of [false, true]) {
    const repo = checkout();
    const home = newHome();
    mkdirSync(join(home, '.claude'));
    symlinkSync(join(repo, 'home', 'CLAUDE.md'), claudeMd(home));
    if (recorded) {
      const made = [{ kind: 'link', path: claudeMd(home) }];
      writeFileSync(join(home, '.claude', RECORD_NAME), JSON.stringify({ version: 1, repo, root: repo, tag: null, firstLayer: null, made, backups: [] }));
    }
    const result = run(repo, home);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(lstatSync(claudeMd(home)).isFile());
    assert.equal(readFileSync(claudeMd(home), 'utf8'), expected(repo));
    assert.deepEqual(backups(home), [], `recorded: ${recorded}`);
    assert.equal(readFileSync(join(repo, 'home', 'CLAUDE.md'), 'utf8'), readFileSync(join(REPO, 'home', 'CLAUDE.md'), 'utf8'), 'the link target is untouched');
  }
});

test('a CLAUDE.md the user wrote is backed up first, and --uninstall puts it back', { skip }, () => {
  const repo = checkout();
  const home = newHome();
  mkdirSync(join(home, '.claude'));
  writeFileSync(claudeMd(home), '# my own rules\n');
  assert.equal(run(repo, home).status, 0);
  const [saved] = backups(home);
  assert.equal(readFileSync(join(home, saved, '.claude', 'CLAUDE.md'), 'utf8'), '# my own rules\n');
  const undo = run(repo, home, '--uninstall');
  assert.equal(undo.status, 0, undo.stderr);
  assert.equal(readFileSync(claudeMd(home), 'utf8'), '# my own rules\n');
  assert.equal(exists(join(home, '.claude', 'project-notes')), false);
  assert.ok(existsSync(join(repo, 'personal', 'CLAUDE.md')), 'personal/ stays');
});

test('--uninstall removes CLAUDE.md only while it holds exactly the text the installer wrote', { skip }, () => {
  for (const edit of [() => '# I changed it\n', (text) => `${text}- mine\n`]) {
    const repo = checkout();
    const home = newHome();
    assert.equal(run(repo, home).status, 0);
    const edited = edit(readFileSync(claudeMd(home), 'utf8'));
    writeFileSync(claudeMd(home), edited);
    const kept = run(repo, home, '--uninstall');
    assert.equal(kept.status, 0, kept.stderr);
    assert.ok(kept.stderr.includes(`${claudeMd(home)} changed since the installer wrote it (your lines are in it); left as it is`), kept.stderr);
    assert.equal(readFileSync(claudeMd(home), 'utf8'), edited, 'the user lines stay, marker line or not');
  }
  const [repo2, home2] = [checkout(), newHome()];
  assert.equal(run(repo2, home2).status, 0);
  assert.equal(run(repo2, home2, '--uninstall').status, 0);
  assert.deepEqual(readdirSync(home2).filter((name) => name !== '.zshrc' && name !== '.bashrc'), [], 'HOME is as before the install');
});

test('owner upgrade: untracked notes in home/project-notes move to personal/project-notes; a taken name goes to the backup', { skip }, () => {
  const repo = checkout();
  const notes = join(repo, 'home', 'project-notes');
  writeFileSync(join(notes, 'work-app.md'), 'work app note\n');
  writeFileSync(join(notes, 'taken.md'), 'core copy\n');
  mkdirSync(join(repo, 'personal', 'project-notes'), { recursive: true });
  writeFileSync(join(repo, 'personal', 'project-notes', 'taken.md'), 'personal copy\n');
  const home = newHome();
  const result = run(repo, home);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(repo, 'personal', 'project-notes', 'work-app.md'), 'utf8'), 'work app note\n');
  assert.equal(readFileSync(join(repo, 'personal', 'project-notes', 'taken.md'), 'utf8'), 'personal copy\n', 'never overwritten');
  assert.deepEqual(readdirSync(notes), ['README.md'], 'the tracked README stays, the rest left');
  const personalLog = git(join(repo, 'personal'), 'log', '--format=%s', '--name-only').stdout;
  assert.match(personalLog, /^project notes moved here from the core home\/project-notes by scripts\/install\.sh\n\nproject-notes\/work-app\.md\n/, 'the moved note is committed');
  assert.match(personalLog, /personal layer: first commit by scripts\/install\.sh\n\nproject-notes\/taken\.md\n$/, 'the folder that was no repo got a first commit of what it held');
  assert.equal(git(join(repo, 'personal'), 'status', '--porcelain').stdout, '');
  const record = JSON.parse(readFileSync(join(home, '.claude', RECORD_NAME), 'utf8'));
  assert.equal(readFileSync(record.backups.find((entry) => entry.path.endsWith('taken.md')).backup, 'utf8'), 'core copy\n');
  assert.equal(run(repo, home, '--uninstall').status, 0);
  assert.equal(readFileSync(join(notes, 'work-app.md'), 'utf8'), 'work app note\n', 'moved back on --uninstall');
  assert.equal(readFileSync(join(notes, 'taken.md'), 'utf8'), 'core copy\n', 'the backup comes back too');
});

/** Commits the staged files of `repo` with a stand-in identity (the temp HOME has none). */
const commit = (repo, message) => git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', message);

test('a pull that deleted tracked notes before the install: they come back from the commits HEAD was at, into personal/', { skip }, () => {
  const repo = checkout();
  const notes = join(repo, 'home', 'project-notes');
  writeFileSync(join(notes, 'alpha-app.md'), 'alpha note\n');
  writeFileSync(join(notes, 'beta-app.md'), 'beta note, old\n');
  git(repo, 'add', 'home/project-notes');
  commit(repo, 'notes tracked in core');
  writeFileSync(join(notes, 'beta-app.md'), 'beta note, newest\n');
  git(repo, 'add', 'home/project-notes');
  commit(repo, 'beta note edited');
  git(repo, 'rm', '-q', 'home/project-notes/alpha-app.md', 'home/project-notes/beta-app.md');
  commit(repo, 'notes leave core'); // what a ff pull does to the files: gone from disk and from the index
  const home = newHome();
  const result = run(repo, home);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(home, '.claude', 'project-notes', 'alpha-app.md'), 'utf8'), 'alpha note\n');
  assert.equal(readFileSync(join(repo, 'personal', 'project-notes', 'beta-app.md'), 'utf8'), 'beta note, newest\n', 'the newest version');
  assert.deepEqual(readdirSync(notes), ['README.md']);
  assert.equal(git(repo, 'status', '--porcelain', '--', 'home/project-notes').stdout, '', 'the core index is untouched');
  assert.equal(git(join(repo, 'personal'), 'status', '--porcelain').stdout, '', 'the recovered notes are committed in personal/');
  rmSync(join(repo, 'personal', 'project-notes', 'alpha-app.md'));
  assert.equal(run(repo, home).status, 0);
  assert.equal(exists(join(repo, 'personal', 'project-notes', 'alpha-app.md')), false, 'a note deleted from personal/ later is not brought back');
});

test('a checkout whose own HEAD never held the notes (a fresh clone) recovers none', { skip }, () => {
  const repo = checkout();
  writeFileSync(join(repo, 'home', 'project-notes', 'alpha-app.md'), 'alpha note\n');
  git(repo, 'add', 'home/project-notes');
  commit(repo, 'notes tracked in core');
  git(repo, 'rm', '-q', 'home/project-notes/alpha-app.md');
  commit(repo, 'notes leave core');
  git(repo, 'reflog', 'expire', '--expire=now', '--all');
  const result = run(repo, newHome());
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(join(repo, 'personal', 'project-notes')), ['README.md']);
});

test('after the layer is installed, a new note in home/project-notes not yet committed stays in core', { skip }, () => {
  const repo = checkout();
  const home = newHome();
  assert.equal(run(repo, home).status, 0);
  writeFileSync(join(repo, 'home', 'project-notes', 'shared-draft.md'), 'a shared note to commit\n');
  const again = run(repo, home);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(join(repo, 'home', 'project-notes', 'shared-draft.md'), 'utf8'), 'a shared note to commit\n');
  assert.equal(exists(join(repo, 'personal', 'project-notes', 'shared-draft.md')), false);
});

test('a staging folder a stopped install left is removed once older than a live install; a young one stays', { skip }, () => {
  const repo = checkout();
  const old = join(repo, '.personal-AbC123');
  const young = join(repo, '.personal-XyZ789');
  for (const dir of [old, young]) {
    mkdirSync(dir);
    writeFileSync(join(dir, 'CLAUDE.md'), 'half a copy\n');
  }
  const longAgo = new Date(Date.now() - 2 * INSTALL_LOCK_STALE_MS);
  utimesSync(old, longAgo, longAgo);
  const result = run(repo, newHome());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(exists(old), false, 'the stopped install\'s copy is gone');
  assert.ok(exists(young), 'a copy that may be a running install\'s stays');
});

test('a personal/ that is a link out of the repo gets nothing written through it: no note moved, no git init', { skip }, () => {
  const repo = checkout();
  const outside = makeTempDir('personal-outside-');
  mkdirSync(join(outside, 'project-notes'));
  symlinkSync(outside, join(repo, 'personal'));
  writeFileSync(join(repo, 'home', 'project-notes', 'work-app.md'), 'work app note\n');
  const result = run(repo, newHome());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /is not a plain folder/);
  assert.deepEqual(readdirSync(outside), ['project-notes']);
  assert.deepEqual(readdirSync(join(outside, 'project-notes')), []);
  assert.equal(readFileSync(join(repo, 'home', 'project-notes', 'work-app.md'), 'utf8'), 'work app note\n');
});

test('--dry-run on a fresh copy makes no personal/ and names the CLAUDE.md write with both imports', { skip }, () => {
  const repo = checkout();
  const home = newHome();
  const result = run(repo, home, '--dry-run');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`write ${claudeMd(home)}: @${repo}/home/CLAUDE.md @${repo}/personal/CLAUDE.md`), result.stdout);
  assert.equal(existsSync(join(repo, 'personal')), false);
  assert.deepEqual(readdirSync(home), []);
});

test('two installs at once on one fresh copy (two HOMEs) make personal/ once and both succeed', { skip }, async () => {
  const repo = checkout();
  const { spawn } = await import('node:child_process');
  const once = (home) =>
    new Promise((done) => {
      const child = spawn(process.execPath, [join(repo, 'scripts', 'install.mjs'), '--no-plugins', '--no-tools'], { env: cleanEnv({ HOME: home, USERPROFILE: home }) });
      child.on('exit', done);
    });
  const homes = [newHome(), newHome()];
  assert.deepEqual(await Promise.all(homes.map(once)), [0, 0]);
  assert.ok(existsSync(join(repo, 'personal', '.git')));
  assert.deepEqual(readdirSync(repo).filter((name) => name.startsWith('.personal-')), []);
  for (const home of homes) assert.equal(readFileSync(claudeMd(home), 'utf8'), expected(repo));
});

test('isNewMachine: the generated CLAUDE.md marks a machine installed before, even with its record gone', () => {
  const home = newHome();
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir);
  writeFileSync(join(claudeDir, 'settings.json'), '{}');
  const ctx = { claudeDir, repo: REPO };
  writeFileSync(join(claudeDir, 'CLAUDE.md'), expected(REPO));
  assert.equal(isNewMachine(ctx, { fresh: true }), false);
  writeFileSync(join(claudeDir, 'CLAUDE.md'), '# the machine owner\'s own\n');
  assert.equal(isNewMachine(ctx, { fresh: true }), true);
});
