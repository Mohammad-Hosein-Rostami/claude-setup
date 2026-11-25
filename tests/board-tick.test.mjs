// Tests of `board.mjs tick` (home/tools/board/lib/tick.mjs, tick-plan.mjs; boss-integrator design, U14), run as a child process on
// throw-away repositories whose lanes come from the real `git-tidy lane claim`: the main line, overlaps and strays among the lanes,
// the plan's exit codes, a land ledger with lines that do not parse, branch and file names with control characters, and
// `--mark-tess`. Every repository is in the OS temp folder (git-tidy-helpers.mjs) and every child has its own temp HOME, so the
// ledger and the tess marks go to <HOME>/.claude/state/ there and never to the real ~/.claude.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLEAN_ENV, commit, git, lines, makeRepo } from './git-tidy-helpers.mjs';
import { claim, laneEnv } from './git-tidy-lane-pool-helpers.mjs';
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

/** Writes a pieces.json (job JOB, feature FEATURE of risk `risk`, one piece PIECE declaring `files`) in a temp folder; returns its path. */
function writePlan(repo, { files = [DECLARED], risk = 'none' } = {}) {
  const path = join(makeTempDir('board-tick-plan-'), 'pieces.json');
  const plan = {
    job: JOB, repo, base: headOf(repo),
    features: [{ id: FEATURE, risk, spec: 'plan.md#one' }],
    pieces: [{ id: PIECE, feature: FEATURE, files }],
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

test('--mark-tess with a sha that is not 40 hex characters is exit 2 and writes no marks file', () => {
  const { repo } = poolRepo();
  const home = makeHome();
  const result = tick(home, ['--repo', repo, '--plan', writePlan(repo), '--mark-tess', FEATURE, '--sha', headOf(repo).slice(0, SHORT_SHA)]);
  assert.equal(result.status, EXIT_USAGE, result.stdout);
  assert.equal(existsSync(marksFile(home)), false);
});
