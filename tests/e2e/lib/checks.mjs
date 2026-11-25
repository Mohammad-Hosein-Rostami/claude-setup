// The transcript checks of the e2e scenarios and every threshold they use. Exports: LIMITS, checkLine, backgroundShellsLeft,
// longSleeps, testRunnerCommands, fableModels, reportWords, bossFileCalls, unmetNeeds, startsOf, completedAt, everyAgent.
// Each check reads parsed transcript lines (transcripts.mjs) and returns what it found, so a scenario turns it into a check line
// `{check, expected, observed, pass}` with checkLine. Plan section 7 M7 and section 9 E1 define what counts.
// Invariants: pure, no file access; an empty transcript gives "nothing found", and the scenario then also checks that the
// transcript exists, so a missing one is FAIL, never PASS (plan section 10: empty is not clean).
import { agentStarts, assistantTexts, finalText, toolCalls, userTexts } from './transcripts.mjs';

/** Every number a scenario judges by (plan sections 7 and 9). Change one here, nowhere else. */
export const LIMITS = Object.freeze({
  maxReportWords: 150, // a main agent's report, counted before its `questions:` block
  longSleepSeconds: 5, // a `sleep` of this many seconds or more counts as polling (M7)
  maxLongSleeps: 0,
  maxBackgroundShellsLeft: 0, // background shells still running when an agent reported (M7)
  maxTestRunnerCommands: 0, // in dev and dev-part Bash: tests are tess's (E1)
  maxBossFileCalls: 0, // boss Read/Edit/Write/Grep/Glob on repo files (E1, M3)
  maxResumeRounds: 20, // `--resume <id> "continue"` rounds when a run ends before its job (U2)
  mainAgentCap: 3, // lex, dev, tess running at once per type
  e0dMinAgentMinutes: 12, // E0d: the wait ceiling must hold an agent at least this long
  defaultScenarioMinutes: 40, // wall-clock timeout of one scenario
  e1ScenarioMinutes: 120,
});

const MAIN_TYPES = new Set(['lex', 'dev', 'tess']);
const TEST_RUNNER = /\bnode\b[^|;&\n]*\s--test\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bvitest\b|\bjest\b/;
const SLEEP = /(?:^|[\s;&|()`])sleep\s+(\d+(?:\.\d+)?)([smhd]?)(?=$|[\s;&|)`])/g;
const UNIT_S = { '': 1, s: 1, m: 60, h: 3600, d: 86400 };
const STOP_TOOLS = new Set(['TaskStop', 'KillShell', 'KillBash']);
const NOTICE = /<task-notification>[\s\S]*?<\/task-notification>/g;
const NOTICE_ID = /<task-id>([^<]+)<\/task-id>/g;
const NOTICE_DONE = /<status>\s*(completed|failed|killed|stopped|cancelled)\s*<\/status>/;
const BACKGROUND_ID = /running in background with ID:\s*([A-Za-z0-9_-]+)/;
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob']); // these default to the working folder when no path is given
const NEEDS = /^\s*[-*]?\s*`?needs:\s*`?\s*([a-z][a-z-]*)\s+to\b/gim;
const QUESTIONS = /^\s*[-*]?\s*`?questions:/im;
const FABLE = /fable/i;

/** @returns {{check: string, expected: string, observed: string, pass: boolean}} one result line */
export const checkLine = (check, expected, observed, pass) => ({ check, expected: String(expected), observed: String(observed), pass: pass === true });

const bashCommands = (lines) => toolCalls(lines).filter((call) => call.name === 'Bash').map((call) => ({ ...call, command: String(call.input.command ?? '') }));

/**
 * Background shells an agent started and neither stopped (TaskStop) nor saw end (a task-notification) before its report.
 * @param {object[]} lines one agent's transcript
 * @returns {string[]} the ids of the shells left running
 */
export function backgroundShellsLeft(lines) {
  const reportMs = finalText(lines)?.atMs ?? Infinity;
  const before = (atMs) => atMs === null || atMs <= reportMs;
  const calls = toolCalls(lines);
  const started = calls.filter((call) => call.name === 'Bash' && call.input.run_in_background === true && call.result && !call.result.isError)
    .map((call) => String(call.result.meta.backgroundTaskId ?? BACKGROUND_ID.exec(call.result.text)?.[1] ?? call.id));
  const ended = new Set(calls.filter((call) => STOP_TOOLS.has(call.name) && before(call.atMs))
    .map((call) => String(call.input.task_id ?? call.input.shell_id ?? call.input.bash_id ?? '')));
  for (const { text, atMs } of userTexts(lines)) {
    if (!before(atMs)) continue;
    for (const notice of text.match(NOTICE) ?? []) {
      if (NOTICE_DONE.test(notice)) for (const [, id] of notice.matchAll(NOTICE_ID)) ended.add(id.trim());
    }
  }
  return started.filter((id) => !ended.has(id));
}

/**
 * @param {object[]} lines one agent's transcript
 * @param {number} minSeconds the shortest sleep that counts
 * @returns {string[]} the Bash commands with a `sleep` of at least minSeconds
 */
export function longSleeps(lines, minSeconds = LIMITS.longSleepSeconds) {
  return bashCommands(lines).filter(({ command }) => [...command.matchAll(SLEEP)]
    .some(([, amount, unit]) => Number(amount) * UNIT_S[unit] >= minSeconds)).map(({ command }) => command);
}

/** @returns {string[]} the Bash commands that run a test runner (node --test, npm test, vitest, jest) */
export const testRunnerCommands = (lines) => bashCommands(lines).filter(({ command }) => TEST_RUNNER.test(command)).map(({ command }) => command);

/**
 * Every model name of a session that is a Fable model: the models of the boss and every subagent turn, the models the Agent
 * calls asked for and the ones Claude Code resolved, and the stream result's modelUsage.
 * @param {{lines: object[], agents: {lines: object[]}[]}} session
 * @param {object | null} result the stream's result event
 * @returns {string[]} the Fable names found (empty when none)
 */
export function fableModels(session, result = null) {
  const names = [];
  for (const lines of [session.lines, ...session.agents.map((agent) => agent.lines)]) {
    for (const line of lines) if (line.type === 'assistant' && typeof line.message?.model === 'string') names.push(line.message.model);
    for (const call of toolCalls(lines)) {
      if (call.name !== 'Agent' && call.name !== 'Task') continue;
      // only a start that ran counts: a denied `model: "fable"` is a refused start, not a Fable run
      if (call.result?.isError !== true && typeof call.input.model === 'string') names.push(call.input.model);
      if (typeof call.result?.meta?.resolvedModel === 'string') names.push(call.result.meta.resolvedModel);
    }
  }
  names.push(...Object.keys(result?.modelUsage ?? {}));
  return [...new Set(names.filter((name) => FABLE.test(name)))];
}

/** @returns {number} the words of a report before its `questions:` block */
export function reportWords(text) {
  const body = String(text ?? '');
  const at = body.search(QUESTIONS);
  return (at === -1 ? body : body.slice(0, at)).split(/\s+/).filter(Boolean).length;
}

const isInside = (path, dir) => typeof path === 'string' && (path === dir || path.startsWith(dir.endsWith('/') ? dir : `${dir}/`));

/**
 * @param {object[]} lines the boss's transcript
 * @param {string[]} repoDirs the scratch repo and its worktrees (real paths)
 * @returns {string[]} the boss's file-tool calls on repo files, as `<tool> <path>`
 */
export function bossFileCalls(lines, repoDirs) {
  return toolCalls(lines).filter((call) => FILE_TOOLS.has(call.name)).flatMap((call) => {
    const path = call.input.file_path ?? call.input.notebook_path ?? call.input.path;
    if (path === undefined && SEARCH_TOOLS.has(call.name)) return [`${call.name} (working folder)`];
    return repoDirs.some((dir) => isInside(path, dir)) ? [`${call.name} ${path}`] : [];
  });
}

/** @returns {{type: string, prompt: string, model: string | null, agentId: string | null, denied: boolean, denyText: string,
 * atMs: number | null}[]} the Agent calls of one transcript */
export const startsOf = (lines) => agentStarts(toolCalls(lines));

/**
 * When each background task or agent ended with `completed`, by its task-notification (E2: a later start must follow these).
 * @param {object[]} lines one transcript
 * @returns {Map<string, number | null>} task id -> the time of its first completed notice
 */
export function completedAt(lines) {
  const ends = new Map();
  for (const { text, atMs } of userTexts(lines)) {
    for (const notice of text.match(NOTICE) ?? []) {
      if (NOTICE_DONE.exec(notice)?.[1] !== 'completed') continue;
      for (const [, id] of notice.matchAll(NOTICE_ID)) if (!ends.has(id.trim())) ends.set(id.trim(), atMs);
    }
  }
  return ends;
}

/** @returns {{id: string, type: string, lines: object[]}[]} the boss (type `boss`) and every subagent of a session */
export const everyAgent = (session) => [{ id: session.id, type: 'boss', lines: session.lines }, ...session.agents];

/**
 * Each `needs: <agent> to ...` line of a main agent's report that the boss did not follow with a start of that agent.
 * @param {{lines: object[], agents: {type: string, lines: object[]}[]}} session
 * @returns {string[]} `<reporter>: needs <agent>` for each unmet line
 */
export function unmetNeeds(session) {
  const bossStarts = startsOf(session.lines).filter((start) => !start.denied);
  const unmet = [];
  for (const agent of session.agents.filter((one) => MAIN_TYPES.has(one.type))) {
    for (const { text, atMs } of assistantTexts(agent.lines)) {
      for (const [, wanted] of text.matchAll(NEEDS)) {
        const followed = bossStarts.some((start) => start.type === wanted && (atMs === null || start.atMs === null || start.atMs >= atMs));
        if (!followed) unmet.push(`${agent.type}: needs ${wanted}`);
      }
    }
  }
  return unmet;
}
