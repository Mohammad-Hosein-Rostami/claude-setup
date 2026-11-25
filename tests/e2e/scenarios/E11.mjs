// E11, leaks over the whole run (plan section 9; it runs last): the dialog, note and sound tools resolve to the run's shims; the
// real checkout's git status and the real long-run state listing are the same as before the run; the guard log lines of the
// run carry only the run's session ids; the real guard log holds none of them.
// The "before" snapshot is taken by run.mjs before the first scenario (run.before); this scenario takes the "after" one.
// With `--real-home` E9 writes to the real guard log, so the last line is NOT RUN then (never a pass on a log the run shared).
// Exports the scenario interface (run.mjs): id, title, model, minutes, needsShims, setup(ctx), run(ctx), check(ctx).
import { join } from 'node:path';
import { checkLine, LIMITS } from '../lib/checks.mjs';
import { leakSnapshot, resolveTools, WATCHED_TOOLS } from '../lib/leaks.mjs';
import { guardLines } from '../lib/logs.mjs';
import { readText, sameRead } from '../lib/common.mjs';
import { notRunLine } from '../lib/report.mjs';

export const id = 'E11';
export const title = 'leaks: shims only, the real setup unchanged, guard lines of the run only';
export const model = 'none';
export const minutes = LIMITS.defaultScenarioMinutes;
export const needsShims = true;

const isUnder = (path, dirs) => dirs.some((dir) => dir && (path === dir || path.startsWith(`${dir}/`)));

export function setup(ctx) {
  ctx.mkdir(ctx.dir);
}

export function run(ctx) {
  ctx.record(`compare: git -C ${ctx.run.realRepo ?? '<real checkout>'} status --porcelain and ls ${join(ctx.realHome, '.claude', 'state', 'long-run')} with the run start`);
  ctx.record(`resolve ${WATCHED_TOOLS.join(', ')} on the children's PATH; read ${ctx.paths.guardLog} and the real guard log`);
  if (ctx.dry) return;
  ctx.notes.after = leakSnapshot({ realHome: ctx.realHome, realRepo: ctx.run.realRepo });
  ctx.notes.tools = resolveTools(ctx.env());
}

export function check(ctx) {
  const { before, sessionIds, shimDirs = [], realHomeMode } = ctx.run;
  const { after, tools = {} } = ctx.notes;
  const notShim = Object.entries(tools).filter(([, path]) => !isUnder(path, shimDirs)).map(([tool, path]) => `${tool}: ${path || 'not found'}`);
  const runLines = guardLines(ctx.paths.guardLog).filter((line) => realHomeMode !== true || isUnder(String(line.cwd ?? ''), [ctx.run.root]));
  const foreign = [...new Set(runLines.map((line) => String(line.session ?? '')).filter((session) => !sessionIds.has(session)))];
  const inReal = realHomeMode ? [] : [...sessionIds].filter((session) => after?.realGuardSessions.has(session) && !before?.realGuardSessions.has(session));
  return [
    checkLine(`${WATCHED_TOOLS.join(', ')} resolve to the run's shims`, 'every one under the run bin or the quiet tools',
      notShim.join('; ') || Object.values(tools).join(', '), Object.keys(tools).length === WATCHED_TOOLS.length && notShim.length === 0),
    checkLine('the real checkout git status is unchanged', 'the same as before the run (both reads work)',
      sameRead(before?.gitStatus, after?.gitStatus) ? `unchanged (${before.gitStatus.split('\n').filter(Boolean).length} lines)` : readText(before?.gitStatus, after?.gitStatus),
      sameRead(before?.gitStatus, after?.gitStatus)),
    checkLine('the real ~/.claude/state/long-run listing is unchanged', 'the same as before the run', before?.longRun === after?.longRun ? 'unchanged' : 'changed',
      before !== null && after !== undefined && before.longRun === after.longRun),
    checkLine("the run's guard log lines carry only the run's session ids", `only the ${sessionIds.size} session id(s) of the run`,
      foreign.length === 0 ? `${runLines.length} line(s), all of the run` : `other ids: ${foreign.slice(0, 5).join(', ')}`, foreign.length === 0),
    realHomeMode ? notRunLine("the real guard log holds no line of the run's sessions", '--real-home: E9 used the real HOME and its guard log')
      : checkLine("the real guard log holds no line of the run's sessions", 'none', inReal.join(', ') || 'none', inReal.length === 0),
  ];
}
