// Tests of the done-check scope when two sessions work in one folder (road polish, step 5, lane lang-honest, part check-blame; P2, F4-F7).
// The PC run of 2026-11-23: session B's agent made and deleted `zz-probe.test.ts` by Bash in the shared folder, and session A's
// architect stop took it as its own and ran it. Covers: A's architect stop gets no Scope for that file and its hook run writes no ledger
// row; B's own stop owns it (and its hook run checks it); an unreadable call-window log keeps the file A's (fail closed: still checked);
// a test path that vanished after the scope was taken is never handed to the runner, while the tests importing a deleted module still run.
// The call-window logs are written by hand in the shapes of tests/call-windows-helpers.mjs (another, older session's closed Bash window
// claims the file; times are set around the file's real ctime, no sleeps). Not covered here: Windows drive paths and case (F8, the PC).
// Invariants: every folder is a fixture folder in a temp folder (`cs-test-` prefix) with its own HOME; the test process's HOME is pinned
//   to a temp folder too, so nothing under the real ~/.claude is read or written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentTranscript, edges, logPath, writeLog } from './call-windows-helpers.mjs';
import { makeDoneCheckRepo, nodeTestSource } from './done-check-fixture.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { saveBaseline } from '../home/hooks/lib/dirty-baseline.mjs';
import { planChecks } from '../home/tools/done-check/lib/detect.mjs';
import { ownChange, rangeChange } from '../home/tools/done-check/lib/scope.mjs';

const PINNED_HOME = makeTempDir('done-check-sessions-home-');
process.env.HOME = PINNED_HOME;
process.env.USERPROFILE = PINNED_HOME;

const HOOK = fileURLToPath(new URL('../home/hooks/done-check.mjs', import.meta.url));
const HOUR_MS = 60 * 60 * 1000;
const BASELINE_AGE_MS = 60_000; // the baselines are taken a minute before the probe file is made (no sleep: the record is moved)
const SESSION_A = 'sess-a'; // the idle session whose architect stops
const SESSION_B = 'sess-b'; // the older session whose cart agent makes the probe file
const ARCHITECT = 'arch-1';
const CART = 'cart-1';
const PROBE = 'tests/zz-probe.test.mjs';
const NODE_PACKAGE = { name: 'p', private: true, scripts: { test: 'node --test tests/*.test.mjs' } };
const BASE_FILES = { 'src/helper.mjs': 'export const helper = 1;\n', 'tests/helper.test.mjs': nodeTestSource({ imports: ['../src/helper.mjs'] }) };

/** Moves the stored baseline of (session, agent) back by BASELINE_AGE_MS, as if it was taken before the file was made. */
function ageBaseline(home, session, agent) {
  const file = join(home, '.claude', 'state', 'commit-gate', 'baseline', `${session}--${agent}.json`);
  const record = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...record, takenMs: record.takenMs - BASELINE_AGE_MS }));
}

/**
 * The two-session folder: both agents' baselines at the base commit, A's log (younger, one closed own call an hour ago), then B's cart
 * agent writes the probe file inside its own closed Bash window, in B's log (older, it watched the folder first).
 */
function twoSessions(t) {
  const repo = makeDoneCheckRepo({ packageJson: NODE_PACKAGE, files: BASE_FILES });
  t.after(repo.cleanup);
  const env = { ...repo.env, CLAUDE_PROJECT_DIR: repo.dir };
  for (const [session, agent] of [[SESSION_A, ARCHITECT], [SESSION_B, CART]]) {
    assert.equal(saveBaseline(env, session, agent, repo.dir, [], repo.head()), true);
    ageBaseline(repo.home, session, agent);
  }
  const now = Date.now();
  writeLog(repo.home, SESSION_A, [edges.folder(repo.dir, now - HOUR_MS), edges.open('a1', now - HOUR_MS + 1000, [], { agent: ARCHITECT }), edges.close('a1', now - HOUR_MS + 2000, [], { agent: ARCHITECT })]);
  const openAt = Date.now() - 5;
  repo.write(PROBE, nodeTestSource({ cases: [{ name: 'probe' }] }));
  const closeAt = Date.now() + 5;
  writeLog(repo.home, SESSION_B, [edges.folder(repo.dir, now - 2 * HOUR_MS), edges.open('b1', openAt, [], { agent: CART }), edges.close('b1', closeAt, [], { agent: CART })]);
  const stopOf = (session, agent, id) => ({ hook_event_name: 'SubagentStop', session_id: session, agent_id: agent, agent_type: 'implementer', agent_transcript_path: agentTranscript(repo.dir, 'brief', [id]), cwd: repo.dir, stop_hook_active: false });
  return { repo, env, stopA: stopOf(SESSION_A, ARCHITECT, 'a1'), stopB: stopOf(SESSION_B, CART, 'b1') };
}

/** Runs the real done-check hook on `input`; returns the parsed output line or null when it printed nothing. */
function hookRun(repo, env, input) {
  const result = repo.run(HOOK, [], { input: JSON.stringify(input), env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() === '' ? null : JSON.parse(result.stdout);
}

const ledgerRows = (repo) => {
  const file = join(repo.home, '.claude', 'state', 'done-check', 'ledger.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
};

test('F5: the file only the other, older session\'s window covers is not in A\'s architect scope; its hook run blames nobody', async (t) => {
  const { repo, env, stopA } = twoSessions(t);
  assert.deepEqual(await ownChange(stopA, env), [], 'F7: no own file left gives no Scope');
  assert.equal(hookRun(repo, env, stopA), null, 'no checks line for A');
  assert.deepEqual(ledgerRows(repo), [], 'no ledger row blaming A');
});

test('F5: B\'s own stop owns the file its own Bash window made, and its hook run checks it', async (t) => {
  const { repo, env, stopB } = twoSessions(t);
  const scopes = await ownChange(stopB, env);
  assert.equal(scopes.length, 1);
  assert.deepEqual(scopes[0].files, [PROBE]);
  const output = hookRun(repo, env, stopB);
  assert.match(output?.systemMessage ?? '', /^checks: .*tests ok/);
  assert.deepEqual(ledgerRows(repo).map((row) => [row.session, row.agent]), [[SESSION_B, CART]]);
});

test('F4: an unreadable call-window log of A keeps the file A\'s own (fail closed: the agent is still checked)', async (t) => {
  const { repo, env, stopA } = twoSessions(t);
  appendFileSync(logPath(repo.home, SESSION_A), '{"t":"open","id"\n'); // a torn line: the log reads as unusable
  const scopes = await ownChange(stopA, env);
  assert.equal(scopes.length, 1);
  assert.deepEqual(scopes[0].files, [PROBE]);
});

test('F4: an A transcript tool call with no open line in A\'s log keeps the file A\'s own (a call of A may have made it)', async (t) => {
  const { env, stopA } = twoSessions(t);
  const scopes = await ownChange({ ...stopA, agent_transcript_path: agentTranscript(stopA.cwd, 'brief', ['a1', 'a2-unlogged']) }, env);
  assert.deepEqual(scopes.map((scope) => scope.files), [[PROBE]]);
});

test('F6: a test path that vanished after the scope was taken is not handed to the runner; the importers of a deleted module still run', async (t) => {
  const { repo } = twoSessions(t);
  repo.remove('src/helper.mjs');
  const scope = { ...(await rangeChange(repo.dir, repo.baseSha)) };
  assert.ok(scope.files.includes(PROBE) && scope.files.includes('src/helper.mjs'), 'the scope lists both');
  repo.remove(PROBE); // the other agent deletes its probe between the scope and the plan
  const plan = planChecks(scope, repo.env);
  const argvs = plan.packages.flatMap((entry) => entry.cmds.map((cmd) => cmd.argv.join(' ')));
  assert.ok(argvs.every((argv) => !argv.includes('zz-probe')), argvs.join('\n'));
  assert.ok(argvs.some((argv) => argv.includes('helper.test.mjs')), `the importer of the deleted module runs: ${argvs.join('\n')}`);
  assert.equal(lstatSync(join(repo.dir, 'tests')).isDirectory(), true);
  assert.deepEqual(readdirSync(join(repo.dir, 'tests')).sort(), ['helper.test.mjs']);
});

test('R2: an agent\'s committed change stays in its scope after an older session\'s window edits the same file uncommitted', async (t) => {
  const { repo, env, stopA } = twoSessions(t);
  repo.remove(PROBE); // only the committed file is looked at here
  repo.write('src/helper.mjs', 'export const helper = 2; // A\n'); // A's own change, made by Bash, then committed
  repo.commit('A commits its change');
  const openAt = Date.now() - 5;
  repo.write('src/helper.mjs', 'export const helper = 3; // B\n'); // B's later uncommitted edit, inside B's closed window
  const closeAt = Date.now() + 5;
  writeLog(repo.home, SESSION_B, [edges.folder(repo.dir, Date.now() - 2 * HOUR_MS), edges.open('b2', openAt, [], { agent: CART }), edges.close('b2', closeAt, [], { agent: CART })]);
  const scopes = await ownChange(stopA, env);
  assert.deepEqual(scopes.map((scope) => scope.files), [['src/helper.mjs']]);
});
