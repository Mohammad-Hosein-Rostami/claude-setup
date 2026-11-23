// Tests for home/hooks/lib/project-note-key.mjs: the repo key of a session folder and the notes found under it.
// Fixture repositories are made with real git in cs-test-* temp folders (temp-dir-helpers.mjs); a fake git stands in only for
// what a real one cannot be made to do on demand (hang, print a Windows or UNC path).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOTE_MAX_BYTES, findNotes, repoIdentity, slugKey, urlKeys } from '../home/hooks/lib/project-note-key.mjs';
import { runGit } from '../home/hooks/lib/gated-folder.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const POSIX = process.platform !== 'win32';
const TOKEN = 't0k';
const AZURE_REMOTE = `https://u:${TOKEN}@dev.azure.com/Org/P/_git/ice-web-app`;
const git = (cwd, args) => runGit(cwd, args, 5000);
const gitOk = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
};
const realTemp = (label) => realpathSync(makeTempDir(label));

/** A temp HOME and a folder inside it. */
function homeWith(...parts) {
  const home = realTemp('note-key-home-');
  const dir = join(home, ...parts);
  mkdirSync(dir, { recursive: true });
  return { home, dir };
}

test('slugKey: NFKC, lower case, runs of other characters one dash, trimmed, at most 64', () => {
  assert.equal(slugKey('Pejvak_Frontend'), 'pejvak-frontend');
  assert.equal(slugKey('ＩＣＥ  Web\nApp'), 'ice-web-app');
  assert.equal(slugKey('--'), '');
  assert.equal(slugKey(undefined), '');
  assert.equal(slugKey(`${'a'.repeat(63)}-b`), 'a'.repeat(63));
});

test('urlKeys: scheme, userinfo, host, port, .git and _git are dropped; never any part of a token', () => {
  assert.deepEqual(urlKeys(AZURE_REMOTE), ['p-ice-web-app', 'ice-web-app']);
  assert.deepEqual(urlKeys('git@github.com:Org/Repo.git'), ['org-repo', 'repo']);
  assert.deepEqual(urlKeys('ssh://git@host.example:2222/team/tool.git'), ['team-tool', 'tool']);
  assert.deepEqual(urlKeys('git@ssh.dev.azure.com:v3/Org/P/ice-web-app'), ['p-ice-web-app', 'ice-web-app']);
  assert.deepEqual(urlKeys('/srv/git/only.git'), ['git-only', 'only']);
  assert.deepEqual(urlKeys('https://host.example/solo'), ['solo']);
  assert.deepEqual(urlKeys('https://host.example/'), []);
  for (const url of [`https://u:${TOKEN}/x@host.example/p/r`, `u:${TOKEN}@host.example:p/r.git`, `https://${TOKEN}@host.example/p/r?k=${TOKEN}`]) {
    assert.ok(!urlKeys(url).join(' ').includes(TOKEN), url);
  }
});

test('repoIdentity: the remote name of a repository, its userinfo never kept', () => {
  const { home, dir } = homeWith('work', 'checkout');
  gitOk(dir, 'init', '-q');
  gitOk(dir, 'remote', 'add', 'origin', AZURE_REMOTE);
  const identity = repoIdentity(dir, { git, home });
  assert.deepEqual(identity, { top: dir, keys: ['p-ice-web-app', 'ice-web-app'], source: 'remote' });
  assert.ok(!JSON.stringify(identity).includes(TOKEN));
});

test('repoIdentity: a worktree maps to its main checkout (folder name when there is no remote)', () => {
  const { home, dir } = homeWith('work', 'Main_Repo');
  gitOk(dir, 'init', '-q');
  gitOk(dir, 'commit', '-q', '--allow-empty', '-m', 'start');
  const tree = join(home, 'work', 'lane-1');
  gitOk(dir, 'worktree', 'add', '-q', tree);
  const identity = repoIdentity(join(tree), { git, home });
  assert.equal(identity.top, tree, 'the worktree is the folder whose files are read');
  assert.deepEqual(identity.keys, ['main-repo']);
  assert.equal(identity.source, 'folder');
});

test('repoIdentity: an SVN checkout is keyed by its highest folder below HOME', () => {
  const { home, dir } = homeWith('code', 'Pejvak_Frontend', 'src', 'app');
  mkdirSync(join(home, 'code', 'Pejvak_Frontend', '.svn'));
  mkdirSync(join(home, 'code', 'Pejvak_Frontend', 'src', '.svn'));
  assert.deepEqual(repoIdentity(dir, { git, home }), { top: join(home, 'code', 'Pejvak_Frontend'), keys: ['pejvak-frontend'], source: 'svn' });
});

test('repoIdentity: no git and no SVN gives the folder name; HOME itself is no project', () => {
  const { home, dir } = homeWith('Plain Folder');
  assert.deepEqual(repoIdentity(dir, { git, home }), { top: dir, keys: ['plain-folder'], source: 'cwd' });
  assert.deepEqual(repoIdentity(home, { git, home }), { top: null, keys: [], source: 'none', reason: 'home' });
  const missingGit = () => ({ status: null, error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) });
  assert.equal(repoIdentity(dir, { git: missingGit, home }).source, 'cwd', 'git missing outside a repository: the folder rules apply');
});

test('repoIdentity: git hanging, missing or failing in a repository gives no key, never a guessed one', () => {
  const { home, dir } = homeWith('work', 'repo');
  gitOk(dir, 'init', '-q');
  const hanging = () => ({ status: null, signal: 'SIGKILL', error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) });
  assert.deepEqual(repoIdentity(dir, { git: hanging, home }), { top: null, keys: [], source: 'none', reason: 'git-failed' });
  const { dir: broken } = homeWith('work', 'broken');
  writeFileSync(join(broken, '.git'), 'gitdir: /nowhere/at/all\n');
  assert.equal(repoIdentity(broken, { git, home }).source, 'none');
  let calls = 0;
  const remoteHangs = (cwd, args) => (calls++ === 0 ? git(cwd, args) : hanging());
  assert.deepEqual(repoIdentity(dir, { git: remoteHangs, home }), { top: dir, keys: [], source: 'none', reason: 'git-failed' });
});

test('repoIdentity: Windows drive paths from git are read with Windows rules; a UNC path is not followed', () => {
  const { home, dir } = homeWith('work', 'win');
  const fake = (out) => (cwd, args) => (args[0] === 'rev-parse' ? { status: 0, stdout: out } : { status: 1, stdout: '' });
  assert.deepEqual(repoIdentity(dir, { git: fake('C:/repos/My_App/.git\nC:/repos/My_App\n'), home }).keys, ['my-app']);
  assert.deepEqual(repoIdentity(dir, { git: fake('//server/share/app/.git\n//server/share/app\n'), home }), { top: null, keys: [], source: 'none', reason: 'network' });
  assert.equal(repoIdentity('//server/share/app', { git: fake(''), home }).reason, 'network');
});

/** A notes folder with these files (name to text). */
function notesDir(files = {}) {
  const dir = realTemp('notes-');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

test('findNotes: the first key with a note in each folder; one real folder read once', () => {
  const shared = notesDir({ 'ice-web-app.md': 'shared text' });
  const personal = notesDir({ 'p-ice-web-app.md': 'specific', 'ice-web-app.md': 'short' });
  const notes = findNotes(['p-ice-web-app', 'ice-web-app'], [shared, personal]);
  assert.deepEqual(notes.map(({ key, dir, text, cut }) => ({ key, dir, text, cut })), [
    { key: 'ice-web-app', dir: shared, text: 'shared text', cut: false },
    { key: 'p-ice-web-app', dir: personal, text: 'specific', cut: false },
  ]);
  if (POSIX) {
    const link = join(realTemp('notes-link-'), 'project-notes');
    symlinkSync(shared, link);
    assert.equal(findNotes(['ice-web-app'], [shared, link]).length, 1, 'the same real folder is not read twice');
  }
});

test('findNotes: a note over 8 KiB is cut at the limit and marked', () => {
  const dir = notesDir({ 'big.md': `${'x'.repeat(NOTE_MAX_BYTES - 1)}é and more` });
  const [note] = findNotes(['big'], [dir]);
  assert.equal(note.cut, true);
  assert.ok(Buffer.byteLength(note.text) <= NOTE_MAX_BYTES);
  assert.ok(!note.text.includes('\uFFFD'), 'a character cut in half is dropped');
});

test('findNotes: a link, a hard link or a FIFO is never read', { skip: !POSIX && 'needs links and FIFOs' }, () => {
  const outside = join(realTemp('outside-'), 'secret.md');
  writeFileSync(outside, 'outside text');
  const dir = notesDir();
  symlinkSync(outside, join(dir, 'linked.md'));
  linkSync(outside, join(dir, 'hard.md'));
  assert.equal(spawnSync('mkfifo', [join(dir, 'fifo.md')]).status, 0);
  assert.deepEqual(findNotes(['linked', 'hard', 'fifo'], [dir]), []);
  assert.deepEqual(findNotes(['../outside'], [dir]), [], 'a key that is no slug is never a path');
});
