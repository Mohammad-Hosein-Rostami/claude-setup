// Tests of the plans `board.mjs tick` remembers (home/tools/board/lib/tick-jobs.mjs, tick.mjs, tick-lines.mjs, tick-plan.mjs;
// plan-core-best cb-plans-1): two plans in one tick, a remembered plan used with no --plan, a remembered plan that cannot be read,
// `--forget-plan`, a branch two plans name, a done job forgotten once, parallel ticks that add plans, a torn plans file, a land the
// plan's base already holds, and the plan fields readPlan keeps. Each test runs the CLI as a child process on a throw-away
// repository in the OS temp folder (git-tidy-helpers.mjs), with its own temp HOME, so the plans list, the ledger and the marks go
// to <HOME>/.claude/state/ there and never to the real ~/.claude.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readPlan } from '../home/tools/board/lib/tick-plan.mjs';
import { CLEAN_ENV, commit, git, lines, makeRepo } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const BOARD = fileURLToPath(new URL('../home/tools/board/board.mjs', import.meta.url));
const EXIT_SHOWN = 0;
const EXIT_FINDINGS = 1;
const EXIT_USAGE = 2;
const REPO_KEY_HEX = 16; // the <repo-key> of the land ledger and the board state: the first 16 hex of sha256(real git common dir)
const LANDED_AT = '2026-01-01T00:00:00.000Z';
const PARALLEL_TICKS = 6;
const FEATURES_NONE = 'features landed, not checked: none -> tess due at 3 (now 0)';

const makeHome = () => realpathSync(makeTempDir('board-plans-home-'));
const rootOf = (repo) => git(repo, 'rev-list', '--max-parents=0', 'HEAD');
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

function repoKeyOf(repo) {
  const commonDir = realpathSync.native(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  return createHash('sha256').update(commonDir).digest('hex').slice(0, REPO_KEY_HEX);
}

const plansFile = (home, repo) => join(home, '.claude', 'state', 'board', 'repos', `${repoKeyOf(repo)}.json`);
const rememberedOf = (home, repo) => JSON.parse(readFileSync(plansFile(home, repo), 'utf8')).plans;

/**
 * Writes a pieces.json of job `job` with one feature `f` (risk none) and one piece per id, each declaring `<id>.txt`; the base
 * is the repo's first commit unless `base` is given. Returns its path.
 */
function writePlan(repo, job, ids, { base = rootOf(repo), extra = {} } = {}) {
  const path = join(makeTempDir('board-plans-plan-'), 'pieces.json');
  const plan = { job, repo, base, features: [{ id: 'f', risk: 'none' }], pieces: ids.map((id) => ({ id, feature: 'f', files: [`${id}.txt`] })), ...extra };
  writeFileSync(path, JSON.stringify(plan));
  return path;
}

/** Writes the land ledger of `repo` under `home`: one landing of `lane/<piece>` from `from` to `to` per `[piece, from, to]`. */
function writeLands(home, repo, lands) {
  const file = join(home, '.claude', 'state', 'land', `${repoKeyOf(repo)}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  const rows = lands.map(([piece, from, to]) => JSON.stringify({ at: LANDED_AT, repo, branch: `lane/${piece}`, from, to, commits: 1 }));
  writeFileSync(file, `${rows.join('\n')}\n`);
}

const nextOf = (result) => lines(result).at(-1);
const forgetCommand = (repo, plan) => `node ~/.claude/tools/board/board.mjs tick --repo ${repo} --forget-plan ${plan}`;

test('two plans in one tick: each job\'s queue, features and base-line part start with its job, and next claims from both', () => {
  const repo = makeRepo();
  const home = makeHome();
  const alpha = writePlan(repo, 'alpha', ['a1']);
  const beta = writePlan(repo, 'beta', ['b1']);

  const result = tick(home, ['--repo', repo, '--plan', alpha, '--plan', beta]);
  assert.equal(result.status, EXIT_SHOWN, result.stdout + result.stderr);
  const shown = lines(result);
  assert.ok(shown[0].endsWith('(git-tidy check 0), alpha: 0 landed and no tess round yet, beta: 0 landed and no tess round yet'), shown[0]);
  for (const line of ['alpha: queue a1 startable', `alpha: ${FEATURES_NONE}`, 'beta: queue b1 startable', `beta: ${FEATURES_NONE}`]) {
    assert.ok(shown.includes(line), `${line} in:\n${result.stdout}`);
  }
  assert.ok(nextOf(result).startsWith('next: claim a1; claim b1; '), nextOf(result));
});

test('a plan passed once is remembered: a tick with no --plan shows it, per repository, and a second plan joins the list', () => {
  const repo = makeRepo();
  const other = makeRepo();
  const home = makeHome();
  const alpha = writePlan(repo, 'alpha', ['a1']);
  assert.equal(tick(home, ['--repo', repo, '--plan', alpha]).status, EXIT_SHOWN);

  const remembered = tick(home, ['--repo', repo]);
  assert.equal(remembered.status, EXIT_SHOWN, remembered.stderr);
  assert.ok(lines(remembered).includes('queue a1 startable'), remembered.stdout);
  assert.deepEqual(rememberedOf(home, repo), [alpha]);
  const elsewhere = tick(home, ['--repo', other]);
  assert.equal(lines(elsewhere).some((line) => line.includes('queue')), false, `another repository never shows it:\n${elsewhere.stdout}`);

  const beta = writePlan(repo, 'beta', ['b1']);
  assert.equal(tick(home, ['--repo', repo, '--plan', beta]).status, EXIT_SHOWN);
  const both = tick(home, ['--repo', repo]);
  assert.ok(lines(both).includes('alpha: queue a1 startable') && lines(both).includes('beta: queue b1 startable'), both.stdout);
  assert.deepEqual(rememberedOf(home, repo), [alpha, beta]);
});

test('a remembered plan file that is gone is a line with its forget command and exit 1, and the rest still prints; --forget-plan removes it', () => {
  const repo = makeRepo();
  const home = makeHome();
  const alpha = writePlan(repo, 'alpha', ['a1']);
  const beta = writePlan(repo, 'beta', ['b1']);
  assert.equal(tick(home, ['--repo', repo, '--plan', alpha, '--plan', beta]).status, EXIT_SHOWN);
  rmSync(beta);

  const result = tick(home, ['--repo', repo]);
  assert.equal(result.status, EXIT_FINDINGS, result.stdout + result.stderr);
  const shown = lines(result);
  assert.ok(shown[0].startsWith('base main '), shown[0]);
  assert.ok(shown.includes(`plan ${beta}: there is no such file (forget it: ${forgetCommand(repo, beta)})`), result.stdout);
  assert.ok(shown.includes('queue a1 startable'), result.stdout);
  assert.ok(shown.at(-1).startsWith('next: '), result.stdout);

  const forgot = tick(home, ['--repo', repo, '--forget-plan', beta]);
  assert.equal(forgot.status, EXIT_SHOWN, forgot.stderr);
  assert.equal(forgot.stdout, `forgot ${beta}\n`);
  assert.deepEqual(rememberedOf(home, repo), [alpha]);
  assert.equal(tick(home, ['--repo', repo]).status, EXIT_SHOWN);
  assert.equal(tick(home, ['--repo', repo, '--forget-plan', beta]).stdout, `${beta} was not remembered\n`);
});

test('a branch two plans name is a clash line and exit 1, and neither piece is startable', () => {
  const repo = makeRepo();
  const home = makeHome();
  const alpha = writePlan(repo, 'alpha', ['x', 'a2']);
  const beta = writePlan(repo, 'beta', ['x']);

  const result = tick(home, ['--repo', repo, '--plan', alpha, '--plan', beta]);
  assert.equal(result.status, EXIT_FINDINGS, result.stdout + result.stderr);
  const shown = lines(result);
  assert.ok(shown.includes('clash lane/x: piece x of alpha, piece x of beta'), result.stdout);
  assert.ok(shown.includes('alpha: queue x clash | a2 startable'), result.stdout);
  assert.ok(shown.includes('beta: queue x clash'), result.stdout);
  assert.equal(nextOf(result).includes('claim x'), false, nextOf(result));
  assert.ok(nextOf(result).includes('claim a2'), nextOf(result));
});

test('a job whose pieces all landed and whose features are all checked prints job done (forgotten) once and leaves the list', () => {
  const repo = makeRepo();
  const home = makeHome();
  const landed = commit(repo, 'a1.txt');
  writeLands(home, repo, [['a1', rootOf(repo), landed]]);
  const alpha = writePlan(repo, 'alpha', ['a1']);
  const due = tick(home, ['--repo', repo, '--plan', alpha]);
  assert.ok(lines(due).includes('features landed, not checked: f 1/1 (risk none) -> tess due now (last piece landed)'), due.stdout);
  assert.ok(nextOf(due).includes(`(mark each: --mark-tess <feature> --sha ${landed} with this --repo and --plan ${alpha})`), nextOf(due));
  assert.equal(tick(home, ['--repo', repo, '--plan', alpha, '--mark-tess', 'f', '--sha', landed]).status, EXIT_SHOWN);

  const done = tick(home, ['--repo', repo]);
  assert.equal(done.status, EXIT_SHOWN, done.stdout + done.stderr);
  assert.ok(lines(done).includes('job alpha done (forgotten)'), done.stdout);
  assert.deepEqual(rememberedOf(home, repo), []);
  const after = tick(home, ['--repo', repo]);
  assert.equal(after.status, EXIT_SHOWN, after.stderr);
  assert.equal(lines(after).some((line) => line.startsWith('job ') || line.startsWith('queue')), false, after.stdout);
});

test(`${PARALLEL_TICKS} ticks started at once, each with its own --plan, keep every plan in the list and leave no lock file`, async () => {
  const repo = makeRepo();
  const home = makeHome();
  const plans = Array.from({ length: PARALLEL_TICKS }, (_, at) => writePlan(repo, `job${at}`, [`p${at}`]));
  const results = await Promise.all(plans.map((plan) => tickAsync(home, ['--repo', repo, '--plan', plan])));
  results.forEach((result, at) => assert.notEqual(result.status, EXIT_USAGE, `tick ${at}: ${result.stderr}`));
  assert.deepEqual([...rememberedOf(home, repo)].sort(), [...plans].sort());
  assert.equal(existsSync(plansFile(home, repo).replace(/\.json$/, '.lock')), false, 'no lock file is left');
});

test('a torn plans file is a line naming it, not a crash: the tick prints, a --plan still shows, and the file is not overwritten', () => {
  const repo = makeRepo();
  const home = makeHome();
  const file = plansFile(home, repo);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '{"plans": [');

  const bare = tick(home, ['--repo', repo]);
  assert.equal(bare.status, EXIT_FINDINGS, bare.stdout + bare.stderr);
  assert.ok(lines(bare)[0].startsWith('base main '), bare.stdout);
  const listLine = lines(bare).find((line) => line.startsWith('plans list: '));
  assert.ok(listLine?.startsWith(`plans list: ${file} is not JSON (`) && listLine.endsWith('; delete it to start the list again'), bare.stdout);

  const alpha = writePlan(repo, 'alpha', ['a1']);
  const given = tick(home, ['--repo', repo, '--plan', alpha]);
  assert.equal(given.status, EXIT_FINDINGS, given.stdout + given.stderr);
  assert.ok(lines(given).some((line) => line.startsWith(`plans list: ${file} is not JSON`)), given.stdout);
  assert.ok(lines(given).includes('queue a1 startable'), given.stdout);
  assert.equal(readFileSync(file, 'utf8'), '{"plans": [');
});

test('a land the plan\'s base already holds is an older job\'s: the piece still waits, and a land after the base counts', () => {
  const repo = makeRepo();
  const home = makeHome();
  const root = rootOf(repo);
  const oldTo = commit(repo, 'old.txt');
  writeLands(home, repo, [['a1', root, oldTo]]);
  const alpha = writePlan(repo, 'alpha', ['a1'], { base: oldTo });
  const before = tick(home, ['--repo', repo, '--plan', alpha]);
  assert.ok(lines(before).includes('queue a1 startable'), before.stdout);
  assert.ok(lines(before).includes(FEATURES_NONE), before.stdout);

  const newTo = commit(repo, 'a1.txt');
  writeLands(home, repo, [['a1', root, oldTo], ['a1', oldTo, newTo]]);
  const after = tick(home, ['--repo', repo, '--plan', alpha, '--json']);
  assert.deepEqual(JSON.parse(after.stdout).jobs[0].features[0].lands, [{ piece: 'a1', from: oldTo, to: newTo }]);
});

test('--mark-tess with two --plan flags, or --forget-plan with a --plan, is exit 2', () => {
  const repo = makeRepo();
  const home = makeHome();
  const alpha = writePlan(repo, 'alpha', ['a1']);
  const beta = writePlan(repo, 'beta', ['b1']);
  const mark = tick(home, ['--repo', repo, '--plan', alpha, '--plan', beta, '--mark-tess', 'f', '--sha', rootOf(repo)]);
  assert.equal(mark.status, EXIT_USAGE, mark.stdout);
  assert.match(mark.stderr, /--mark-tess needs one --plan/);
  const forget = tick(home, ['--repo', repo, '--plan', alpha, '--forget-plan', beta]);
  assert.equal(forget.status, EXIT_USAGE, forget.stdout);
  assert.match(forget.stderr, /--forget-plan goes with --repo alone/);
  assert.equal(existsSync(plansFile(home, repo)), false, 'a refused call remembers nothing');
});

test('readPlan keeps the base and the optional text fields, and refuses a bad base or a field that is no string', () => {
  const repo = makeRepo();
  const root = rootOf(repo);
  const texts = { spec: 'plan.md#one', qa: 'quick look', acceptance: 'tests exit 0' };
  const path = writePlan(repo, 'alpha', [], {
    extra: { features: [{ id: 'f', risk: 'none', ...texts }], pieces: [{ id: 'a1', feature: 'f', files: ['a.txt'], acceptance: 'a.txt exists' }] },
  });
  const plan = readPlan(path, { dir: repo });
  assert.equal(plan.base, root);
  assert.deepEqual(plan.features, [{ id: 'f', risk: 'none', ...texts }]);
  assert.deepEqual(plan.pieces, [{ id: 'a1', feature: 'f', files: ['a.txt'], after: [], branch: null, acceptance: 'a.txt exists' }]);

  const cases = [
    [{ base: 'abc' }, '"base" must be the full 40-hex sha'],
    [{ base: '1'.repeat(40) }, `"base" ${'1'.repeat(8)} is no commit of this repository`],
    [{ pieces: [{ id: 'a1', feature: 'f', files: ['a.txt'], acceptance: ['a list'] }] }, 'piece a1 has a non-string "acceptance"'],
  ];
  for (const [extra, message] of cases) {
    const bad = writePlan(repo, 'alpha', [], { extra });
    const result = tick(makeHome(), ['--repo', repo, '--plan', bad]);
    assert.equal(result.status, EXIT_USAGE, result.stdout);
    assert.ok(result.stderr.includes(`plan ${bad}: it is not a valid pieces.json: ${message}`), result.stderr);
  }
});
