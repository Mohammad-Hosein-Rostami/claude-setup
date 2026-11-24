// The board's git facts (spec R18 "Git facts", owner decisions RC15 and RC19): every field of `repo.active` from a real refresh of a
// cs-test repository with staged, changed and new files, a stash, a conflict, a rebase stopped at step 2 of 3 and a lane worktree;
// the repository-config programs a refresh must never run (filter, fsmonitor: F1); names that are never options and reach the board
// cleaned (F2); cached values kept with their age past the git budget (F3); new files counted only on the session's worktree and at
// most 4 active branches (F5); repositories used by the lead's edits;
// a FIFO among a repository's files never hangs the refresh; a lane nested in the main checkout is the only current worktree; no git
// call starts past the git budget (a slow-git stand-in records each call).
// Every repository and HOME is a temp `cs-test-*` folder; git runs with a fixed identity and no global or system config.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cleanName, repoState } from '../home/tools/board/lib/git-state.mjs';
import { collectBoard } from '../home/tools/board/lib/refresh.mjs';
import { repoStats } from '../home/tools/board/lib/repo-stats.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { cleanEnv } from './clean-env.mjs';

const BOARD = fileURLToPath(new URL('../home/tools/board/board.mjs', import.meta.url));
const GIT_STATE = new URL('../home/tools/board/lib/git-state.mjs', import.meta.url).href;
const SESSION = '11111111-2222-4333-8444-555555555555';
const POSIX_ONLY = { skip: process.platform === 'win32' ? 'no FIFO, mkfifo or sh stand-in for git on Windows' : false };
const HANG_LIMIT_MS = 10_000; // a refresh child still running after this has hung
const SLOW_GIT_S = 0.15; // each stand-in git call takes at least this long: two calls pass the 250 ms git budget
const ROOT = realpathSync(makeTempDir('board-git-')); // removed when the process ends (temp-dir-helpers.mjs)
const HOME = join(ROOT, 'home');
mkdirSync(HOME);

const GIT_ENV = {
  ...Object.fromEntries(Object.entries(cleanEnv()).filter(([name]) => !name.startsWith('GIT_'))), HOME, GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const gitMayFail = (cwd, ...args) => { try { git(cwd, ...args); } catch { /* the expected conflict stop */ } };
const put = (path, text) => writeFileSync(path, text);

/** A repository with one commit on main. */
function newRepo(name) {
  const dir = join(ROOT, name);
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  put(join(dir, 'f1'), '1\n');
  put(join(dir, 'c.txt'), 'c\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'c1');
  return dir;
}

/** The checkpoint repository: upstream, a lane worktree stopped in a rebase at 2/3 with a conflict, a stash, staged, changed, new. */
function checkpointRepo() {
  const dir = newRepo('repo');
  git(ROOT, 'clone', '-q', '--bare', dir, join(ROOT, 'origin.git'));
  git(dir, 'remote', 'add', 'origin', join(ROOT, 'origin.git'));
  git(dir, 'fetch', '-q', 'origin');
  git(dir, 'branch', '-q', '-u', 'origin/main');
  const lane = join(ROOT, 'wt-lane');
  git(dir, 'worktree', 'add', '-q', '-b', 'lane', lane, 'main');
  for (const [file, text] of [['a.txt', 'a\n'], ['f1', 'lane\n'], ['b.txt', 'b\n']]) {
    put(join(lane, file), text);
    git(lane, 'add', file);
    git(lane, 'commit', '-qm', `lane ${file}`);
  }
  put(join(dir, 'f1'), 'main\n');
  git(dir, 'commit', '-qam', 'main f1');
  gitMayFail(lane, 'rebase', 'main');
  put(join(lane, 'lane-new.txt'), 'n\n'); // new, but not on the session's worktree: never counted
  put(join(dir, 'c.txt'), 'stashed\n');
  git(dir, 'stash', '-q');
  put(join(dir, 's.txt'), 's\n');
  git(dir, 'add', 's.txt');
  put(join(dir, 'c.txt'), 'changed\n');
  put(join(dir, 'u.txt'), 'u\n');
  return { dir, lane };
}

const FIELDS = ['name', 'current', 'upstream', 'upAhead', 'upBehind', 'ahead', 'behind', 'ageMin', 'worktree', 'agents', 'staged',
  'changed', 'untracked', 'conflicts', 'op', 'opStep'];

test('checkpoint: board.mjs refresh --force writes every spec field of repo.active', () => {
  const { dir } = checkpointRepo();
  execFileSync(process.execPath, [BOARD, 'refresh', '--session', SESSION, '--force'], { cwd: dir, env: cleanEnv({ HOME }), stdio: 'ignore' });
  const board = JSON.parse(readFileSync(join(HOME, '.claude', 'state', 'board', `${SESSION}.json`), 'utf8'));
  const { repo } = board;
  assert.equal(repo.trust, 'full');
  assert.equal(repo.stash, 1);
  assert.equal(Object.hasOwn(repo, 'check'), false, 'the board carries no check verdict');
  for (const branch of repo.active) assert.deepEqual(Object.keys(branch).sort(), [...FIELDS].sort(), branch.name);
  const main = repo.active.find((branch) => branch.name === 'main');
  assert.deepEqual({ current: main.current, upstream: main.upstream, upAhead: main.upAhead, upBehind: main.upBehind, staged: main.staged, changed: main.changed,
    untracked: main.untracked, conflicts: main.conflicts, op: main.op, worktree: main.worktree },
  { current: true, upstream: 'origin/main', upAhead: 1, upBehind: 0, staged: 1, changed: 1, untracked: 1, conflicts: 0, op: null, worktree: 'main' });
  const laneBranch = repo.active.find((branch) => branch.name === 'lane');
  assert.deepEqual({ op: laneBranch.op, opStep: laneBranch.opStep, conflicts: laneBranch.conflicts, untracked: laneBranch.untracked, worktree: laneBranch.worktree,
    ahead: laneBranch.ahead, behind: laneBranch.behind, current: laneBranch.current, upstream: laneBranch.upstream },
  { op: 'rebase', opStep: '2/3', conflicts: 1, untracked: null, worktree: 'wt-lane', ahead: 3, behind: 1, current: false, upstream: null });
  assert.equal(repo.active[0].name, 'main', 'the current branch shows first');
  assert.ok(Number.isInteger(main.ageMin) && main.ageMin >= 0);
});

test('F1: a repository config filter and fsmonitor never run; the worktree gets refs only', () => {
  const dir = newRepo('hostile');
  put(join(ROOT, 'evil.cfg'), `[filter "evil"]\n\tclean = touch ${join(ROOT, 'FILTER_RAN')}; cat\n`);
  put(join(ROOT, 'fsm.sh'), `#!/bin/sh\ntouch ${join(ROOT, 'FSMONITOR_RAN')}\n`);
  chmodSync(join(ROOT, 'fsm.sh'), 0o755);
  git(dir, 'config', 'include.path', join(ROOT, 'evil.cfg'));
  git(dir, 'config', 'core.fsmonitor', join(ROOT, 'fsm.sh'));
  put(join(dir, '.gitattributes'), '* filter=evil\n');
  put(join(dir, 'f1'), 'edited\n');
  const { repo } = repoState({ cwd: dir, sessionFolder: dir, common: join(dir, '.git'), cache: null, nowMs: Date.now() });
  assert.equal(existsSync(join(ROOT, 'FILTER_RAN')), false, 'the clean filter ran');
  assert.equal(existsSync(join(ROOT, 'FSMONITOR_RAN')), false, 'the fsmonitor hook ran');
  assert.equal(repo.trust, 'refs');
  assert.deepEqual([repo.active[0].name, repo.active[0].staged, repo.active[0].changed], ['main', null, null]);

  git(dir, 'config', '--unset', 'include.path'); // fsmonitor alone: status runs, the hook does not
  const fsmOnly = repoState({ cwd: dir, sessionFolder: dir, common: join(dir, '.git'), cache: null, nowMs: Date.now() }).repo;
  assert.equal(fsmOnly.trust, 'full');
  assert.equal(fsmOnly.active[0].changed, 1);
  assert.equal(existsSync(join(ROOT, 'FSMONITOR_RAN')), false, 'the fsmonitor hook ran');
});

test('F2: branch names with control or bidi characters are cleaned; a leading-dash head is never the base', () => {
  assert.equal(cleanName('a\u001b[31mb\u202ec'), 'a [31mb c');
  const dir = newRepo('names');
  git(dir, 'update-ref', 'refs/heads/-evil', 'HEAD');
  git(dir, 'update-ref', 'refs/heads/main\u202erev', 'HEAD');
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/-evil');
  git(dir, 'branch', '-q', '-D', 'main');
  put(join(dir, 'f1'), 'dirty\n');
  const { repo } = repoState({ cwd: dir, sessionFolder: dir, common: join(dir, '.git'), cache: null, nowMs: Date.now() });
  assert.equal(repo.base, null, 'a leading-dash branch was taken as the base');
  assert.equal(repo.active[0].name, '-evil');
  assert.equal(JSON.stringify(repo).includes('\u202e'), false);
});

test('F3: past the git budget the cached status stays with its age', () => {
  const dir = newRepo('budget');
  const common = join(dir, '.git');
  const first = repoState({ cwd: dir, sessionFolder: dir, common, cache: null, nowMs: 1_000 });
  put(join(dir, 'f1'), 'changed later\n');
  git(dir, 'add', 'f1');
  const spent = repoState({ cwd: dir, sessionFolder: dir, common, cache: first.cache, nowMs: 100_000, startMs: Date.now() - 10_000 });
  assert.equal(spent.repo.worktrees[0].checkedMs, 1_000);
  assert.equal(spent.repo.worktrees[0].staged, 0, 'git ran past its budget');
});

test('F5: at most 4 active branches, the rest counted; old and landed branches are not active', () => {
  const dir = newRepo('many');
  for (const n of [1, 2, 3, 4, 5, 6]) {
    git(dir, 'switch', '-q', '-c', `work-${n}`, 'main');
    put(join(dir, `w${n}`), `${n}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', `w${n}`);
  }
  git(dir, 'switch', '-q', 'main');
  git(dir, 'branch', '-q', 'landed', 'main');
  const { repo } = repoState({ cwd: dir, sessionFolder: dir, common: join(dir, '.git'), cache: null, nowMs: Date.now() });
  assert.equal(repo.active.length, 4);
  assert.equal(repo.activeMore, 3, 'main is current; the other 6 ahead branches fill the cap');
  assert.equal(repo.active.some((branch) => branch.name === 'landed'), false);
  const old = repoState({ cwd: dir, sessionFolder: dir, common: join(dir, '.git'), cache: null, nowMs: Date.now() + 2 * 24 * 3_600_000 });
  assert.deepEqual(old.repo.active.map((branch) => branch.name), ['main'], 'branches with no commit in 24 h are not active');
});

test('repositories the lead edited in are shown after the session one, newest use first', () => {
  const other = newRepo('used-by-lead');
  const transcript = join(HOME, '.claude', 'projects', 'p', `${SESSION}.jsonl`);
  mkdirSync(join(HOME, '.claude', 'projects', 'p'), { recursive: true });
  put(transcript, `${JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { content: 'start' } })}\n`);
  const source = { session: SESSION, transcriptPath: transcript, cwd: ROOT };
  const first = collectBoard(source, { env: { HOME }, nowMs: Date.now() });
  assert.equal(first.board.repo, null, 'the lead folder is no repository and nothing was used yet');
  const at = new Date().toISOString();
  appendFileSync(transcript, `${JSON.stringify({ type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: join(other, 'f1') } }] } })}\n`
    + `${JSON.stringify({ type: 'user', timestamp: at, message: { content: [{ type: 'tool_result', tool_use_id: 'e1' }] } })}\n`);
  const second = collectBoard(source, { env: { HOME }, nowMs: Date.now(), cache: first.cache });
  assert.equal(second.board.repo?.name, 'used-by-lead');
  const third = collectBoard(source, { env: { HOME }, nowMs: Date.now(), cache: second.cache });
  assert.equal(third.board.repo?.name, 'used-by-lead', 'a used repository stays once its edit is no longer new');
});

test('P11: a session folder reached through a link is still the current worktree, with its new files counted', () => {
  const dir = newRepo('linked');
  put(join(dir, 'new.txt'), 'n\n');
  const link = join(ROOT, 'link-to-linked');
  symlinkSync(dir, link, 'junction');
  const { board } = collectBoard({ session: SESSION, transcriptPath: null, cwd: link }, { env: { HOME }, nowMs: Date.now() });
  assert.deepEqual([board.repo.name, board.repo.active[0].current, board.repo.active[0].untracked], ['linked', true, 1]);
});

test('R1: a FIFO as packed-refs never hangs the refresh (repository files are read only as plain files)', POSIX_ONLY, () => {
  const dir = newRepo('fifo-refs');
  execFileSync('mkfifo', [join(dir, '.git', 'packed-refs')]);
  const call = { cwd: dir, sessionFolder: dir, common: join(dir, '.git'), cache: null, nowMs: Date.now() };
  const code = `import { repoState } from ${JSON.stringify(GIT_STATE)}; repoState(${JSON.stringify(call)});`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], { timeout: HANG_LIMIT_MS, env: cleanEnv({ HOME }) });
  assert.equal(run.error?.code, undefined, 'the refresh hung on the FIFO');
  assert.equal(run.status, 0);
});

test('R2: a lane nested in the main checkout is the only current worktree; a live agent there makes only the lane active', () => {
  const dir = newRepo('nested');
  const lane = join(dir, '.claude', 'worktrees', 'lane');
  git(dir, 'worktree', 'add', '-q', '-b', 'lane', lane);
  put(join(dir, 'main-new.txt'), 'n\n');
  const common = join(dir, '.git');
  const { repo } = repoState({ cwd: lane, sessionFolder: lane, common, cache: null, nowMs: Date.now() });
  assert.deepEqual(repo.active.filter((branch) => branch.current).map((branch) => branch.name), ['lane']);
  assert.equal(repo.worktrees.find((wt) => wt.main).untracked, null, "the main checkout's new files were counted");
  const live = repoState({ cwd: dir, sessionFolder: null, common, liveDirs: [lane], cache: null, nowMs: Date.now() }).repo;
  assert.deepEqual(live.active.map((branch) => branch.name), ['lane'], 'the main checkout was taken for the agent in the lane');
});

/** Puts a git stand-in first on PATH that records each call in `log` and waits SLOW_GIT_S; returns the function that removes it. */
function slowGit(log) {
  const bin = join(ROOT, `slow-git-${Date.now()}`);
  mkdirSync(bin);
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  put(join(bin, 'git'), `#!/bin/sh\necho "$*" >> '${log}'\nsleep ${SLOW_GIT_S}\nexec '${realGit}' "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  // macOS checks a new program on its first run (about 1 s here): run it once now, so the budget sees only the stand-in's wait
  execFileSync(join(bin, 'git'), ['--version'], { stdio: 'ignore' });
  writeFileSync(log, '');
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  return () => { process.env.PATH = path; };
}

test('R3: the git budget is checked before every git call, in git-state.mjs and repo-stats.mjs', POSIX_ONLY, () => {
  const dir = newRepo('slow');
  const common = join(dir, '.git');
  const log = join(ROOT, 'slow-git.log');
  const restore = slowGit(log);
  try {
    // refs and then the config look take the budget: the status call must not start
    repoState({ cwd: dir, sessionFolder: dir, common, cache: null, nowMs: Date.now(), startMs: Date.now() - 10 });
    const stateCalls = readFileSync(log, 'utf8');
    assert.match(stateCalls, /for-each-ref/);
    assert.doesNotMatch(stateCalls, /\bstatus --porcelain/, 'status started past the git budget');
    writeFileSync(log, '');
    // the tip look ends past the budget: the landed-today log must not start
    repoStats({ common, base: 'main', cache: null, nowMs: Date.now(), startMs: Date.now() - 110 });
    const statsCalls = readFileSync(log, 'utf8');
    assert.match(statsCalls, /rev-parse/);
    assert.doesNotMatch(statsCalls, /\blog --first-parent/, 'log started past the git budget');
  } finally {
    restore();
  }
});
