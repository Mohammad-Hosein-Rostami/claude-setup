// E7, land with an overlap (plan section 9, tools only, no claude): lanes a and b change different hunks of src/slug.mjs; a
// lands; b without --test is refused listing the file; with a failing --test main stays and the lane is intact; with a passing
// one main fast-forwards to the tested sha; no merge commit anywhere. The library has no npm test script, so land needs --test.
// Exports the scenario interface (run.mjs): id, title, model, minutes, needsShims, setup(ctx), run(ctx), check(ctx).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkLine, LIMITS } from '../lib/checks.mjs';
import { gitOut, readFailed, sameRead } from '../lib/common.mjs';
import { addWorktree, commitAll, LANE_A_HEADER, LANE_B_TAIL, makeLibrary, SLUG_SOURCE } from '../lib/repo.mjs';

export const id = 'E7';
export const title = 'land: an overlap needs a test; a failing one keeps main, a passing one lands';
export const model = 'none';
export const minutes = LIMITS.defaultScenarioMinutes;
export const needsShims = false;

const FILE = 'src/slug.mjs';
const FAILING_TEST = 'node -e "process.exit(1)"';
const PASSING_TEST = 'node -e "process.exit(0)"';
const TESTED = /test passed on ([0-9a-f]{40})/;
const LANDED = /landed \S+ on main at ([0-9a-f]{40})/;

export function setup(ctx) {
  makeLibrary(ctx, { testScript: false });
  const [firstLine, ...rest] = SLUG_SOURCE.split('\n');
  ctx.notes.laneA = addWorktree(ctx, 'lane-a', 'lane/a');
  ctx.write(join(ctx.notes.laneA, FILE), [LANE_A_HEADER, ...rest].join('\n'), { label: `lane a: a new first line (was ${firstLine.length} chars)` });
  commitAll(ctx, ctx.notes.laneA, 'docs(slug): lane a header');
  ctx.notes.laneB = addWorktree(ctx, 'lane-b', 'lane/b');
  ctx.write(join(ctx.notes.laneB, FILE), `${SLUG_SOURCE}${LANE_B_TAIL}\n`, { label: 'lane b: a new last line' });
  commitAll(ctx, ctx.notes.laneB, 'feat(slug): lane b version');
}

const land = (ctx, branch, extra = []) => ctx.exec(process.execPath, [ctx.tool('land', 'land.mjs'), branch, '--repo', ctx.repo, ...extra]);

export function run(ctx) {
  ctx.notes.landA = land(ctx, 'lane/a');
  ctx.notes.mainAfterA = gitOut(ctx, ['rev-parse', 'main']);
  ctx.notes.noTest = land(ctx, 'lane/b');
  ctx.notes.mainAfterNoTest = gitOut(ctx, ['rev-parse', 'main']);
  ctx.notes.failing = land(ctx, 'lane/b', ['--test', FAILING_TEST]);
  ctx.notes.mainAfterFailing = gitOut(ctx, ['rev-parse', 'main']);
  // exit 0 only while the branch exists (a failed read is "gone", so the check fails rather than passes on it)
  ctx.notes.laneBAfterFailing = { branch: ctx.git(['rev-parse', '--verify', '--quiet', 'refs/heads/lane/b']).code === 0, worktree: existsSync(ctx.notes.laneB) };
  ctx.notes.passing = land(ctx, 'lane/b', ['--test', PASSING_TEST]);
  ctx.notes.mainAfterPassing = gitOut(ctx, ['rev-parse', 'main']);
  ctx.notes.merges = gitOut(ctx, ['rev-list', '--merges', '--all']);
}

const said = (result) => `exit ${result?.code ?? '?'}: ${`${result?.stdout ?? ''} ${result?.stderr ?? ''}`.trim().slice(0, 200)}`;

export function check(ctx) {
  const { landA, noTest, failing, passing, mainAfterA, mainAfterNoTest, mainAfterFailing, mainAfterPassing, laneBAfterFailing, merges } = ctx.notes;
  const tested = TESTED.exec(passing?.stdout ?? '')?.[1] ?? null;
  const landedAt = LANDED.exec(passing?.stdout ?? '')?.[1] ?? null;
  return [
    checkLine('lane a lands', 'exit 0', said(landA), landA?.code === 0),
    checkLine('lane b without --test is refused, listing the file', `exit 1, ${FILE} listed, main unmoved`, said(noTest),
      noTest?.code === 1 && `${noTest.stdout}${noTest.stderr}`.includes(FILE) && sameRead(mainAfterNoTest, mainAfterA)),
    checkLine('a failing --test keeps main and lane b', 'exit 1, main unmoved, lane b branch and worktree there',
      `${said(failing)}; main ${sameRead(mainAfterFailing, mainAfterA) ? 'unmoved' : readFailed(mainAfterFailing) || readFailed(mainAfterA) ? 'not read' : 'moved'}; branch ${laneBAfterFailing?.branch ? 'there' : 'gone'}; worktree ${laneBAfterFailing?.worktree ? 'there' : 'gone'}`,
      failing?.code === 1 && sameRead(mainAfterFailing, mainAfterA) && Boolean(laneBAfterFailing?.branch) && laneBAfterFailing?.worktree === true),
    checkLine('a passing --test fast-forwards main to the tested sha', 'exit 0, main = the sha the test passed on',
      `${said(passing)}; main ${String(mainAfterPassing).slice(0, 12)}, tested ${String(tested).slice(0, 12)}`,
      passing?.code === 0 && tested !== null && sameRead(mainAfterPassing, tested) && landedAt === tested),
    checkLine('no merge commit', 'none (the read works)', readFailed(merges) ? String(merges) : merges ? merges.split('\n').length : 0, merges === ''),
  ];
}
