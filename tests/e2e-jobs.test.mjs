// Tests of how a scenario's claude job runs and when it is done (tests/e2e/lib/jobs.mjs and context.mjs claudeJob, review round
// 2, R8): E0(a)'s answer mode, jobDone on fixture transcripts (a background agent needs a completed notice), claudeJob's one
// run in the direct mode and its `--resume` rounds otherwise, the FAIL line of a job left not done, and E2, E3, E5 and E6
// running every claude through claudeJob.
// Safety: no `claude` runs: ctx.claude is replaced by a stub that writes fixture transcripts into a temp projects folder.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentCall, call, notice, result, say, writeSession } from './e2e-fixtures.mjs';
import { commonLines } from './e2e/lib/common.mjs';
import { makeContext, makeRunState } from './e2e/lib/context.mjs';
import { homePaths } from './e2e/lib/home.mjs';
import { answerModeOf, jobDone, jobLine } from './e2e/lib/jobs.mjs';
import * as E2 from './e2e/scenarios/E2.mjs';
import * as E3 from './e2e/scenarios/E3.mjs';
import * as E5 from './e2e/scenarios/E5.mjs';
import * as E6 from './e2e/scenarios/E6.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const SESSION_ID = 'job-session-1';
const CWD = '/made-up/E2/repo';
const AGENT_ID = 'b7c8d9e0f1';
const GOOD_RESULT = Object.freeze({ is_error: false, result: 'done' });
const backgroundLex = (agentId = AGENT_ID) => agentCall('1', { subagent_type: 'lex', prompt: 'Reply only ok.', run_in_background: true }, { agentId });

/** A temp projects folder holding one boss session made of these lines. */
function projectsWith(lines) {
  const projects = join(makeTempDir('harness-jobs-'), 'projects');
  writeSession(projects, CWD, { sessionId: SESSION_ID, lines });
  return projects;
}

const doneWith = (lines, session = { sessionId: SESSION_ID, result: GOOD_RESULT }) => jobDone(projectsWith(lines), session);

test('answerModeOf: direct only when E0(a) was done in one run; rounds, not done or not run give resume', () => {
  assert.equal(answerModeOf({ done: true, rounds: 0 }), 'direct');
  assert.equal(answerModeOf({ done: true, rounds: 2 }), 'resume');
  assert.equal(answerModeOf({ done: false, rounds: 0 }), 'resume');
  assert.equal(answerModeOf(undefined), 'resume');
});

test('jobDone: a background agent needs its completed notice; an error result or no session is never done', () => {
  assert.equal(doneWith([...backgroundLex(), say('started')]), false, 'the agent still runs');
  assert.equal(doneWith([...backgroundLex(), notice(AGENT_ID, 'completed', 5), say('it said ok', 6)]), true);
  assert.equal(doneWith([...backgroundLex(), notice(AGENT_ID, 'failed', 5)]), false, 'failed is not completed');
  assert.equal(doneWith([...backgroundLex(), notice(AGENT_ID, 'completed', 5)], { sessionId: SESSION_ID, result: { is_error: true } }), false);
  assert.equal(doneWith([...backgroundLex(), notice(AGENT_ID, 'completed', 5)], { sessionId: SESSION_ID, result: null }), false);
  assert.equal(doneWith([], { sessionId: null, result: GOOD_RESULT }), false, 'no session id: nothing to read');
  const foreground = agentCall('2', { subagent_type: 'lex', prompt: 'Reply only ok.' });
  assert.equal(doneWith([...foreground, say('ok')]), true, 'a foreground agent returned its result inline');
  const launched = [call('3', 'Agent', { subagent_type: 'tess', prompt: 'check' }), result('3', 'launched', { meta: { status: 'async_launched', agentId: AGENT_ID } })];
  assert.equal(doneWith(launched), false, 'an agent started in the background by its own definition counts too');
  assert.equal(doneWith([...launched, notice(AGENT_ID, 'completed', 5)]), true);
  const noId = [call('4', 'Agent', { subagent_type: 'lex', prompt: 'x', run_in_background: true }), result('4', 'started', { meta: {} })];
  assert.equal(doneWith([...noId, notice(AGENT_ID, 'completed', 5)]), false, 'a start without an agent id never counts as ended');
});

/**
 * A live (not dry) context whose ctx.claude is a stub: each call writes the boss transcript as it stands after that run (the
 * first run starts a background lex, a `--resume` run gets its completed notice) and returns a good result.
 */
function stubbedContext(answerMode) {
  const root = makeTempDir('harness-jobs-run-');
  const paths = homePaths(root, '/made-up/real-home');
  const run = makeRunState({ dry: false, root, setupFrom: '/made-up/setup', realHome: '/made-up/real-home', realHomeMode: false, paths, answerMode });
  const ctx = makeContext(run, { id: 'E2' });
  const calls = [];
  ctx.claude = async (spec) => {
    calls.push(spec);
    const lines = [...backgroundLex(), say('started'), ...(spec.resume ? [notice(AGENT_ID, 'completed', 5), say('it said ok', 6)] : [])];
    writeSession(paths.projectsDir, CWD, { sessionId: SESSION_ID, lines });
    const session = { name: spec.name, sessionId: SESSION_ID, result: GOOD_RESULT, exit: { code: 0 }, init: null, stderrTail: '' };
    ctx.sessions.push(session);
    return session;
  };
  return { ctx, calls };
}

test('claudeJob resume mode: --resume rounds until the background agent completed; the job line passes', async () => {
  const { ctx, calls } = stubbedContext('resume');
  const job = await ctx.claudeJob({ name: 'cap-lex', prompt: 'start a lex', model: 'sonnet' });
  assert.equal(job.done, true);
  assert.equal(job.rounds, 1);
  assert.deepEqual(calls.map((spec) => spec.resume ?? null), [null, SESSION_ID]);
  assert.equal(calls[1].prompt, 'continue');
  assert.deepEqual(ctx.jobs, [{ name: 'cap-lex', answer: 'resume', mode: '1 resume round(s)', done: true }]);
  assert.equal(jobLine(ctx.jobs).pass, true);
});

test('claudeJob direct mode: one run only; a job left not done is a FAIL line of commonLines that names the mode', async () => {
  const { ctx, calls } = stubbedContext('direct');
  const job = await ctx.claudeJob({ name: 'cap-lex', prompt: 'start a lex', model: 'sonnet' });
  assert.equal(calls.length, 1, 'no --resume in the direct mode');
  assert.equal(job.done, false);
  const line = commonLines(ctx, 40).find((one) => one.check.startsWith('each claude job ended'));
  assert.equal(line.pass, false);
  assert.equal(line.expected, 'done (E0 answer mode: direct)');
  assert.equal(line.observed, 'not done: cap-lex (one run)');
  assert.equal(jobLine([]), null, 'a scenario without a job gets no line');
});

test('claudeJob before E0 ran: the resume rounds, and the job line says E0 did not run', async () => {
  const { ctx } = stubbedContext(undefined);
  await ctx.claudeJob({ name: 'cap-lex', prompt: 'start a lex', model: 'sonnet' });
  assert.equal(ctx.jobs[0].answer, 'resume (E0 not run)');
  assert.equal(ctx.jobs[0].done, true);
});

/** A context stub for a scenario's run(): git answers exit 0, ctx.claude must not be used, claudeJob records the names. */
function runStub() {
  const dir = makeTempDir('harness-jobs-scenario-');
  const names = [];
  const ctx = {
    dry: false, dir, repo: join(dir, 'repo'), origin: join(dir, 'origin.git'), notes: {},
    git: () => ({ code: 0, stdout: '', stderr: '' }), dialog: () => {}, dialogCount: () => 0,
    claude: async (spec) => { throw new Error(`ctx.claude used directly by ${spec.name}`); },
    claudeJob: async (spec) => { names.push(spec.name); return { session: { name: spec.name }, done: true }; },
  };
  return { ctx, names };
}

test('E2, E3, E5 and E6 run every claude through claudeJob', async () => {
  for (const [scenario, count] of [[E2, 2], [E3, 2], [E5, 3], [E6, 3]]) {
    const { ctx, names } = runStub();
    await scenario.run(ctx);
    assert.equal(names.length, count, `${scenario.id}: ${names.join(', ')}`);
  }
});
