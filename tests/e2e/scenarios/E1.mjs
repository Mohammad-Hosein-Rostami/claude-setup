// E1, boss routing over a full job (plan section 9): the owner asks for slugify's maxLength option planned, built, checked and
// landed; the checks judge by transcripts and git, never by what an agent says it did (plan section 10, trust).
// Exports the scenario interface (run.mjs): id, title, model, minutes, needsShims, setup(ctx), run(ctx), check(ctx).
import { backgroundShellsLeft, bossFileCalls, checkLine, LIMITS, longSleeps, reportWords, startsOf, testRunnerCommands, unmetNeeds } from '../lib/checks.mjs';
import { gitOut, loadedAll, readFailed } from '../lib/common.mjs';
import { makeLibrary } from '../lib/repo.mjs';
import { finalText, toolCalls } from '../lib/transcripts.mjs';

export const id = 'E1';
export const title = 'boss routing over a full job: plan, build, check, land';
export const model = 'opus';
export const minutes = LIMITS.e1ScenarioMinutes;
export const needsShims = true;

const MAIN = new Set(['lex', 'dev', 'tess']);
const FILES_LINE = /^\s*[-*]?\s*`?files:/im;
const LAND_CALL = /\bland(?:\.mjs)?\b/;
const PROMPT = 'Add `slugify(text, {maxLength})` to the library in src/slug.mjs. Acceptance: 1. slugify("Hello World") is "hello-world"; '
  + '2. slugify("a b c", {maxLength: 3}) is "a-b"; 3. a cut slug never ends with "-". Plan it, build it, check it and land it.';

export function setup(ctx) {
  makeLibrary(ctx);
}

export async function run(ctx) {
  ctx.notes.mainBefore = gitOut(ctx, ['rev-parse', 'main']);
  const job = await ctx.claudeUntil({ name: 'job', prompt: PROMPT, model },
    (session) => moved(ctx.notes.mainBefore, gitOut(ctx, ['rev-parse', 'main'])) && session.result !== null);
  ctx.notes.job = { mode: job.mode, rounds: job.rounds, done: job.done };
}

/** @returns {boolean} both reads of main worked and they differ */
const moved = (before, now) => !readFailed(before) && !readFailed(now) && now !== before;
const listed = (items) => (items.length === 0 ? 'none' : items.slice(0, 8).join('; '));

export function check(ctx) {
  const sessions = loadedAll(ctx);
  const boss = sessions.flatMap((session) => session.lines);
  const agents = sessions.flatMap((session) => session.agents);
  const ofType = (type) => agents.filter((agent) => agent.type === type);
  const bossStarts = startsOf(boss);
  const offRoute = bossStarts.filter((start) => !MAIN.has(start.type)).map((start) => start.type);
  const devParts = ofType('dev').flatMap((agent) => startsOf(agent.lines)).filter((start) => start.type === 'dev-part' && !start.denied);
  const runners = [...ofType('dev'), ...ofType('dev-part')].flatMap((agent) => testRunnerCommands(agent.lines).map((command) => `${agent.type}: ${command}`));
  const tessStarts = ofType('tess').flatMap((agent) => startsOf(agent.lines)).filter((start) => !start.denied).map((start) => start.type);
  const mainNow = gitOut(ctx, ['rev-parse', 'main']);
  const merges = gitOut(ctx, ['rev-list', '--merges', 'main']);
  const refs = gitOut(ctx, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  const trees = gitOut(ctx, ['worktree', 'list', '--porcelain']);
  const failedReads = [ctx.notes.mainBefore, mainNow, merges, refs, trees].filter(readFailed).map(String);
  const branches = refs.split('\n').filter((name) => name && name !== 'main');
  const worktrees = trees.split('\n').filter((line) => line.startsWith('worktree ')).length;
  const landed = [{ lines: boss }, ...agents].some((agent) => toolCalls(agent.lines).some((call) => call.name === 'Bash' && LAND_CALL.test(String(call.input.command ?? '')) && /landed/.test(call.result?.text ?? '')));
  const repoDirs = [ctx.repo, ctx.dir];
  const fileCalls = bossFileCalls(boss, repoDirs);
  const shellsLeft = agents.flatMap((agent) => backgroundShellsLeft(agent.lines).map((shell) => `${agent.type} ${agent.id}: ${shell}`));
  const sleeps = agents.flatMap((agent) => longSleeps(agent.lines).map((command) => `${agent.type}: ${command}`));
  const longReports = agents.filter((agent) => MAIN.has(agent.type)).map((agent) => ({ agent, words: reportWords(finalText(agent.lines)?.text) }))
    .filter(({ words }) => words > LIMITS.maxReportWords).map(({ agent, words }) => `${agent.type} ${agent.id}: ${words} words`);
  const unmet = sessions.flatMap((session) => unmetNeeds(session));
  return [
    checkLine('the job was done', `main moved (at most ${LIMITS.maxResumeRounds} resume rounds)`, ctx.notes.job?.mode ?? 'not run', ctx.notes.job?.done === true),
    checkLine('boss Agent calls go only to lex, dev or tess', 'only lex, dev, tess', `${bossStarts.length} start(s); off route: ${listed(offRoute)}`,
      bossStarts.length > 0 && offRoute.length === 0),
    checkLine('dev started a dev-part with a files: line', 'at least 1', `${devParts.length} dev-part start(s), ${devParts.filter((start) => FILES_LINE.test(start.prompt)).length} with files:`,
      devParts.some((start) => FILES_LINE.test(start.prompt))),
    checkLine('no test-runner command in dev or dev-part Bash', LIMITS.maxTestRunnerCommands, listed(runners), runners.length <= LIMITS.maxTestRunnerCommands),
    checkLine('tess started tess-run and tess-simple', 'tess-run and tess-simple', listed([...new Set(tessStarts)]),
      tessStarts.includes('tess-run') && tessStarts.includes('tess-simple')),
    checkLine('main was moved by land, in a straight line, the lane cleaned up', 'main moved, land ran, no merge commit, no other branch, one worktree',
      failedReads.length > 0 ? `git reads failed: ${failedReads.join('; ')}`
        : `main ${mainNow.slice(0, 12)} (was ${String(ctx.notes.mainBefore).slice(0, 12)}), land ${landed ? 'ran' : 'not seen'}, merges ${merges ? merges.split('\n').length : 0}, branches ${listed(branches)}, worktrees ${worktrees}`,
      failedReads.length === 0 && moved(ctx.notes.mainBefore, mainNow) && landed && merges === '' && branches.length === 0 && worktrees === 1),
    checkLine('boss Read/Edit/Write/Grep/Glob on repo files', LIMITS.maxBossFileCalls, listed(fileCalls), fileCalls.length <= LIMITS.maxBossFileCalls),
    checkLine('background shells left at a subagent report', LIMITS.maxBackgroundShellsLeft, listed(shellsLeft), agents.length > 0 && shellsLeft.length <= LIMITS.maxBackgroundShellsLeft),
    checkLine(`subagent sleeps of ${LIMITS.longSleepSeconds} s or more`, LIMITS.maxLongSleeps, listed(sleeps), agents.length > 0 && sleeps.length <= LIMITS.maxLongSleeps),
    checkLine(`main-agent reports of at most ${LIMITS.maxReportWords} words before questions:`, 'none longer', listed(longReports),
      agents.some((agent) => MAIN.has(agent.type)) && longReports.length === 0),
    checkLine('each needs: line followed by a boss start of that agent', 'none unmet', listed(unmet), unmet.length === 0),
  ];
}
