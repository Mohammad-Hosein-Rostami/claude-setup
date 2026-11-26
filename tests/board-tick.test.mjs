// Tests of `board.mjs tick` (home/tools/board/lib/tick.mjs, tick-plan.mjs; boss-integrator design, U14), run as a child process on
// throw-away repositories whose lanes come from the real `git-tidy lane claim`: the main line, overlaps and strays among the lanes,
// the plan's exit codes, a land ledger with lines that do not parse, branch and file names with control characters,
// `--mark-tess`, side findings on the `tidy` line that never block `next:`, snapshot folders, the lane verdicts and a piece that
// names its own branch, and the `test/*` branches not landed. Every repository is in the OS temp folder (git-tidy-helpers.mjs) and every child has its own temp HOME, so the
// ledger and the tess marks go to <HOME>/.claude/state/ there and never to the real ~/.claude.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLEAN_ENV, commit, git, lines, makeRepo } from './git-tidy-helpers.mjs';
import { claim, lane, laneEnv, poolPath } from './git-tidy-lane-pool-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const BOARD = fileURLToPath(new URL('../home/tools/board/board.mjs', import.meta.url));
const EXIT_SHOWN = 0;
const EXIT_FINDINGS = 1;
const EXIT_USAGE = 2;
const REPO_KEY_HEX = 16; // the design's <repo-key>: the first 16 hex of the sha256 of the real git common dir
const SHORT_SHA = 8;
const JOB = 'job1';
const FEATURE = 'feat';
const PIECE = 'p1';
const DECLARED = 'declared.txt';
const LANDED_AT = '2026-01-01T00:00:00.000Z'; // long before any mark the test writes
// Every character class a terminal may act on: C0 (but not the line feed), DEL and C1, and the bidi controls.
const TERMINAL_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/;
const POSIX_ONLY = { skip: process.platform === 'win32' ? 'a file name cannot hold an escape character on Windows' : false };

const makeHome = () => realpathSync(makeTempDir('board-tick-home-'));
const headOf = (dir) => git(dir, 'rev-parse', 'HEAD');

/** Runs `board.mjs tick <args>` with `home` as HOME and USERPROFILE; no session id is set, so no agent is on the board. */
const tick = (home, args) =>
  spawnSync(process.execPath, [BOARD, 'tick', ...args], { encoding: 'utf8', env: { ...CLEAN_ENV, HOME: home, USERPROFILE: home } });

/** A repo that ignores the pool folders, as a project that uses lane folders does, plus its env and HOME. */
function poolRepo() {
  const repo = makeRepo();
  commit(repo, '.gitignore', '.claude/\n');
  return { repo, env: laneEnv() };
}

/** Claims `branch` from the pool of `repo` and writes each `[file, text]` as a commit in its folder; returns the folder. */
function claimWithCommits({ repo, env }, branch, files) {
  const claimed = claim(repo, branch, headOf(repo), env);
  assert.equal(claimed.status, 0, claimed.stderr);
  const folder = lines(claimed)[0].replace(/^lane: /, '');
  for (const [file, text] of files) commit(folder, file, text);
  return folder;
}

/**
 * Writes a pieces.json (job JOB, feature FEATURE of risk `risk`, by default one piece PIECE declaring `files`) in a temp folder;
 * returns its path.
 */
function writePlan(repo, { files = [DECLARED], risk = 'none', pieces = [{ id: PIECE, feature: FEATURE, files }] } = {}) {
  const path = join(makeTempDir('board-tick-plan-'), 'pieces.json');
  const plan = {
    job: JOB, repo, base: headOf(repo),
    features: [{ id: FEATURE, risk, spec: 'plan.md#one' }],
    pieces,
  };
  writeFileSync(path, JSON.stringify(plan));
  return path;
}

/** The ledger file the design names for `repo`: <home>/.claude/state/land/<first 16 hex of sha256(real git common dir)>.jsonl. */
function ledgerFile(home, repo) {
  const commonDir = realpathSync.native(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  const key = createHash('sha256').update(commonDir).digest('hex').slice(0, REPO_KEY_HEX);
  return join(home, '.claude', 'state', 'land', `${key}.jsonl`);
}

/** Writes the ledger of `repo` under `home` as the given raw lines. */
function writeLedger(home, repo, rawLines) {
  const file = ledgerFile(home, repo);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${rawLines.join('\n')}\n`);
}

/** One valid ledger line: `branch` landed on main at its current sha. */
function landedLine(repo, branch) {
  const sha = headOf(repo);
  return JSON.stringify({ at: LANDED_AT, repo, branch, from: sha, to: sha, commits: 1 });
}

const marksFile = (home) => join(home, '.claude', 'state', 'board', 'jobs', `${JOB}.json`);

test('a clean main with no lanes: exit 0 and a main line that says clean, one line and check 0', () => {
  const { repo } = poolRepo();
  const result = tick(makeHome(), ['--repo', repo]);
  assert.equal(result.status, EXIT_SHOWN, result.stderr);
  const [first, ...rest] = lines(result);
  assert.equal(first, `main ${headOf(repo).slice(0, SHORT_SHA)} clean, one line (git-tidy check 0)`);
  assert.ok(rest.includes('folders none'), result.stdout);
  assert.equal(result.stderr, '');
});

test('two lanes that changed the same file are an overlap line naming both lanes and the file, and exit 1', () => {
  const setup = poolRepo();
  claimWithCommits(setup, 'lane/a', [['shared.txt', 'a side'], ['only-a.txt', 'a']]);
  claimWithCommits(setup, 'lane/b', [['shared.txt', 'b side']]);
  const result = tick(setup.env.HOME, ['--repo', setup.repo]);
  assert.equal(result.status, EXIT_FINDINGS, result.stdout + result.stderr);
  assert.ok(lines(result).includes('overlap lane/a x lane/b: shared.txt'), result.stdout);
});

test('two lanes that changed different files are no overlap: exit 0', () => {
  const setup = poolRepo();
  claimWithCommits(setup, 'lane/a', [['a.txt', 'a']]);
  claimWithCommits(setup, 'lane/b', [['b.txt', 'b']]);
  const result = tick(setup.env.HOME, ['--repo', setup.repo]);
  assert.equal(result.status, EXIT_SHOWN, result.stdout + result.stderr);
  assert.equal(lines(result).some((line) => line.startsWith('overlap')), false, result.stdout);
  assert.equal(lines(result).filter((line) => line.startsWith('lane ')).length, 2, result.stdout);
});

test('a lane that changed a file its piece does not declare is a stray line and exit 1', () => {
  const setup = poolRepo();
  claimWithCommits(setup, `lane/${PIECE}`, [[DECLARED, 'declared'], ['docs-usage.txt', 'undeclared']]);
  const result = tick(setup.env.HOME, ['--repo', setup.repo, '--plan', writePlan(setup.repo)]);
  assert.equal(result.status, EXIT_FINDINGS, result.stdout + result.stderr);
  assert.ok(lines(result).includes(`stray lane/${PIECE}: docs-usage.txt (not in its files)`), result.stdout);
});

test('a lane that changed only the files its piece declares is no stray: exit 0', () => {
  const setup = poolRepo();
  claimWithCommits(setup, `lane/${PIECE}`, [[DECLARED, 'declared']]);
  const result = tick(setup.env.HOME, ['--repo', setup.repo, '--plan', writePlan(setup.repo)]);
  assert.equal(result.status, EXIT_SHOWN, result.stdout + result.stderr);
  assert.equal(lines(result).some((line) => line.startsWith('stray')), false, result.stdout);
});

test('a --plan file that does not exist is exit 2 with the path in the message and nothing on stdout', () => {
  const { repo } = poolRepo();
  const missing = join(makeTempDir('board-tick-plan-'), 'no-such.json');
  const result = tick(makeHome(), ['--repo', repo, '--plan', missing]);
  assert.equal(result.status, EXIT_USAGE, result.stdout);
  assert.ok(result.stderr.includes(missing), result.stderr);
  assert.equal(result.stdout, '');
});

test('a --plan file that is not JSON is exit 2', () => {
  const { repo } = poolRepo();
  const plan = join(makeTempDir('board-tick-plan-'), 'pieces.json');
  writeFileSync(plan, '{ not json');
  const result = tick(makeHome(), ['--repo', repo, '--plan', plan]);
  assert.equal(result.status, EXIT_USAGE, result.stdout);
  assert.match(result.stderr, /is not JSON/);
});

test('ledger lines that do not parse are skipped and counted, and the valid line still counts as a landed piece', () => {
  const { repo } = poolRepo();
  const home = makeHome();
  const plan = writePlan(repo);
  const noFields = JSON.stringify({ at: LANDED_AT, branch: `lane/${PIECE}` });
  writeLedger(home, repo, ['{ torn line', landedLine(repo, `lane/${PIECE}`), noFields]);
  const result = tick(home, ['--repo', repo, '--plan', plan]);
  assert.equal(result.status, EXIT_SHOWN, result.stdout + result.stderr);
  const shown = lines(result);
  assert.ok(shown.includes('ledger 2 bad lines skipped'), result.stdout);
  assert.ok(shown.some((line) => line.startsWith('features landed, not checked: feat 1/1')), 'the valid line counts the piece as landed');
  assert.ok(shown.includes('queue empty'), result.stdout);
});

test('a branch name with C1 and bidi controls reaches the output with no control character, as text and as JSON', () => {
  const setup = poolRepo();
  const hostile = 'lane/a\u009b31mred‮X';
  claimWithCommits(setup, hostile, [['a.txt', 'a']]);
  const text = tick(setup.env.HOME, ['--repo', setup.repo]);
  assert.equal(text.status, EXIT_SHOWN, text.stderr);
  assert.equal(TERMINAL_CONTROL.test(text.stdout), false, JSON.stringify(text.stdout));
  assert.ok(lines(text).some((line) => line.startsWith('lane lane/a') && line.includes('red')), text.stdout);
  const json = tick(setup.env.HOME, ['--repo', setup.repo, '--json']);
  assert.equal(json.status, EXIT_SHOWN, json.stderr);
  assert.equal(TERMINAL_CONTROL.test(json.stdout), false, 'JSON keeps the controls as \\u escapes, never raw');
  assert.equal(JSON.parse(json.stdout).lanes[0].branch, hostile, 'the escaped value is the exact branch name');
});

test('a changed file whose name holds an escape sequence reaches the overlap line with no control character', POSIX_ONLY, () => {
  const setup = poolRepo();
  const hostile = 'x\u001b[31mred.txt';
  const folders = ['lane/a', 'lane/b'].map((branch) => claimWithCommits(setup, branch, [['own-' + branch.slice(-1) + '.txt', branch]]));
  for (const folder of folders) writeFileSync(join(folder, hostile), 'untracked');
  const result = tick(setup.env.HOME, ['--repo', setup.repo]);
  assert.equal(result.status, EXIT_FINDINGS, result.stdout + result.stderr);
  assert.equal(TERMINAL_CONTROL.test(result.stdout), false, JSON.stringify(result.stdout));
  assert.ok(lines(result).some((line) => line.startsWith('overlap lane/a x lane/b:') && line.includes('red.txt')), result.stdout);
});

test('--mark-tess writes the job marks file as { feature: { sha, at } } and the next tick counts the feature as checked', () => {
  const { repo } = poolRepo();
  const home = makeHome();
  const plan = writePlan(repo);
  const sha = headOf(repo);
  writeLedger(home, repo, [landedLine(repo, `lane/${PIECE}`)]);
  const before = lines(tick(home, ['--repo', repo, '--plan', plan])).find((line) => line.startsWith('features landed'));
  assert.equal(before, `features landed, not checked: ${FEATURE} 1/1 (risk none) -> tess due now (last piece landed)`);
  const started = Date.now();
  const marked = tick(home, ['--repo', repo, '--plan', plan, '--mark-tess', FEATURE, '--sha', sha]);
  assert.equal(marked.status, EXIT_SHOWN, marked.stderr);
  assert.ok(marked.stdout.startsWith(`marked ${FEATURE} for tess at ${sha.slice(0, SHORT_SHA)}`), marked.stdout);
  const marks = JSON.parse(readFileSync(marksFile(home), 'utf8'));
  assert.deepEqual(Object.keys(marks), [FEATURE]);
  assert.deepEqual(Object.keys(marks[FEATURE]).sort(), ['at', 'sha']);
  assert.equal(marks[FEATURE].sha, sha);
  assert.ok(Date.parse(marks[FEATURE].at) >= started - 1000 && Date.parse(marks[FEATURE].at) <= Date.now() + 1000, marks[FEATURE].at);
  const after = tick(home, ['--repo', repo, '--plan', plan]);
  assert.equal(after.status, EXIT_SHOWN, after.stderr);
  const shown = lines(after);
  assert.ok(shown.some((line) => line.startsWith('features landed, not checked: none')), after.stdout);
  assert.ok(shown[0].endsWith(`since tess round at ${sha.slice(0, SHORT_SHA)}`), shown[0]);
});

test('--mark-tess with a sha that is not 40 hex characters is refused by the tick (exit 2, names --sha, no marks file); the full sha is accepted', () => {
  const { repo } = poolRepo();
  const home = makeHome();
  const plan = writePlan(repo);
  const sha = headOf(repo);
  const refused = tick(home, ['--repo', repo, '--plan', plan, '--mark-tess', FEATURE, '--sha', sha.slice(0, SHORT_SHA)]);
  assert.equal(refused.status, EXIT_USAGE, refused.stdout);
  assert.match(refused.stderr, /^board tick: --mark-tess needs .*--sha <full 40-character main sha>/);
  assert.equal(refused.stdout, '');
  assert.equal(existsSync(marksFile(home)), false, 'a refused mark writes nothing');
  const accepted = tick(home, ['--repo', repo, '--plan', plan, '--mark-tess', FEATURE, '--sha', sha]);
  assert.equal(accepted.status, EXIT_SHOWN, accepted.stderr);
  assert.equal(JSON.parse(readFileSync(marksFile(home), 'utf8'))[FEATURE].sha, sha, 'the same call with the full sha writes the mark');
});

const PRUNE = 'node ~/.claude/tools/git-tidy/git-tidy.mjs prune';

test('a branch that reaches a merge commit main lacks is a tidy line, not a main finding: next still lands the lane, exit 1', () => {
  const setup = poolRepo();
  const { repo } = setup;
  git(repo, 'checkout', '-q', '-b', 'side');
  commit(repo, 'side.txt');
  git(repo, 'checkout', '-q', '-b', 'inner');
  commit(repo, 'inner.txt');
  git(repo, 'checkout', '-q', 'side');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge inner', 'inner');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'branch', '-q', '-D', 'inner');
  claimWithCommits(setup, 'lane/a', [['a.txt', 'a']]);
  const result = tick(setup.env.HOME, ['--repo', repo]);
  assert.equal(result.status, EXIT_FINDINGS, result.stdout + result.stderr);
  const shown = lines(result);
  assert.equal(shown[0], `main ${headOf(repo).slice(0, SHORT_SHA)} clean, one line (git-tidy check 0)`);
  assert.ok(shown.includes(`tidy 1 tangled-ref (refs/heads/side) -> ${PRUNE} ${repo} --base main`), result.stdout);
  assert.ok(shown.at(-1).startsWith('next: land lane/a'), result.stdout);
  const json = JSON.parse(tick(setup.env.HOME, ['--repo', repo, '--json']).stdout);
  assert.deepEqual(json.tidy, [{ kind: 'tangled-ref', subject: 'refs/heads/side' }]);
  assert.deepEqual(json.main.findings, []);
});

test('a merged branch checked out nowhere is a tidy line and next does not say fix main first', () => {
  const { repo } = poolRepo();
  git(repo, 'branch', 'test/x', 'HEAD~1');
  const shown = lines(tick(makeHome(), ['--repo', repo]));
  assert.ok(shown.some((line) => line.startsWith('tidy 1 merged-branch (test/x) -> ')), shown.join('\n'));
  assert.equal(shown.some((line) => line.startsWith('tests not landed')), false, 'a merged test branch is prune\'s, not a tests line');
  assert.equal(shown.at(-1).includes('fix main first'), false, shown.at(-1));
});

test('a changed tracked file in the base checkout still makes main dirty and next says fix main first', () => {
  const { repo } = poolRepo();
  writeFileSync(join(repo, '.gitignore'), '.claude/\nmore/\n');
  const result = tick(makeHome(), ['--repo', repo]);
  assert.equal(result.status, EXIT_FINDINGS, result.stdout + result.stderr);
  const shown = lines(result);
  assert.ok(shown[0].startsWith(`main ${headOf(repo).slice(0, SHORT_SHA)} dirty`), shown[0]);
  assert.ok(shown.at(-1).startsWith('next: fix main first ('), shown.at(-1));
});

test('snapshot claims count as snapshot on the folders line, with the age of the oldest lock', () => {
  const { repo, env } = poolRepo();
  for (let count = 0; count < 3; count++) assert.equal(lane(['claim', '--repo', repo, '--snapshot', '--base', headOf(repo)], env).status, 0);
  const released = lane(['release', '--repo', repo, '--folder', poolPath(repo, 1)], env);
  assert.equal(released.status, 0, released.stdout + released.stderr);
  const shown = lines(tick(env.HOME, ['--repo', repo]));
  assert.ok(shown.includes('folders 1 free, 2 snapshot (oldest 0 h)'), shown.join('\n'));
});

test('a ready lane behind main says it still lands, and next lands it', () => {
  const setup = poolRepo();
  claimWithCommits(setup, 'lane/a', [['a.txt', 'a']]);
  commit(setup.repo, 'later.txt');
  const shown = lines(tick(setup.env.HOME, ['--repo', setup.repo]));
  assert.ok(shown.some((line) => line.startsWith('lane lane/a') && line.endsWith('ready to land (behind main; land rebases it)')), shown.join('\n'));
  assert.ok(shown.at(-1).startsWith('next: land lane/a'), shown.at(-1));
});

const FIX = 'fix-1';
const REPRO = 'test/repro-1';
const fixPiece = (id = FIX, branch = REPRO) => ({ id, feature: FEATURE, files: [DECLARED], branch });

test('a piece with a branch counts as landed from a ledger line of that branch, with its range on the commits line', () => {
  const { repo } = poolRepo();
  const home = makeHome();
  writeLedger(home, repo, [landedLine(repo, REPRO)]);
  const result = tick(home, ['--repo', repo, '--plan', writePlan(repo, { pieces: [fixPiece()] })]);
  assert.equal(result.status, EXIT_SHOWN, result.stdout + result.stderr);
  const shown = lines(result);
  const sha = headOf(repo).slice(0, SHORT_SHA);
  assert.ok(shown.some((line) => line.startsWith(`features landed, not checked: ${FEATURE} 1/1`)), result.stdout);
  assert.ok(shown.includes('queue empty'), result.stdout);
  assert.ok(shown.includes(`commits ${FEATURE}: ${sha}..${sha}`), result.stdout);
});

test('a pool lane on a piece\'s branch takes the piece off the queue and a file outside its files is a stray', () => {
  const setup = poolRepo();
  claimWithCommits(setup, REPRO, [[DECLARED, 'declared'], ['other.txt', 'undeclared']]);
  const result = tick(setup.env.HOME, ['--repo', setup.repo, '--plan', writePlan(setup.repo, { pieces: [fixPiece()] })]);
  assert.equal(result.status, EXIT_FINDINGS, result.stdout + result.stderr);
  assert.ok(lines(result).includes(`stray ${REPRO}: other.txt (not in its files)`), result.stdout);
  assert.ok(lines(result).includes('queue empty'), result.stdout);
});

test('a startable piece with a branch is claimed on it in next', () => {
  const { repo } = poolRepo();
  const shown = lines(tick(makeHome(), ['--repo', repo, '--plan', writePlan(repo, { pieces: [fixPiece()] })]));
  assert.ok(shown.at(-1).includes(`claim ${FIX} (branch ${REPRO})`), shown.at(-1));
});

test('a piece branch that is no plain name, the base branch, or one two pieces share is exit 2 naming the piece', () => {
  const { repo } = poolRepo();
  const cases = [
    [[fixPiece(FIX, '-x')], `piece ${FIX} has a "branch" that is no plain branch name`],
    [[fixPiece(FIX, 'main')], `piece ${FIX} names the base branch main`],
    [[fixPiece(), fixPiece('fix-2')], `pieces ${FIX} and fix-2 name the same branch ${REPRO}`],
  ];
  for (const [pieces, message] of cases) {
    const result = tick(makeHome(), ['--repo', repo, '--plan', writePlan(repo, { pieces })]);
    assert.equal(result.status, EXIT_USAGE, result.stdout);
    assert.ok(result.stderr.includes(message), result.stderr);
    assert.equal(result.stdout, '');
  }
});

const TESTS_LINE = 'tests not landed: ';
const testsLineOf = (shown) => shown.find((line) => line.startsWith(TESTS_LINE));

/** Makes each of `branches` with one commit beyond main, checked out nowhere. */
function testBranchesWithCommit(repo, branches) {
  for (const branch of branches) {
    git(repo, 'checkout', '-q', '-b', branch);
    commit(repo, `${branch.replaceAll('/', '-')}.txt`);
    git(repo, 'checkout', '-q', 'main');
  }
}

test('a test branch with a commit is on the tests line and next says to land it, as text and as JSON, exit 0', () => {
  const { repo } = poolRepo();
  testBranchesWithCommit(repo, ['test/gap']);
  const home = makeHome();
  const result = tick(home, ['--repo', repo]);
  assert.equal(result.status, EXIT_SHOWN, result.stdout + result.stderr);
  const shown = lines(result);
  assert.equal(testsLineOf(shown), `${TESTS_LINE}test/gap +1`, result.stdout);
  assert.ok(shown.at(-1).includes(`test branches test/gap: land each one tess passed (land test/gap --repo ${repo})`), shown.at(-1));
  const json = JSON.parse(tick(home, ['--repo', repo, '--json']).stdout);
  assert.deepEqual(json.tests, [{ branch: 'test/gap', commits: 1, folder: null, piece: null, agent: null }]);
});

test('a test branch at main in a locked folder outside the pool shows its folder, and next does not name it', () => {
  const { repo } = poolRepo();
  const folder = join(realpathSync(makeTempDir('board-tick-held-')), 'test-held');
  git(repo, 'worktree', 'add', '-q', '--lock', '-b', 'test/held', folder, 'HEAD');
  const shown = lines(tick(makeHome(), ['--repo', repo]));
  assert.equal(testsLineOf(shown), `${TESTS_LINE}test/held no commit (in ${folder})`, shown.join('\n'));
  assert.equal(shown.at(-1).includes('test branches'), false, shown.at(-1));
});

test('a test branch a pool lane holds is on its lane line, not on the tests line', () => {
  const setup = poolRepo();
  claimWithCommits(setup, 'test/x', [['x.txt', 'x']]);
  const shown = lines(tick(setup.env.HOME, ['--repo', setup.repo]));
  assert.ok(shown.some((line) => line.startsWith('lane test/x ')), shown.join('\n'));
  assert.equal(testsLineOf(shown), undefined, shown.join('\n'));
});

test('a test branch a plan piece is built on names the piece, and next leaves it to the piece', () => {
  const { repo } = poolRepo();
  testBranchesWithCommit(repo, [REPRO]);
  const shown = lines(tick(makeHome(), ['--repo', repo, '--plan', writePlan(repo, { pieces: [fixPiece()] })]));
  assert.equal(testsLineOf(shown), `${TESTS_LINE}${REPRO} +1 (piece ${FIX})`, shown.join('\n'));
  assert.equal(shown.at(-1).includes('test branches'), false, shown.at(-1));
});

test('7 test branches with commits: the tests line shows 5 and +2 more, next names 3 and +4 more', () => {
  const { repo } = poolRepo();
  const branches = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => `test/${name}`);
  testBranchesWithCommit(repo, branches);
  const shown = lines(tick(makeHome(), ['--repo', repo]));
  assert.equal(testsLineOf(shown), `${TESTS_LINE}${branches.slice(0, 5).map((branch) => `${branch} +1`).join(', ')}, +2 more`, shown.join('\n'));
  assert.ok(shown.at(-1).includes('test branches test/a, test/b, test/c, +4 more: land each one tess passed (land <branch> --repo '), shown.at(-1));
});
