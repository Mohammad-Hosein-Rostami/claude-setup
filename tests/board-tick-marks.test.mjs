// Tests of the tess marks of `board.mjs tick` (home/tools/board/lib/tick-features.mjs, tick-plan.mjs, tick.mjs): a mark is judged by
// ancestry of the landed commits, parallel `--mark-tess` calls keep every mark (a lock file beside the marks), the `commits <feature>:`
// line and the `next:` line's mark command. Each test runs the CLI as a child process on a throw-away repository in the OS temp
// folder (git-tidy-helpers.mjs); every child has its own temp HOME, so the ledger and the marks go to <HOME>/.claude/state/ there and
// never to the real ~/.claude. The lands are ledger lines written by the test, each between real commits on main.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLEAN_ENV, commit, git, lines, makeRepo } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const BOARD = fileURLToPath(new URL('../home/tools/board/board.mjs', import.meta.url));
const EXIT_SHOWN = 0;
const EXIT_USAGE = 2;
const REPO_KEY_HEX = 16; // the <repo-key> of the land ledger: the first 16 hex of the sha256 of the real git common dir
const SHORT_SHA = 8;
const JOB = 'marksjob';
const LANDED_AT = '2026-01-01T00:00:00.000Z';
const FEATURES_LINE = 'features landed, not checked:';
const PARALLEL_MARKS = 8;
const ROUNDS = 4;
const FRESH_LOCK_MESSAGE = 'another --mark-tess is writing';
const STALE_LOCK_AGE_S = 11; // the lock is stale after 10 s (MARK_LOCK_STALE_MS in tick-plan.mjs)
const RISKY = 'gate';

const makeHome = () => realpathSync(makeTempDir('board-marks-home-'));
const headOf = (dir) => git(dir, 'rev-parse', 'HEAD');
const short = (sha) => sha.slice(0, SHORT_SHA);
const jobsDir = (home) => join(home, '.claude', 'state', 'board', 'jobs');
const marksFile = (home) => join(jobsDir(home), `${JOB}.json`);
const lockFile = (home) => join(jobsDir(home), `${JOB}.lock`);
const readMarks = (home) => JSON.parse(readFileSync(marksFile(home), 'utf8'));

const envOf = (home) => ({ ...CLEAN_ENV, HOME: home, USERPROFILE: home });

/** Runs `board.mjs tick <args>` with `home` as HOME and USERPROFILE; no session id is set, so no agent is on the board. */
const tick = (home, args) => spawnSync(process.execPath, [BOARD, 'tick', ...args], { encoding: 'utf8', env: envOf(home) });

/** The same call, started now and resolved when the child has closed: several of them run at once. */
const tickAsync = (home, args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [BOARD, 'tick', ...args], { env: envOf(home) });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});

/** Writes a pieces.json (job JOB) for `features` ([{ id, risk }]) and `pieces` ([{ id, feature }]) in a temp folder; returns its path. */
function writePlan(repo, features, pieces) {
  const path = join(makeTempDir('board-marks-plan-'), 'pieces.json');
  const plan = {
    job: JOB, repo, base: headOf(repo),
    features: features.map(({ id, risk }) => ({ id, risk, spec: 'plan.md#one' })),
    pieces: pieces.map(({ id, feature }) => ({ id, feature, files: [`${id}.txt`] })),
  };
  writeFileSync(path, JSON.stringify(plan));
  return path;
}

/** The land ledger file of `repo` under `home`: <home>/.claude/state/land/<first 16 hex of sha256(real git common dir)>.jsonl. */
function ledgerFile(home, repo) {
  const commonDir = realpathSync.native(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  const key = createHash('sha256').update(commonDir).digest('hex').slice(0, REPO_KEY_HEX);
  return join(home, '.claude', 'state', 'land', `${key}.jsonl`);
}

/** Writes the ledger of `repo` under `home`: one landing of `lane/<piece>` from `from` to `to` per `[piece, from, to]`, in this order. */
function writeLands(home, repo, lands) {
  const file = ledgerFile(home, repo);
  mkdirSync(dirname(file), { recursive: true });
  const rows = lands.map(([piece, from, to]) => JSON.stringify({ at: LANDED_AT, repo, branch: `lane/${piece}`, from, to, commits: 1 }));
  writeFileSync(file, `${rows.join('\n')}\n`);
}

const featuresLineOf = (result) => lines(result).find((line) => line.startsWith(FEATURES_LINE));
const markArgs = (repo, plan, feature, sha) => ['--repo', repo, '--plan', plan, '--mark-tess', feature, '--sha', sha];
const factsOf = (home, repo, plan) => JSON.parse(tick(home, ['--repo', repo, '--plan', plan, '--json']).stdout);

test('a risky feature marked at its first piece\'s land is still due, and checked once marked at its last piece\'s land', () => {
  const repo = makeRepo();
  const home = makeHome();
  const base = headOf(repo);
  const firstTo = commit(repo, 'p1.txt');
  const lastTo = commit(repo, 'p3.txt');
  writeLands(home, repo, [['p1', base, firstTo], ['p3', firstTo, lastTo]]);
  const plan = writePlan(repo, [{ id: 'f', risk: RISKY }], [{ id: 'p1', feature: 'f' }, { id: 'p3', feature: 'f' }]);

  const markedFirst = tick(home, markArgs(repo, plan, 'f', firstTo));
  assert.equal(markedFirst.status, EXIT_SHOWN, markedFirst.stderr);
  const dueResult = tick(home, ['--repo', repo, '--plan', plan]);
  assert.equal(dueResult.status, EXIT_SHOWN, dueResult.stderr);
  assert.equal(featuresLineOf(dueResult), `${FEATURES_LINE} f 2/2 (risk ${RISKY}) -> tess due now (risky f)`, dueResult.stdout);

  const markedLast = tick(home, markArgs(repo, plan, 'f', lastTo));
  assert.equal(markedLast.status, EXIT_SHOWN, markedLast.stderr);
  const checkedResult = tick(home, ['--repo', repo, '--plan', plan]);
  assert.ok(featuresLineOf(checkedResult).startsWith(`${FEATURES_LINE} none`), checkedResult.stdout);
  const feature = factsOf(home, repo, plan).plan.features.find(({ id }) => id === 'f');
  assert.equal(feature.isChecked, true);
});

test('8 --mark-tess calls started at once for 8 features keep all 8 marks and leave no lock file, in each of 4 rounds', async () => {
  const repo = makeRepo();
  const ids = Array.from({ length: PARALLEL_MARKS }, (_, at) => `f${at}`);
  const shaOf = Object.fromEntries(ids.map((id) => [id, commit(repo, `${id}.txt`)]));
  const plan = writePlan(repo, ids.map((id) => ({ id, risk: 'none' })), ids.map((id) => ({ id: `p-${id}`, feature: id })));
  for (let round = 1; round <= ROUNDS; round++) {
    const home = makeHome(); // a fresh marks file each round
    const results = await Promise.all(ids.map((id) => tickAsync(home, markArgs(repo, plan, id, shaOf[id]))));
    results.forEach((result, at) => assert.equal(result.status, EXIT_SHOWN, `round ${round}, ${ids[at]}: ${result.stderr}`));
    const marks = readMarks(home);
    assert.deepEqual(Object.keys(marks).sort(), [...ids].sort(), `round ${round}: the marks file keeps every feature`);
    for (const id of ids) assert.equal(marks[id].sha, shaOf[id], `round ${round}: the mark of ${id}`);
    assert.equal(existsSync(lockFile(home)), false, `round ${round}: no lock file is left`);
  }
});

test('an unchecked feature gets a commits line right after the features line, and --json gives its lands with full shas', () => {
  const repo = makeRepo();
  const home = makeHome();
  const base = headOf(repo);
  const to = commit(repo, 'p1.txt');
  writeLands(home, repo, [['p1', base, to]]);
  const plan = writePlan(repo, [{ id: 'f', risk: 'none' }], [{ id: 'p1', feature: 'f' }]);

  const result = tick(home, ['--repo', repo, '--plan', plan]);
  assert.equal(result.status, EXIT_SHOWN, result.stderr);
  const shown = lines(result);
  const at = shown.findIndex((line) => line.startsWith(FEATURES_LINE));
  assert.ok(at >= 0, result.stdout);
  assert.equal(shown[at + 1], `commits f: ${short(base)}..${short(to)}`, result.stdout);
  assert.match(shown[at + 1], /^commits f: [0-9a-f]{8}\.\.[0-9a-f]{8}$/);

  const feature = factsOf(home, repo, plan).plan.features[0];
  assert.deepEqual(feature.lands, [{ piece: 'p1', from: base, to }]);
});

test('when tess is due and main moved past the last land, the next line names the mark command at main\'s exact sha, and that mark checks the feature', () => {
  const repo = makeRepo();
  const home = makeHome();
  const base = headOf(repo);
  const landedTo = commit(repo, 'p1.txt');
  const mainSha = commit(repo, 'after-the-land.txt');
  writeLands(home, repo, [['p1', base, landedTo]]);
  const plan = writePlan(repo, [{ id: 'f', risk: 'none' }], [{ id: 'p1', feature: 'f' }]);

  const result = tick(home, ['--repo', repo, '--plan', plan]);
  assert.equal(result.status, EXIT_SHOWN, result.stderr);
  const next = lines(result).find((line) => line.startsWith('next:'));
  assert.notEqual(mainSha, landedTo);
  assert.ok(next.includes(`tess on f (mark each: --mark-tess <feature> --sha ${mainSha} with this --repo and --plan)`), next);

  const sha = next.match(/--sha ([0-9a-f]{40})/)[1];
  const marked = tick(home, markArgs(repo, plan, 'f', sha));
  assert.equal(marked.status, EXIT_SHOWN, marked.stderr);
  const after = tick(home, ['--repo', repo, '--plan', plan]);
  assert.ok(featuresLineOf(after).startsWith(`${FEATURES_LINE} none`), after.stdout);
  assert.equal(factsOf(home, repo, plan).plan.features[0].isChecked, true);
});

test('a fresh lock file refuses --mark-tess with exit 2 and changes nothing; a lock 11 seconds old is broken and the mark is written', () => {
  const repo = makeRepo();
  const home = makeHome();
  const firstSha = commit(repo, 'a.txt');
  const secondSha = commit(repo, 'b.txt');
  const plan = writePlan(repo, [{ id: 'a', risk: 'none' }, { id: 'b', risk: 'none' }], [{ id: 'p-a', feature: 'a' }, { id: 'p-b', feature: 'b' }]);
  const first = tick(home, markArgs(repo, plan, 'a', firstSha));
  assert.equal(first.status, EXIT_SHOWN, first.stderr);
  const before = readFileSync(marksFile(home), 'utf8');
  writeFileSync(lockFile(home), '');

  const refused = tick(home, markArgs(repo, plan, 'b', secondSha));
  assert.equal(refused.status, EXIT_USAGE, refused.stdout);
  assert.ok(refused.stderr.includes(FRESH_LOCK_MESSAGE), refused.stderr);
  assert.equal(readFileSync(marksFile(home), 'utf8'), before, 'a refused mark leaves the marks file as it was');
  assert.equal(existsSync(lockFile(home)), true, 'the lock belongs to its holder and stays');

  const past = new Date(Date.now() - STALE_LOCK_AGE_S * 1000);
  utimesSync(lockFile(home), past, past);
  assert.ok(Date.now() - statSync(lockFile(home)).mtimeMs >= STALE_LOCK_AGE_S * 1000 - 1000, 'the lock is made old');
  const marked = tick(home, markArgs(repo, plan, 'b', secondSha));
  assert.equal(marked.status, EXIT_SHOWN, marked.stderr);
  assert.deepEqual(Object.keys(readMarks(home)).sort(), ['a', 'b']);
  assert.equal(readMarks(home).b.sha, secondSha);
  assert.equal(existsSync(lockFile(home)), false, 'the call that broke the stale lock releases its own');
});

// An inherited key of Object.prototype is no mark: without the own-key guard in planState, `marks.constructor` is a function, a feature with no
// land has nothing to cover, and `every` over its empty lands calls it checked. The base code (before tick-features.mjs) has no `lands` field.
const PROTOTYPE_KEY_FEATURES = ['constructor', 'toString', 'valueOf', 'hasOwnProperty'];

test('a feature named after an Object.prototype key, with no piece landed, is not checked: an inherited key is no mark', () => {
  const repo = makeRepo();
  const home = makeHome();
  const plan = writePlan(repo, PROTOTYPE_KEY_FEATURES.map((id) => ({ id, risk: 'none' })), PROTOTYPE_KEY_FEATURES.map((id) => ({ id: `p-${id}`, feature: id })));

  const result = tick(home, ['--repo', repo, '--plan', plan]);
  assert.equal(result.status, EXIT_SHOWN, result.stdout + result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(featuresLineOf(result), `${FEATURES_LINE} none -> tess due at 3 (now 0)`, result.stdout);
  const shown = factsOf(home, repo, plan).plan.features;
  assert.deepEqual(shown, PROTOTYPE_KEY_FEATURES.map((id) => ({ id, risk: 'none', landed: 0, pieces: 1, lands: [], isChecked: false })));
});

test('a piece landed twice and marked at its first land only is due, with both ranges in the commits line, and checked once marked at the second', () => {
  const repo = makeRepo();
  const home = makeHome();
  const base = headOf(repo);
  const firstTo = commit(repo, 'first.txt');
  const secondTo = commit(repo, 'second.txt');
  writeLands(home, repo, [['p1', base, firstTo], ['p1', firstTo, secondTo]]);
  const plan = writePlan(repo, [{ id: 'f', risk: 'none' }], [{ id: 'p1', feature: 'f' }]);
  const marked = tick(home, markArgs(repo, plan, 'f', firstTo));
  assert.equal(marked.status, EXIT_SHOWN, marked.stderr);

  const result = tick(home, ['--repo', repo, '--plan', plan]);
  assert.equal(featuresLineOf(result), `${FEATURES_LINE} f 1/1 (risk none) -> tess due now (last piece landed)`, result.stdout);
  assert.ok(lines(result).includes(`commits f: ${short(base)}..${short(firstTo)} ${short(firstTo)}..${short(secondTo)}`), result.stdout);

  const markedAgain = tick(home, markArgs(repo, plan, 'f', secondTo));
  assert.equal(markedAgain.status, EXIT_SHOWN, markedAgain.stderr);
  const after = tick(home, ['--repo', repo, '--plan', plan]);
  assert.ok(featuresLineOf(after).startsWith(`${FEATURES_LINE} none`), after.stdout);
});
