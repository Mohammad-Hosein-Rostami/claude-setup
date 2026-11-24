// Tests for the resume cap of home/hooks/agent-model-guard.mjs on PreToolUse(SendMessage) (agent-budget.mjs resumeCapReason): a
// message that would resume a stopped lex, dev or tess is denied every time while 3 of its type run; a message to a running agent, to
// `main`, or to a name the record holds no type for passes, and no other gate runs. The cap fails open (a message starts no new agent):
// a record that cannot be read or stays locked, a crash and a lib that fails to load let the message go, while an Agent launch in the
// same state is still denied. Each test has a private HOME (the record, lib/main-agents-store.mjs) and its own session id; the hook
// runs as a process (a broken temp copy of home/hooks for the crash and load-failure tests).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hookEnv } from './hook-env.mjs';
import { agentHomeEnv } from './agent-home-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

process.env.TMPDIR = makeTempDir('resume-cap-tmp-'); // the call counters (lib/writer-agents.mjs callCounterPath) go under it

const HOOKS = fileURLToPath(new URL('../home/hooks', import.meta.url));
const GUARD = join(HOOKS, 'agent-model-guard.mjs');
const HOOK_TIMEOUT_MS = 5000;
const MINUTE_MS = 60 * 1000;
const RUNNING_DEV = ['agent-dev-1', 'agent-dev-2', 'agent-dev-3'];
const STOPPED_DEV = 'agent-dev-0';
const STOPPED_LEX = 'agent-lex-0';
const LONG_NAME_CHARS = 500;
const REAL_BUDGET = 'agent-budget-real.mjs';
const CRASH_MESSAGE = 'resume cap exploded';
const SKIPPED_NOTE = 'agent-model-guard: resume cap skipped: ';
const CRASH_DENY_START = 'agent-model-guard failed (';
let counter = 0;

function newSession() {
  const home = makeTempDir('resume-cap-home-');
  return { home, session: `resume-${process.pid}-${counter++}` };
}
const dirOf = (s) => join(s.home, '.claude', 'state', 'main-agents');
const storeOf = (s) => join(dirOf(s), `${s.session}.json`);
const writeStore = (s, text) => {
  mkdirSync(dirOf(s), { recursive: true, mode: 0o700 });
  writeFileSync(storeOf(s), text, { mode: 0o600 });
};
/** A record with `devs` dev agents started a minute ago (so they run), a stopped dev and a stopped lex. */
function seedRecord(s, { devs = RUNNING_DEV, stoppedTypes = { [STOPPED_DEV]: 'dev', [STOPPED_LEX]: 'lex' } } = {}) {
  const at = Date.now() - MINUTE_MS;
  const launches = devs.map((agent, n) => ({ key: `k${n}`, type: 'dev', at, agent }));
  const record = { launches, stopped: [STOPPED_DEV, STOPPED_LEX], ...(stoppedTypes === null ? {} : { stoppedTypes }) };
  writeStore(s, JSON.stringify(record));
}

/** Runs `hook` once on `inputText` (stdin) in the session's HOME; returns the finished run (exit 0 asserted). */
function runHook(s, inputText, hook = GUARD) {
  const env = hookEnv({ HOME: s.home, USERPROFILE: s.home, CLAUDE_PROJECT_DIR: s.home, ...agentHomeEnv(s.home), TMPDIR: process.env.TMPDIR });
  const run = spawnSync(process.execPath, [hook], { input: inputText, encoding: 'utf8', env, timeout: HOOK_TIMEOUT_MS });
  assert.equal(run.error, undefined, 'the hook finished within its timeout');
  assert.equal(run.status, 0, run.stderr);
  return run;
}
const decisionOf = (run) => (run.stdout === '' ? null : JSON.parse(run.stdout).hookSpecificOutput);
const sendInput = (s, to, extra = {}) => JSON.stringify({ hook_event_name: 'PreToolUse', session_id: s.session, cwd: s.home, tool_name: 'SendMessage', tool_input: { to, message: 'go on' }, ...extra });

/** Sends one SendMessage through the hook; null when it printed nothing (the message goes). */
const send = (s, to, extra = {}) => decisionOf(runHook(s, sendInput(s, to, extra)));

// isolation "worktree" keeps the writer isolation gate out; dev comes from the boss (no agent_id), so the main-agent cap applies
const launchInput = (s) => JSON.stringify({ hook_event_name: 'PreToolUse', session_id: s.session, cwd: s.home, tool_name: 'Agent',
  tool_input: { subagent_type: 'dev', description: 'job', prompt: 'build it', isolation: 'worktree' } });
/** Launches one dev from the boss through the hook; null when it printed nothing. */
const launchDev = (s, hook = GUARD) => decisionOf(runHook(s, launchInput(s), hook));

/** A copy of home/hooks changed by `change(hooksDir)`; returns the copy's agent-model-guard.mjs (it runs only by its own path). */
function brokenHooks(change) {
  const hooks = join(makeTempDir('resume-cap-hooks-'), 'hooks');
  cpSync(HOOKS, hooks, { recursive: true });
  change(hooks);
  return join(hooks, 'agent-model-guard.mjs');
}
/** A copy whose resumeCapReason throws CRASH_MESSAGE; every other export of agent-budget.mjs is the real one. */
const crashingResumeCap = () => brokenHooks((hooks) => {
  renameSync(join(hooks, 'agent-budget.mjs'), join(hooks, REAL_BUDGET));
  writeFileSync(join(hooks, 'agent-budget.mjs'), [
    `export * from './${REAL_BUDGET}';`, // a local export below wins over the star export of the same name
    `export function resumeCapReason() { throw new Error(${JSON.stringify(CRASH_MESSAGE)}); }`,
    '',
  ].join('\n'));
});
/** A copy whose lib/agent-route.mjs has a syntax error, so lib/agent-model-gates.mjs fails to load (a half-synced home/). */
const unloadableGates = () => brokenHooks((hooks) => writeFileSync(join(hooks, 'lib', 'agent-route.mjs'), 'export function mainRouteReason( {\n'));
/** Holds the session's lock as a live process (this test runner) with a fresh lock file, so every turn of the hook waits it out. */
const holdLock = (s) => writeFileSync(join(dirOf(s), `${s.session}.lock`), `${process.pid} ${'a'.repeat(32)}`, { flag: 'wx', mode: 0o600 });

const resumeCapReason = (s, target) => `agent cap: 3 dev agents of this session run (${RUNNING_DEV.join(', ')}); this message would resume `
  + `${target} as one more; wait for one of them to return, then send it again (store: ${storeOf(s)})`;
const launchUnusableReason = (s) => `agent cap: the main-agent record ${storeOf(s)} cannot be read or stays locked; fix or delete it, then launch again`;
const deny = (reason) => ({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason });

test('a message to a stopped dev while 3 dev run is denied every time, naming the cap, the type and the id', () => {
  const s = newSession();
  seedRecord(s);
  for (const attempt of [1, 2]) assert.deepEqual(send(s, STOPPED_DEV), deny(resumeCapReason(s, STOPPED_DEV)), `send ${attempt}`);
  assert.deepEqual(send(s, `${STOPPED_DEV} [ref]`), deny(resumeCapReason(s, STOPPED_DEV)), 'the name with its ref');
});

test('a message to a stopped dev while 2 dev run passes', () => {
  const s = newSession();
  seedRecord(s, { devs: RUNNING_DEV.slice(0, 2) });
  assert.equal(send(s, STOPPED_DEV), null);
});

test('a message to a running dev while 3 dev run passes (no resume)', () => {
  const s = newSession();
  seedRecord(s);
  assert.equal(send(s, RUNNING_DEV[0]), null);
});

test('main, *, a name the record does not know, empty, non-string and over-long targets pass and leave the store as it is', () => {
  const s = newSession();
  seedRecord(s);
  const before = readFileSync(storeOf(s), 'utf8');
  const mtimeBefore = statSync(storeOf(s)).mtimeMs;
  for (const to of ['main', '*', 'researcher', '', 42, null, { name: STOPPED_DEV }, 'a'.repeat(LONG_NAME_CHARS)]) {
    assert.equal(send(s, to), null, JSON.stringify(to));
  }
  assert.equal(readFileSync(storeOf(s), 'utf8'), before);
  assert.equal(statSync(storeOf(s)).mtimeMs, mtimeBefore);
});

test('a corrupt record does not deny a message to main, *, empty or a non-string target', () => {
  const s = newSession();
  writeStore(s, 'not json');
  for (const to of ['main', '*', '', 42, null, { name: STOPPED_DEV }]) assert.equal(send(s, to), null, JSON.stringify(to));
  assert.equal(readFileSync(storeOf(s), 'utf8'), 'not json', 'the file is left as it is');
});

test('a stopped lex while 3 dev run passes: each type has its own cap', () => {
  const s = newSession();
  seedRecord(s);
  assert.equal(send(s, STOPPED_LEX), null);
});

test('a stopped id with no recorded type (an old record with no stoppedTypes) passes', () => {
  const s = newSession();
  seedRecord(s, { stoppedTypes: null });
  assert.equal(send(s, STOPPED_DEV), null);
});

test('a corrupt record lets a message to a stopped-looking name go (fail open), while a dev launch on it is still denied naming the store', () => {
  const s = newSession();
  writeStore(s, 'not json');
  assert.equal(send(s, STOPPED_DEV), null, 'the message goes: it starts no new agent');
  assert.equal(readFileSync(storeOf(s), 'utf8'), 'not json', 'the file is left as it is');
  assert.deepEqual(launchDev(s), deny(launchUnusableReason(s)), 'a launch on the same record fails closed');
});

test('an empty or array record, or a lock that stays taken, lets a message to a stopped dev go; a dev launch is denied in each', () => {
  const states = { empty: (s) => writeStore(s, ''), array: (s) => writeStore(s, '[]'), locked: (s) => { seedRecord(s); holdLock(s); } };
  for (const [name, arrange] of Object.entries(states)) {
    const messaged = newSession();
    arrange(messaged);
    assert.equal(send(messaged, STOPPED_DEV), null, `${name}: the message goes`);
    const launched = newSession();
    arrange(launched);
    assert.deepEqual(launchDev(launched), deny(launchUnusableReason(launched)), `${name}: the launch is denied`);
  }
});

test('a crash of the resume cap lets the message go and names the error on stderr', () => {
  const s = newSession();
  seedRecord(s);
  const run = runHook(s, sendInput(s, STOPPED_DEV), crashingResumeCap());
  assert.equal(run.stdout, '', 'no deny: the message goes');
  assert.equal(run.stderr, `${SKIPPED_NOTE}${CRASH_MESSAGE}\n`);
});

test('a lib that fails to load lets a SendMessage go (to main or a stopped dev) but still denies an Agent launch and unreadable input', () => {
  const hook = unloadableGates();
  const s = newSession();
  seedRecord(s);
  for (const to of ['main', STOPPED_DEV]) {
    const run = runHook(s, sendInput(s, to), hook);
    assert.equal(run.stdout, '', `${to}: no deny output`);
    assert.ok(run.stderr.startsWith(SKIPPED_NOTE), `${to}: ${run.stderr}`);
  }
  for (const [name, decision] of [['Agent launch', launchDev(s, hook)], ['not JSON', decisionOf(runHook(s, 'not json', hook))]]) {
    assert.equal(decision?.permissionDecision, 'deny', `${name}: ${JSON.stringify(decision)}`);
    assert.ok(decision.permissionDecisionReason.startsWith(CRASH_DENY_START), `${name}: ${decision.permissionDecisionReason}`);
  }
});

test('a missing record lets a message to any agent name pass', () => {
  const s = newSession();
  assert.equal(send(s, STOPPED_DEV), null);
  assert.equal(existsSync(storeOf(s)), false, 'no record is made for a message');
});

test('a SendMessage from inside a subagent (agent_id) to main passes', () => {
  const s = newSession();
  seedRecord(s);
  assert.equal(send(s, 'main', { agent_id: RUNNING_DEV[0], agent_type: 'dev' }), null);
});
