// E7, land with an overlap (plan section 9, tools only, no claude): lanes a, b and c change different hunks of src/slug.mjs; a
// lands; with a failing --test on b main stays and the lane is intact; with a passing one main fast-forwards to the tested sha;
// c then lands without --test although both sides changed the file (owner decision, ef222fdd: no forced test on an overlap); no
// merge commit anywhere.
// Exports the scenario interface (run.mjs): id, title, model, minutes, needsShims, setup(ctx), run(ctx), check(ctx).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkLine, LIMITS } from '../lib/checks.mjs';
import { gitOut, readFailed, sameRead } from '../lib/common.mjs';
import { addWorktree, commitAll, LANE_A_HEADER, LANE_B_TAIL, makeLibrary, SLUG_SOURCE } from '../lib/repo.mjs';

export const id = 'E7';
export const title = 'land: a failing --test keeps main, a passing one lands, an overlap lands without a test';
export const model = 'none';
export const minutes = LIMITS.defaultScenarioMinutes;
export const needsShims = false;

const FILE = 'src/slug.mjs';
const FAILING_TEST = 'node -e "process.exit(1)"';
const PASSING_TEST = 'node -e "process.exit(0)"';
const TESTED = /test passed on ([0-9a-f]{40})/;
const LANDED = /landed \S+ on main at ([0-9a-f]{40})/;
const LOWER_LINE = '  return String(text).toLowerCase().trim();'; // lane c swaps the two calls: a hunk apart from lane a's and lane b's
const LANE_C_LOWER_LINE = '  return String(text).trim().toLowerCase();';

export function setup(ctx) {
  makeLibrary(ctx, { testScript: false });
  const [firstLine, ...rest] = SLUG_SOURCE.split('\n');
  ctx.notes.laneA = addWorktree(ctx, 'lane-a', 'lane/a');
  ctx.write(join(ctx.notes.laneA, FILE), [LANE_A_HEADER, ...rest].join('\n'), { label: `lane a: a new first line (was ${firstLine.length} chars)` });
  commitAll(ctx, ctx.notes.laneA, 'docs(slug): lane a header');
  ctx.notes.laneB = addWorktree(ctx, 'lane-b', 'lane/b');
  ctx.write(join(ctx.notes.laneB, FILE), `${SLUG_SOURCE}${LANE_B_TAIL}\n`, { label: 'lane b: a new last line' });
  commitAll(ctx, ctx.notes.laneB, 'feat(slug): lane b version');
  ctx.notes.laneC = addWorktree(ctx, 'lane-c', 'lane/c');
  assert.ok(SLUG_SOURCE.includes(LOWER_LINE), 'lane c edits a line that lib/repo.mjs still has');
  ctx.write(join(ctx.notes.laneC, FILE), SLUG_SOURCE.replace(LOWER_LINE, LANE_C_LOWER_LINE), { label: 'lane c: trim before lowering' });
  commitAll(ctx, ctx.notes.laneC, 'refactor(slug): lane c version');
}

const land = (ctx, branch, extra = []) => ctx.exec(process.execPath, [ctx.tool('land', 'land.mjs'), branch, '--repo', ctx.repo, ...extra]);

export function run(ctx) {
  ctx.notes.landA = land(ctx, 'lane/a');
  ctx.notes.mainAfterA = gitOut(ctx, ['rev-parse', 'main']);
  ctx.notes.failing = land(ctx, 'lane/b', ['--test', FAILING_TEST]);
  ctx.notes.mainAfterFailing = gitOut(ctx, ['rev-parse', 'main']);
  // exit 0 only while the branch exists (a failed read is "gone", so the check fails rather than passes on it)
  ctx.notes.laneBAfterFailing = { branch: ctx.git(['rev-parse', '--verify', '--quiet', 'refs/heads/lane/b']).code === 0, worktree: existsSync(ctx.notes.laneB) };
  ctx.notes.passing = land(ctx, 'lane/b', ['--test', PASSING_TEST]);
  ctx.notes.mainAfterPassing = gitOut(ctx, ['rev-parse', 'main']);
  ctx.notes.noTest = land(ctx, 'lane/c');
  ctx.notes.mainAfterNoTest = gitOut(ctx, ['rev-parse', 'main']);
  ctx.notes.merges = gitOut(ctx, ['rev-list', '--merges', '--all']);
}

const said = (result) => `exit ${result?.code ?? '?'}: ${`${result?.stdout ?? ''} ${result?.stderr ?? ''}`.trim().slice(0, 200)}`;

export function check(ctx) {
  const { landA, noTest, failing, passing, mainAfterA, mainAfterNoTest, mainAfterFailing, mainAfterPassing, laneBAfterFailing, merges } = ctx.notes;
  const tested = TESTED.exec(passing?.stdout ?? '')?.[1] ?? null;
  const landedAt = LANDED.exec(passing?.stdout ?? '')?.[1] ?? null;
  const landedWithoutTest = LANDED.exec(noTest?.stdout ?? '')?.[1] ?? null;
  return [
    checkLine('lane a lands', 'exit 0', said(landA), landA?.code === 0),
    checkLine('a failing --test keeps main and lane b', 'exit 1, main unmoved, lane b branch and worktree there',
      `${said(failing)}; main ${sameRead(mainAfterFailing, mainAfterA) ? 'unmoved' : readFailed(mainAfterFailing) || readFailed(mainAfterA) ? 'not read' : 'moved'}; branch ${laneBAfterFailing?.branch ? 'there' : 'gone'}; worktree ${laneBAfterFailing?.worktree ? 'there' : 'gone'}`,
      failing?.code === 1 && sameRead(mainAfterFailing, mainAfterA) && Boolean(laneBAfterFailing?.branch) && laneBAfterFailing?.worktree === true),
    checkLine('a passing --test fast-forwards main to the tested sha', 'exit 0, main = the sha the test passed on',
      `${said(passing)}; main ${String(mainAfterPassing).slice(0, 12)}, tested ${String(tested).slice(0, 12)}`,
      passing?.code === 0 && tested !== null && sameRead(mainAfterPassing, tested) && landedAt === tested),
    checkLine('lane c lands without --test although both sides changed the file', 'exit 0, main = the sha land reported',
      `${said(noTest)}; main ${String(mainAfterNoTest).slice(0, 12)}, landed ${String(landedWithoutTest).slice(0, 12)}`,
      noTest?.code === 0 && landedWithoutTest !== null && sameRead(mainAfterNoTest, landedWithoutTest)),
    checkLine('no merge commit', 'none (the read works)', readFailed(merges) ? String(merges) : merges ? merges.split('\n').length : 0, merges === ''),
  ];
}
