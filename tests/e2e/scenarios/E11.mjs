// E11, leaks over the whole run (plan section 9; it runs last): the note and sound tools resolve to the run's shims; the real
// checkout's git status and the real long-run state listing are the same as before the run. The guard-log lines this scenario
// once checked are gone with the guard.
// The "before" snapshot is taken by run.mjs before the first scenario (run.before); this scenario takes the "after" one.
// Exports the scenario interface (run.mjs): id, title, model, minutes, needsShims, setup(ctx), run(ctx), check(ctx).
import { join } from 'node:path';
import { checkLine, LIMITS } from '../lib/checks.mjs';
import { leakSnapshot, resolveTools, WATCHED_TOOLS } from '../lib/leaks.mjs';
import { readText, sameRead } from '../lib/common.mjs';

export const id = 'E11';
export const title = 'leaks: shims only, the real setup unchanged';
export const model = 'none';
export const minutes = LIMITS.defaultScenarioMinutes;
export const needsShims = true;

const isUnder = (path, dirs) => dirs.some((dir) => dir && (path === dir || path.startsWith(`${dir}/`)));

export function setup(ctx) {
  ctx.mkdir(ctx.dir);
}

export function run(ctx) {
  ctx.record(`compare: git -C ${ctx.run.realRepo ?? '<real checkout>'} status --porcelain and ls ${join(ctx.realHome, '.claude', 'state', 'long-run')} with the run start`);
  ctx.record(`resolve ${WATCHED_TOOLS.join(', ')} on the children's PATH`);
  if (ctx.dry) return;
  ctx.notes.after = leakSnapshot({ realHome: ctx.realHome, realRepo: ctx.run.realRepo });
  ctx.notes.tools = resolveTools(ctx.env());
}

export function check(ctx) {
  const { before, shimDirs = [] } = ctx.run;
  const { after, tools = {} } = ctx.notes;
  const notShim = Object.entries(tools).filter(([, path]) => !isUnder(path, shimDirs)).map(([tool, path]) => `${tool}: ${path || 'not found'}`);
  return [
    checkLine(`${WATCHED_TOOLS.join(', ')} resolve to the run's shims`, 'every one under the run bin or the quiet tools',
      notShim.join('; ') || Object.values(tools).join(', '), Object.keys(tools).length === WATCHED_TOOLS.length && notShim.length === 0),
    checkLine('the real checkout git status is unchanged', 'the same as before the run (both reads work)',
      sameRead(before?.gitStatus, after?.gitStatus) ? `unchanged (${before.gitStatus.split('\n').filter(Boolean).length} lines)` : readText(before?.gitStatus, after?.gitStatus),
      sameRead(before?.gitStatus, after?.gitStatus)),
    checkLine('the real ~/.claude/state/long-run listing is unchanged', 'the same as before the run', before?.longRun === after?.longRun ? 'unchanged' : 'changed',
      before !== null && after !== undefined && before.longRun === after.longRun),
  ];
}
