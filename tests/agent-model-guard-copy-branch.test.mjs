// Tests for the copy-branch brief gate wired into home/hooks/agent-model-guard.mjs (round 4, lane W1) and the rule that no hook redirects a plain
// Agent call (the lead picks inline or an agent by the job). The private HOME holds a skill on purpose: a removed backstop advised exactly when
// skills were installed. Each test has a private HOME.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyBranchBriefDeny } from '../home/hooks/agent-model-guard.mjs';
import { git, makeRepo } from './git-tidy-helpers.mjs';
import { hookEnv } from './hook-env.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const SEND_AGAIN = 'Send the same call again unchanged and it runs.';
const GUARD = fileURLToPath(new URL('../home/hooks/agent-model-guard.mjs', import.meta.url));
const SKILLS = ['quick'];
let counter = 0;
const GIT_TIMEOUT_FOR_TESTS_MS = 60_000; // the suite runs beside other work; the hook's 1 s default would silently skip the advice

/** A private HOME holding the named skills; send(toolInput, extra) runs the hook once and returns the parsed hookSpecificOutput or null. */
function session({ skills = SKILLS, envExtra = {}, settings } = {}) {
  const home = makeTempDir('copy-brief-home-');
  const project = makeTempDir('copy-brief-project-');
  for (const name of skills) {
    mkdirSync(join(home, '.claude', 'skills', name), { recursive: true });
    writeFileSync(join(home, '.claude', 'skills', name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
  }
  if (settings !== undefined) writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(settings));
  const env = hookEnv({ HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: project, ...envExtra });
  const sessionId = `copy-brief-${process.pid}-${counter++}`;
  const log = () => readFileSync(env.CLAUDE_GUARD_LOG, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const send = (toolInput, extra = {}) => {
    const input = { hook_event_name: 'PreToolUse', session_id: sessionId, cwd: project, tool_name: 'Agent', tool_input: toolInput, ...extra };
    const { status, stdout, stderr } = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(input), encoding: 'utf8', env });
    assert.equal(status, 0, stderr);
    return stdout === '' ? null : JSON.parse(stdout).hookSpecificOutput;
  };
  return { home, project, send, log, logPath: env.CLAUDE_GUARD_LOG };
}
const denied = (out) => out?.permissionDecision === 'deny';
// isolation: "worktree" keeps the writer isolation gate (another gate of the same hook) out of these tests
const call = (type, prompt = 'do the job', extra = {}) => ({ description: 'job', prompt, subagent_type: type, model: 'sonnet', isolation: 'worktree', ...extra });

test('a plain lead Agent call is never redirected: every agent type runs at once (routing is by the job, not by a hook)', () => {
  const types = ['implementer', 'ui-implementer', 'test-writer', 'reviewer', 'security-auditor', 'deep-debugger', 'scout', 'Explore', 'architect', 'runner', 'general-purpose'];
  const brief = 'do the job\nMATRIX: none: not a screen, a hook test'; // the MATRIX line keeps the UI gate quiet
  // one session per call: the agent cap (5 running at once per session) is not what this test is about
  for (const type of types) assert.equal(denied(session().send(call(type, brief))), false, type);
  assert.equal(denied(session().send(call('general-purpose', 'research the best queue for this'))), false, 'a research question too');
});

const TEST_TIME_KNOBS = { COPY_BRANCH_GIT_TIMEOUT_MS: String(GIT_TIMEOUT_FOR_TESTS_MS), COPY_BRANCH_DEADLINE_MS: String(GIT_TIMEOUT_FOR_TESTS_MS) };

/** Runs `run` (sync or async) with TEST_TIME_KNOBS in process.env, where an in-process gate reads them, then puts the old values back. */
async function withTestTimeKnobs(run) {
  const saved = Object.fromEntries(Object.keys(TEST_TIME_KNOBS).map((name) => [name, process.env[name]]));
  Object.assign(process.env, TEST_TIME_KNOBS);
  try {
    return await run();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// The copy-branch gate through the hook: a real temp repo holds the lane branch; the agent's cwd is that repo.
function repoSession({ envExtra, ...options } = {}) {
  const s = session({ ...options, envExtra: { ...TEST_TIME_KNOBS, ...envExtra } });
  const repo = makeRepo();
  git(repo, 'branch', 'lane/x');
  return { ...s, repo, sendIn: s.send, send: (toolInput, extra = {}) => s.send(toolInput, { cwd: repo, ...extra }) };
}

test('a writer brief that creates a copy of an existing lane branch is denied once with the same-branch steps; the resend runs', () => {
  const s = repoSession();
  const brief = call('implementer', 'Fix the findings.\ngit checkout -b lane/x-2\nthen test');
  const first = s.send(brief);
  assert.ok(denied(first));
  assert.match(first.permissionDecisionReason, /continues the same branch/);
  assert.equal(denied(s.send(brief)), false, 'the identical call runs');
  assert.equal(denied(s.send(call('implementer', 'git checkout -b lane/x'))), false, 'the lane itself');
  assert.equal(denied(s.send(call('reviewer', 'git checkout -b lane/x-2'))), false, 'a read-only agent');
  assert.ok(s.log().some((row) => row.class === 'copy branch brief' && row.outcome === 'advice'));
});

// Round 6 review (L1): the deleted backstop test was the only one that checked gate order and the separate digest of each gate.
const COPY_BRIEF = 'Fix the findings.\ngit checkout -b lane/x-2\nthen test';
const OTHER_COPY_BRIEF = 'Fix the findings.\ngit switch -c lane/x-fix\nthen test';
const UI_ADVICE = /coverage matrix/;

test('every different copy brief is denied once: the digest holds the prompt, the type and the folder, so a second brief, type or folder is judged fresh', () => {
  const s = repoSession();
  assert.ok(denied(s.send(call('implementer', COPY_BRIEF))));
  assert.ok(denied(s.send(call('implementer', OTHER_COPY_BRIEF))), 'a second, different brief of the same type and folder');
  assert.equal(denied(s.send(call('implementer', OTHER_COPY_BRIEF))), false, 'and its identical resend runs');
  assert.ok(denied(s.send(call('ui-implementer', COPY_BRIEF))), 'the same brief from another agent type');
  const otherRepo = makeRepo();
  git(otherRepo, 'branch', 'lane/x');
  assert.ok(denied(s.sendIn(call('implementer', COPY_BRIEF), { cwd: otherRepo })), 'the same brief in another folder');
  const rows = s.log().filter((row) => row.class === 'copy branch brief' && row.outcome === 'advice');
  assert.deepEqual(rows.map((row) => row.type), ['implementer', 'implementer', 'ui-implementer', 'implementer'], 'one row per deny, each with its agent type');
  assert.equal(new Set(rows.map((row) => row.digest)).size, 4, 'four different digests');
});

test('the deny text starts with "Not started:", gives the same-branch steps and tells the agent to send the call again', () => {
  const reason = repoSession().send(call('implementer', COPY_BRIEF)).permissionDecisionReason;
  assert.ok(reason.startsWith('Not started: A re-done lane continues the same branch'), reason);
  assert.ok(reason.endsWith(`\n${SEND_AGAIN}`), reason);
});

test('the log row of a copy deny holds fixed fields and the digest, never the prompt; a call from inside an agent (agent_id) is advised too', () => {
  const s = repoSession();
  assert.ok(denied(s.send(call('implementer', `${COPY_BRIEF}\nsecret-marker-text`), { agent_id: 'agent-1' })));
  const text = readFileSync(s.logPath, 'utf8');
  assert.ok(!text.includes('secret-marker-text') && !text.includes('lane/x-2'), 'no prompt text in the log');
  assert.match(text, /"digest":"[0-9a-f]{64}"/);
});

test('the copy gate comes before the UI gate: a ui-implementer copy brief with no MATRIX is denied twice (copy, then UI) and only then runs', () => {
  const s = repoSession();
  const brief = call('ui-implementer', COPY_BRIEF);
  assert.match(s.send(brief).permissionDecisionReason, /continues the same branch/);
  assert.match(s.send(brief).permissionDecisionReason, UI_ADVICE, 'the second send is the UI gate\'s own first deny');
  assert.equal(denied(s.send(brief)), false, 'the third send runs');
  assert.deepEqual(s.log().filter((row) => row.outcome === 'advice').map((row) => row.class), ['copy branch brief', 'no MATRIX line'], 'one record per gate');
});

test('a copy-denied writer is not recorded as running: the next writer of the session without isolation starts', () => {
  const s = repoSession();
  const writer = (prompt) => call('implementer', prompt, { isolation: undefined });
  assert.ok(denied(s.send(writer(COPY_BRIEF))), 'denied by the copy gate before the writer gate sees it');
  assert.equal(denied(s.send(writer('Plain job, no branch.'))), false, 'no phantom running writer');
});

test('a brief the UI gate denies is not recorded as a running writer either', () => {
  const s = repoSession();
  assert.match(s.send(call('ui-implementer', 'Build the form.', { isolation: undefined })).permissionDecisionReason, UI_ADVICE);
  assert.equal(denied(s.send(call('implementer', 'Plain job, no branch.', { isolation: undefined }))), false);
});

// In-process: the hook's own environment is the process environment there, so only a direct call can tell the env argument from process.env.
test('copyBranchBriefDeny records under the environment it is given, and a failure inside it lets the call run', async () => {
  const s = repoSession();
  const env = hookEnv({ HOME: s.home, USERPROFILE: s.home });
  const input = { session_id: 'in-process-session', cwd: s.repo, tool_input: call('implementer', COPY_BRIEF) };
  // The gate reads its time knobs from process.env, not from `env`: without them a git lookup past the 1 s default on a busy machine
  // let the call run, and JSON.parse('') failed with "Unexpected end of JSON input" (A-owed X4).
  const verdict = await withTestTimeKnobs(() => copyBranchBriefDeny(input, env));
  assert.ok(JSON.parse(verdict).hookSpecificOutput.permissionDecision === 'deny');
  assert.equal(readFileSync(env.CLAUDE_GUARD_LOG, 'utf8').trim().split('\n').length, 1, 'the row went to the log of the given env');
  let reads = 0;
  const failing = { get tool_input() { reads += 1; if (reads > 1) throw new Error('boom'); return call('implementer', OTHER_COPY_BRIEF); }, cwd: s.repo };
  assert.equal(await withTestTimeKnobs(() => copyBranchBriefDeny(failing, env)), '', 'an error after the verdict never rejects');
  assert.equal(reads, 2, 'the verdict was reached (a deny) before the second read threw, so the catch is what let the call run');
});
