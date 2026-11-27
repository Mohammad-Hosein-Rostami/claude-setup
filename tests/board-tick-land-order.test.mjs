// Tests of the order of a feature's lands in `board.mjs tick` (home/tools/board/lib/tick-features.mjs): the plan promises "every land in
// ledger order" for the `commits <feature>:` line and for `--json` features[].lands, so the first range starts at the oldest land.
// It is a file of its own because the tick may order the lands by the plan's pieces instead. The CLI runs as a child process on a
// throw-away repository in the OS temp folder (git-tidy-helpers.mjs) with its own temp HOME, so the ledger goes to <HOME>/.claude/state/
// there and never to the real ~/.claude.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLEAN_ENV, commit, git, lines, makeRepo } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const BOARD = fileURLToPath(new URL('../home/tools/board/board.mjs', import.meta.url));
const EXIT_SHOWN = 0;
const REPO_KEY_HEX = 16; // the <repo-key> of the land ledger: the first 16 hex of the sha256 of the real git common dir
const SHORT_SHA = 8;
const JOB = 'orderjob';
const LANDED_AT = '2026-01-01T00:00:00.000Z';

const short = (sha) => sha.slice(0, SHORT_SHA);

/** Runs `board.mjs tick <args>` with `home` as HOME and USERPROFILE; no session id is set, so no agent is on the board. */
const tick = (home, args) =>
  spawnSync(process.execPath, [BOARD, 'tick', ...args], { encoding: 'utf8', env: { ...CLEAN_ENV, HOME: home, USERPROFILE: home } });

/** A pieces.json with one feature `f` and the pieces `ids` in this order (the plan's order); returns its path. */
function writePlan(repo, ids) {
  const path = join(makeTempDir('board-order-plan-'), 'pieces.json');
  const plan = {
    // the base's sha when the plan was written: the first commit, before every land the test writes, so the lands count
    job: JOB, repo, base: git(repo, 'rev-list', '--max-parents=0', 'HEAD'),
    features: [{ id: 'f', risk: 'none', spec: 'plan.md#one' }],
    pieces: ids.map((id) => ({ id, feature: 'f', files: [`${id}.txt`] })),
  };
  writeFileSync(path, JSON.stringify(plan));
  return path;
}

/** Writes the land ledger of `repo` under `home`: one landing of `lane/<piece>` from `from` to `to` per `[piece, from, to]`, in this order. */
function writeLands(home, repo, lands) {
  const commonDir = realpathSync.native(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  const key = createHash('sha256').update(commonDir).digest('hex').slice(0, REPO_KEY_HEX);
  const file = join(home, '.claude', 'state', 'land', `${key}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  const rows = lands.map(([piece, from, to]) => JSON.stringify({ at: LANDED_AT, repo, branch: `lane/${piece}`, from, to, commits: 1 }));
  writeFileSync(file, `${rows.join('\n')}\n`);
}

/** A repo with 3 landings in ledger order p2, p1, p2 (the plan lists p1 first); returns the repo, the HOME, the plan and the lands. */
function interleavedLands() {
  const repo = makeRepo();
  const home = realpathSync(makeTempDir('board-order-home-'));
  const first = git(repo, 'rev-parse', 'HEAD');
  const second = commit(repo, 'second.txt');
  const third = commit(repo, 'third.txt');
  const fourth = commit(repo, 'fourth.txt');
  const lands = [{ piece: 'p2', from: first, to: second }, { piece: 'p1', from: second, to: third }, { piece: 'p2', from: third, to: fourth }];
  writeLands(home, repo, lands.map(({ piece, from, to }) => [piece, from, to]));
  return { repo, home, plan: writePlan(repo, ['p1', 'p2']), lands };
}

test('the commits line of a feature lists its lands in ledger order, so the first range starts at the oldest land', () => {
  const { repo, home, plan, lands } = interleavedLands();
  const result = tick(home, ['--repo', repo, '--plan', plan]);
  assert.equal(result.status, EXIT_SHOWN, result.stderr);
  const expected = `commits f: ${lands.map(({ from, to }) => `${short(from)}..${short(to)}`).join(' ')}`;
  assert.ok(lines(result).includes(expected), `expected "${expected}" in:\n${result.stdout}`);
});

test('--json features[].lands lists the lands in ledger order, whatever order the plan names the pieces', () => {
  const { repo, home, plan, lands } = interleavedLands();
  const result = tick(home, ['--repo', repo, '--plan', plan, '--json']);
  assert.equal(result.status, EXIT_SHOWN, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).jobs[0].features[0].lands, lands);
});
