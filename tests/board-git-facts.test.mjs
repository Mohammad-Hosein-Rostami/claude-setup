// The board's git facts (spec R18 "Git facts", owner decisions RC15 and RC19): every field of `repo.active` from a real refresh of a
// cs-test repository with staged, changed and new files, a stash, a conflict, a rebase stopped at step 2 of 3 and a lane worktree;
// the repository-config programs a refresh must never run (filter, fsmonitor: F1); names that are never options and reach the board
// cleaned (F2); cached values kept with their age past the git budget (F3); new files counted only on the session's worktree and at
// most 4 active branches (F5); repositories used by the lead's edits;
// a FIFO among a repository's files never hangs the refresh; a lane nested in the main checkout is the only current worktree; no git
// call starts past the git budget (a git stand-in records each call, on a clock that each call moves); a git call that times out,
// fails or is skipped for the budget leaves its facts `unknown` with the reason (P3), never null; and a refresh within git's limits
// is not thrown away as slow.
// Every repository and HOME is a temp `cs-test-*` folder; git runs with a fixed identity and no global or system config.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lookOf } from '../home/tools/board/lib/cells.mjs';
import { gitLineRows } from '../home/tools/board/lib/git-rows.mjs';
import { cleanName, repoState } from '../home/tools/board/lib/git-state.mjs';
import { collectBoard, readBoard, refreshBoard } from '../home/tools/board/lib/refresh.mjs';
import { repoStats } from '../home/tools/board/lib/repo-stats.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { cleanEnv } from './clean-env.mjs';

const BOARD = fileURLToPath(new URL('../home/tools/board/board.mjs', import.meta.url));
const GIT_STATE = new URL('../home/tools/board/lib/git-state.mjs', import.meta.url).href;
const SESSION = '11111111-2222-4333-8444-555555555555';
const POSIX_ONLY = { skip: process.platform === 'win32' ? 'no FIFO, mkfifo or sh stand-in for git on Windows' : false };
const HANG_LIMIT_MS = 10_000; // a refresh child still running after this has hung
const GIT_BUDGET_MS = 3_000; // git-call.mjs: all git of one refresh, checked before each call
const VIRTUAL_CALL_MS = 1_000; // R3's clock: each git call the stand-in logs moves it this far, whatever the machine's load
const BUDGET_MARGIN_MS = 1_000; // a refresh clock started this long before the budget's end: spent whatever the load
const HANG_S = 5; // a hanging stand-in call sleeps this long: well past the 1500 ms limit of one git call
const STANDIN_EXIT = 3; // the exit code of a failing stand-in call
const STATUS_EVERY_MS = 15_000; // git-state.mjs: a cached status older than this is asked again
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


const STANDIN_LOG = join(ROOT, 'git-calls.log');
const STANDIN_CALLS = ['status', 'config', 'for-each-ref']; // the calls whose answer a test can set: `pass`, `hang` or `fail`
let standInBin = null;

/** Makes the git stand-in once: it logs each call, then for STANDIN_CALLS does what its act file says; the rest runs the real git. */
function makeStandIn() {
  const bin = join(ROOT, 'stand-in-git');
  mkdirSync(bin);
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const actOf = (call) => `read -r act < '${join(bin, call)}'`;
  put(join(bin, 'git'), [
    '#!/bin/sh', `echo "$*" >> '${STANDIN_LOG}'`, 'act=pass', 'case "$*" in',
    `  *' status --porcelain'*) ${actOf('status')} ;;`, `  *' config --list'*) ${actOf('config')} ;;`,
    `  *' for-each-ref '*) ${actOf('for-each-ref')} ;;`, 'esac',
    // exec: the sleep itself is the child git-call.mjs kills at its time limit, so no grandchild holds the output pipe open
    `if [ "$act" = hang ]; then exec sleep ${HANG_S}; fi`, `if [ "$act" = fail ]; then exit ${STANDIN_EXIT}; fi`,
    `exec '${realGit}' "$@"`, '',
  ].join('\n'));
  chmodSync(join(bin, 'git'), 0o755);
  // macOS checks a new program on its first run (about 1 s here): run it once now, so no test's git limits see that wait
  execFileSync(join(bin, 'git'), ['--version'], { stdio: 'ignore' });
  return bin;
}

/**
 * Puts the git stand-in first on PATH with an empty log; `acts` names what `status`, the config look and `for-each-ref` do
 * (`hang`: sleep HANG_S, `fail`: exit STANDIN_EXIT; any other runs the real git).
 * @returns {() => void} the function that takes it off PATH again
 */
function useStandIn(acts = {}) {
  standInBin ??= makeStandIn();
  for (const call of STANDIN_CALLS) put(join(standInBin, call), `${acts[call] ?? 'pass'}\n`);
  writeFileSync(STANDIN_LOG, '');
  const path = process.env.PATH;
  process.env.PATH = `${standInBin}:${path}`;
  return () => { process.env.PATH = path; };
}

const CALL_KINDS = [['for-each-ref', / for-each-ref /], ['config', / config --list /], ['status', / status --porcelain/],
  ['rev-parse', / rev-parse /], ['log', / log --first-parent /]];
/** The git calls the stand-in logged since useStandIn, each by its kind. */
const loggedCalls = () => readFileSync(STANDIN_LOG, 'utf8').split('\n').filter(Boolean)
  .map((line) => CALL_KINDS.find(([, pattern]) => pattern.test(line))?.[0] ?? line);

/**
 * Runs `act(t0)` with Date.now frozen at t0 plus VIRTUAL_CALL_MS for every git call logged so far: the budget sees each call take
 * exactly that long, so which calls start does not depend on the machine's load.
 * @returns {string[]} the kinds of the git calls `act` made
 */
function callsOnGitClock(act) {
  writeFileSync(STANDIN_LOG, '');
  const realNow = Date.now;
  const t0 = realNow();
  Date.now = () => t0 + readFileSync(STANDIN_LOG, 'utf8').split('\n').filter(Boolean).length * VIRTUAL_CALL_MS;
  try {
    act(t0);
  } finally {
    Date.now = realNow;
  }
  return loggedCalls();
}

test('R3: the git budget is checked before every git call, in git-state.mjs and repo-stats.mjs', POSIX_ONLY, () => {
  const dir = newRepo('slow');
  const common = join(dir, '.git');
  const restore = useStandIn();
  try {
    // `usedMs` of the budget is gone when the refresh starts; each call then takes VIRTUAL_CALL_MS
    const stateCalls = (usedMs) => callsOnGitClock((t0) => repoState({ cwd: dir, sessionFolder: dir, common, cache: null, nowMs: t0, startMs: t0 - usedMs }));
    assert.deepEqual(stateCalls(GIT_BUDGET_MS - 2.5 * VIRTUAL_CALL_MS), ['for-each-ref', 'config', 'status'], 'all three fit the budget');
    assert.deepEqual(stateCalls(GIT_BUDGET_MS - 1.5 * VIRTUAL_CALL_MS), ['for-each-ref', 'config'], 'status started past the git budget');
    assert.deepEqual(stateCalls(GIT_BUDGET_MS - 0.5 * VIRTUAL_CALL_MS), ['for-each-ref'], 'the config look started past the git budget');
    assert.deepEqual(stateCalls(GIT_BUDGET_MS + 1), [], 'for-each-ref started past the git budget');
    const statsCalls = (usedMs) => callsOnGitClock((t0) => repoStats({ common, base: 'main', cache: null, nowMs: t0, startMs: t0 - usedMs }));
    assert.deepEqual(statsCalls(GIT_BUDGET_MS - 1.5 * VIRTUAL_CALL_MS), ['rev-parse', 'log'], 'both fit the budget');
    assert.deepEqual(statsCalls(GIT_BUDGET_MS - 0.5 * VIRTUAL_CALL_MS), ['rev-parse'], 'the landed-today log started past the git budget');
    assert.deepEqual(statsCalls(GIT_BUDGET_MS + 1), [], 'the tip look started past the git budget');
  } finally {
    restore();
  }
});

const UNKNOWN_COUNTS = { staged: 'unknown', changed: 'unknown', conflicts: 'unknown' };
const countsOf = (entry) => ({ staged: entry.staged, changed: entry.changed, conflicts: entry.conflicts });
const mainOf = (repo) => repo.worktrees.find((wt) => wt.main);

test('P3: a git status that times out with no earlier answer leaves the counts `unknown` (not null) and says it timed out', POSIX_ONLY, () => {
  const dir = newRepo('status-hangs');
  const common = join(dir, '.git');
  const restore = useStandIn({ status: 'hang' });
  let state;
  try {
    state = repoState({ cwd: dir, sessionFolder: dir, common, cache: null, nowMs: Date.now() });
  } finally {
    restore();
  }
  assert.ok(loggedCalls().includes('status'), 'the status call never started, so it could not time out');
  assert.notEqual(state.repo, null, 'repoState fell into its catch');
  const main = mainOf(state.repo);
  assert.deepEqual({ ...countsOf(main), untracked: main.untracked }, { ...UNKNOWN_COUNTS, untracked: 'unknown' });
  assert.equal(main.unknown, 'git status timed out after 1500 ms');
  assert.deepEqual(countsOf(state.repo.active[0]), UNKNOWN_COUNTS, 'the head branch carries the unknown counts');
  assert.equal(state.repo.refsUnknown, null, 'the refs came from git');
});

test('P3: a git status that times out keeps the earlier answer with its age, and nothing is unknown', POSIX_ONLY, () => {
  const dir = newRepo('status-hangs-cached');
  const common = join(dir, '.git');
  put(join(dir, 'f1'), 'changed before\n');
  const earlierMs = Date.now() - STATUS_EVERY_MS - 1;
  const earlier = repoState({ cwd: dir, sessionFolder: dir, common, cache: null, nowMs: earlierMs });
  assert.equal(mainOf(earlier.repo).changed, 1, 'the earlier answer counted the change');
  const restore = useStandIn({ status: 'hang' });
  let state;
  try {
    state = repoState({ cwd: dir, sessionFolder: dir, common, cache: earlier.cache, nowMs: Date.now() });
  } finally {
    restore();
  }
  assert.ok(loggedCalls().includes('status'), 'the cached status was not asked again, so it could not time out');
  const main = mainOf(state.repo);
  assert.deepEqual({ ...countsOf(main), checkedMs: main.checkedMs, unknown: main.unknown }, { staged: 0, changed: 1, conflicts: 0, checkedMs: earlierMs, unknown: null });
});

test('P3: a git call that fails with exit 3 says so: the status call, and the config look before it (then no status runs)', POSIX_ONLY, () => {
  const dir = newRepo('git-fails');
  const common = join(dir, '.git');
  for (const [call, why] of [['status', 'git status failed with exit 3'], ['config', 'git config failed with exit 3']]) {
    const restore = useStandIn({ [call]: 'fail' });
    let state;
    try {
      state = repoState({ cwd: dir, sessionFolder: dir, common, cache: null, nowMs: Date.now() });
    } finally {
      restore();
    }
    const main = mainOf(state.repo);
    assert.deepEqual({ ...countsOf(main), unknown: main.unknown }, { ...UNKNOWN_COUNTS, unknown: why }, call);
    assert.equal(loggedCalls().includes('status'), call === 'status', `status ran after the ${call} failure`);
  }
});

test('P3: refs that git could not give and no cache holds are named in repo.refsUnknown; cached refs leave it null', POSIX_ONLY, () => {
  const dir = newRepo('refs-fail');
  const common = join(dir, '.git');
  git(dir, 'switch', '-q', '-c', 'ahead-one');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'ahead');
  git(dir, 'switch', '-q', 'main');
  const earlierMs = Date.now() - STATUS_EVERY_MS - 1; // the cached refs are due again
  const earlier = repoState({ cwd: dir, sessionFolder: dir, common, cache: null, nowMs: earlierMs });
  assert.equal(earlier.repo.refsUnknown, null, 'refs from git');
  const restore = useStandIn({ 'for-each-ref': 'fail' });
  let fresh;
  let cached;
  try {
    fresh = repoState({ cwd: dir, sessionFolder: dir, common, cache: null, nowMs: Date.now() });
    cached = repoState({ cwd: dir, sessionFolder: dir, common, cache: earlier.cache, nowMs: Date.now() });
  } finally {
    restore();
  }
  assert.deepEqual([fresh.repo.refsUnknown, fresh.repo.branches], ['git for-each-ref failed with exit 3', 0]);
  assert.equal(loggedCalls().filter((call) => call === 'for-each-ref').length, 2, 'the cached refs were not asked again');
  assert.deepEqual([cached.repo.refsUnknown, cached.repo.branches, cached.repo.unlanded], [null, 2, 1], 'the cached refs stay');
});

const ROWS_COLUMNS = 140; // wide enough that no part of the git rows is dropped
const CLEAN_MARK = /(ok|✓) clean/; // git-rows.mjs: the head branch with known refs and nothing to do (ascii or unicode)

test('P3: with no refs from git and none cached, the git rows say the refs are `unknown`, never that main is clean', POSIX_ONLY, () => {
  const dir = newRepo('refs-unknown-rows');
  const common = join(dir, '.git');
  const lane = join(ROOT, 'wt-refs-unknown-lane');
  git(dir, 'worktree', 'add', '-q', '-b', 'ready-lane', lane, 'main');
  put(join(lane, 'l.txt'), 'l\n');
  git(lane, 'add', 'l.txt');
  git(lane, 'commit', '-qm', 'lane'); // clean and one commit ahead of main: ready to land, which only the refs can tell
  const look = lookOf({ NO_COLOR: '1' }, 'darwin', ROWS_COLUMNS);
  // hang: the one real 1500 ms limit of a git call; fail: exit STANDIN_EXIT
  for (const [act, why] of [['hang', 'git for-each-ref timed out after 1500 ms'], ['fail', 'git for-each-ref failed with exit 3']]) {
    const restore = useStandIn({ 'for-each-ref': act });
    let repo;
    try {
      repo = repoState({ cwd: dir, sessionFolder: dir, common, cache: null, nowMs: Date.now() }).repo;
    } finally {
      restore();
    }
    assert.equal(repo.refsUnknown, why, act);
    const rows = gitLineRows({ at: Date.now(), repo: { ...repo, name: 'repo' }, repos: [] }, 2, look);
    assert.ok(rows.some((row) => row.includes('unknown')), `${act}: the rows never say the refs are unknown: ${JSON.stringify(rows)}`);
    assert.ok(!rows.some((row) => CLEAN_MARK.test(row)), `${act}: the rows show main clean without its refs: ${JSON.stringify(rows)}`);
  }
});

test('P3: with the git budget used up and no cache the counts are `unknown` for the budget; the next refresh gets the real counts', () => {
  const dir = newRepo('budget-unknown');
  const common = join(dir, '.git');
  put(join(dir, 's.txt'), 's\n');
  git(dir, 'add', 's.txt');
  const budgetUsed = 'git budget of 3000 ms for this refresh used up';
  const spent = repoState({ cwd: dir, sessionFolder: dir, common, cache: null, nowMs: Date.now(), startMs: Date.now() - GIT_BUDGET_MS - BUDGET_MARGIN_MS });
  const spentMain = mainOf(spent.repo);
  assert.deepEqual({ ...countsOf(spentMain), unknown: spentMain.unknown, refsUnknown: spent.repo.refsUnknown },
    { ...UNKNOWN_COUNTS, unknown: budgetUsed, refsUnknown: budgetUsed });
  const next = repoState({ cwd: dir, sessionFolder: dir, common, cache: spent.cache, nowMs: Date.now(), startMs: Date.now() });
  const nextMain = mainOf(next.repo);
  assert.deepEqual({ ...countsOf(nextMain), unknown: nextMain.unknown, refsUnknown: next.repo.refsUnknown },
    { staged: 1, changed: 1, conflicts: 0, unknown: null, refsUnknown: null }); // a worktree's `changed`: its tracked entries
});

test('rule (c): a lane whose counts are `unknown` is active (it may have changes); with real counts and none it is not', POSIX_ONLY, () => {
  const dir = newRepo('unknown-lane');
  const common = join(dir, '.git');
  git(dir, 'worktree', 'add', '-q', '-b', 'idle-lane', join(ROOT, 'wt-idle-lane'), 'main'); // level with main, clean: no other rule
  const activeNames = (repo) => repo.active.map((branch) => branch.name);
  const known = repoState({ cwd: dir, sessionFolder: dir, common, cache: null, nowMs: Date.now() }).repo;
  assert.deepEqual(activeNames(known), ['main'], 'the clean lane level with main was active without unknown counts');
  const restore = useStandIn({ status: 'fail' });
  let repo;
  try {
    repo = repoState({ cwd: dir, sessionFolder: dir, common, cache: null, nowMs: Date.now() }).repo;
  } finally {
    restore();
  }
  assert.deepEqual(activeNames(repo), ['main', 'idle-lane']);
  assert.deepEqual(countsOf(repo.active[1]), UNKNOWN_COUNTS);
});

test("refresh: a refresh that took over 300 ms but within git's limits writes its board; one past them keeps the old board, stale", () => {
  const session = '22222222-3333-4444-8555-666666666666';
  const env = { HOME: realpathSync(makeTempDir('board-refresh-home-')) };
  const source = { session, transcriptPath: null, cwd: ROOT };
  const GIT_LIMITS_MS = 4_800; // git-call.mjs GIT_BUDGET_MS + GIT_TIMEOUT_MS, plus the 300 ms the rest of a refresh has
  const firstMs = Date.now();
  // refreshBoard reads its clock at the start and at the end of the refresh
  const clock = (startMs, tookMs) => { const reads = [startMs, startMs + tookMs]; return () => (reads.length > 1 ? reads.shift() : reads[0]); };
  const refreshAt = (startMs, tookMs) => {
    assert.equal(refreshBoard(source, { env, now: clock(startMs, tookMs), force: true }), true, `refresh at ${startMs} wrote no board`);
    const { at, stale } = readBoard(session, env);
    return { at, stale };
  };
  assert.deepEqual(refreshAt(firstMs, 0), { at: firstMs, stale: null });
  assert.deepEqual(refreshAt(firstMs + 1, 400), { at: firstMs + 1, stale: null }, 'a 400 ms refresh was thrown away as slow');
  assert.deepEqual(refreshAt(firstMs + 2, GIT_LIMITS_MS), { at: firstMs + 2, stale: null }, 'a refresh at git\'s limits was thrown away');
  assert.deepEqual(refreshAt(firstMs + 3, GIT_LIMITS_MS + 1), { at: firstMs + 2, stale: { sinceMs: firstMs + 2, tookMs: GIT_LIMITS_MS + 1 } });
});
