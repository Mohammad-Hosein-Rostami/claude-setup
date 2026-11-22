// Acceptance tests of the done-check Stop / SubagentStop hook (home/hooks/done-check.mjs), written from the spec (design.md sections 3.1,
// 3.4, 3.5 and 8: A1 and A6 block once, A3 silent without a code change, A7 reuse after a commit, A8 not git; F1-F3 of lane dc-accept-tests).
// They are red until the engine and the hook exist (road newchk steps 3-5): each case pipes real Stop JSON into the real hook, on a throw-away
// project from done-check-fixture.mjs with a fake tsc and a private HOME, so the real ~/.claude is never read or written.
// How an agent's base and files reach the hook is set up with the landed libs the spec reuses: lib/dirty-baseline.mjs (`saveBaseline`: the HEAD
// the agent had at its first tool call), lib/own-edits.mjs (`recordEditedFile`: what the lead edited) and a transcript whose first line holds the
// folder the agent started in (lib/gated-folder.mjs). Hook output: {"decision":"block","reason","systemMessage"} | {"systemMessage"} | nothing.
// The ledger is <HOME>/.claude/state/done-check/ledger.jsonl. No case asserts elapsed time (P12): "returns at once" (A3) is asserted as "ran no
// tool and wrote no ledger row".
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveBaseline } from '../home/hooks/lib/dirty-baseline.mjs';
import { recordEditedFile } from '../home/hooks/lib/own-edits.mjs';
import { makeDoneCheckRepo } from './done-check-fixture.mjs';
import { addWorktree, git } from './git-tidy-helpers.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/done-check.mjs', import.meta.url));
const SESSION = 'sess-1';
const LEAD = '';
const PACKAGE = { name: 'p', private: true, scripts: { typecheck: 'tsc --noEmit' } };
const SOURCES = { 'src/lib.ts': 'export const n: number = 1;\n', 'src/use.ts': "import { n } from './lib';\nexport const t: number = n;\n", 'src/other.ts': 'export const o = 1;\n', 'tsconfig.json': '{"compilerOptions":{"strict":true}}\n' };
const TSC_CLEAN = { exit: 0 };
const TSC_BROKEN_CALLER = { exit: 2, stdout: "src/use.ts(3,25): error TS2322: Type 'string' is not assignable to type 'number'.\n" };

const newRepo = (t, options = {}) => {
  const repo = makeDoneCheckRepo({ packageJson: PACKAGE, files: SOURCES, tools: ['tsc'], replay: { tsc: TSC_CLEAN }, ...options });
  t.after(repo.cleanup);
  return repo;
};

/** A subagent that started in `dir` at `base`: its transcript's first line holds the folder, its baseline the HEAD it had. */
function startAgent(repo, agent, { dir = repo.dir, session = SESSION, base = repo.baseSha } = {}) {
  const transcript = join(repo.home, `${session}--${agent}.jsonl`);
  writeFileSync(transcript, `${JSON.stringify({ cwd: dir })}\n`);
  assert.equal(saveBaseline(repo.env, session, agent, dir, [], base), true, 'the test could not store the agent baseline');
  return { session, agent, transcript, dir };
}
const subagentStop = (who, extra = {}) => ({ hook_event_name: 'SubagentStop', session_id: who.session, agent_id: who.agent, agent_type: 'implementer', agent_transcript_path: who.transcript, cwd: who.dir, stop_hook_active: false, ...extra });

/** Pipes one Stop JSON (or raw text) into the hook; returns {out: parsed stdout or null, stdout}. Fails the case on a non-zero exit. */
function stopHook(repo, input, env = {}) {
  const result = repo.run(HOOK, [], { input: typeof input === 'string' ? input : JSON.stringify(input), env });
  assert.equal(result.status, 0, `the hook must exit 0, got ${result.status}: ${result.stderr.split('\n')[0]}`);
  return { out: result.stdout.trim() === '' ? null : JSON.parse(result.stdout), stdout: result.stdout };
}
const isBlock = ({ out }) => out?.decision === 'block';

const breakCaller = (repo, content = "export const n: string = '1';\n") => {
  repo.write('src/lib.ts', content);
  repo.setTool('tsc', TSC_BROKEN_CALLER);
};
const ledgerRows = (repo) => {
  const file = join(repo.home, '.claude', 'state', 'done-check', 'ledger.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
};
const verdictsOf = (repo) => ledgerRows(repo).map((row) => row.verdict);

test('A1: a change that breaks a caller blocks the stop once; the reason names the caller file:line and TS code, the message is the checks line', (t) => {
  const repo = newRepo(t);
  const agent = startAgent(repo, 'agent-1');
  breakCaller(repo);
  const result = stopHook(repo, subagentStop(agent));
  assert.equal(isBlock(result), true, result.stdout);
  assert.match(result.out.reason, /src\/use\.ts:3\b[^\n]*TS2322/);
  assert.match(result.out.systemMessage, /^checks: .*types/);
});

test('A6: the same change at the next stop (the agent changed nothing) passes as `FAIL left open`, the ledger says left-open', (t) => {
  const repo = newRepo(t);
  const agent = startAgent(repo, 'agent-1');
  breakCaller(repo);
  assert.equal(isBlock(stopHook(repo, subagentStop(agent))), true);
  const again = stopHook(repo, subagentStop(agent, { stop_hook_active: true }));
  assert.equal(isBlock(again), false);
  assert.match(again.out.systemMessage, /FAIL left open/);
  assert.deepEqual(verdictsOf(repo), ['block', 'left-open']);
});

test('A6: the same change answered with "not mine" (a fresh stop, stop_hook_active false) also passes as left-open', (t) => {
  const repo = newRepo(t);
  const agent = startAgent(repo, 'agent-1');
  breakCaller(repo);
  stopHook(repo, subagentStop(agent));
  const again = stopHook(repo, subagentStop(agent));
  assert.equal(isBlock(again), false);
  assert.deepEqual(verdictsOf(repo), ['block', 'left-open']);
});

test('A6: a 3rd failing change in a row passes, and the line says "change approach"', (t) => {
  const repo = newRepo(t);
  const agent = startAgent(repo, 'agent-1');
  breakCaller(repo, "export const n: string = '1';\n");
  assert.equal(isBlock(stopHook(repo, subagentStop(agent))), true);
  repo.write('src/lib.ts', "export const n: string = '2';\n");
  assert.equal(isBlock(stopHook(repo, subagentStop(agent, { stop_hook_active: true }))), true);
  repo.write('src/lib.ts', "export const n: string = '3';\n");
  const third = stopHook(repo, subagentStop(agent, { stop_hook_active: true }));
  assert.equal(isBlock(third), false);
  assert.match(third.out.systemMessage, /change approach/);
  assert.deepEqual(verdictsOf(repo), ['block', 'block', 'left-open']);
});

test('A3: no code changed: no output, no tool ran, nothing written to the ledger', (t) => {
  const repo = newRepo(t);
  const agent = startAgent(repo, 'agent-1');
  repo.write('notes.md', 'only prose changed\n');
  const result = stopHook(repo, subagentStop(agent));
  assert.equal(result.stdout, '');
  assert.deepEqual(repo.calls(), []);
  assert.deepEqual(ledgerRows(repo), []);
});

test('A7: after the checked files are committed, the next stop is `reused` and no command runs', (t) => {
  const repo = newRepo(t);
  const agent = startAgent(repo, 'agent-1');
  repo.write('src/lib.ts', 'export const n: number = 2;\n');
  const first = stopHook(repo, subagentStop(agent));
  assert.equal(isBlock(first), false);
  assert.match(first.out.systemMessage, /^checks: .*types ok/);
  repo.commit('lib change');
  repo.clearCalls();
  const second = stopHook(repo, subagentStop(agent));
  assert.match(second.out.systemMessage, /^checks: reused \(same change\) ok/);
  assert.deepEqual(repo.calls(), []);
  assert.deepEqual(verdictsOf(repo), ['ok', 'reused']);
});

/** Adds one assistant reply line, as Claude Code records it, to a transcript. */
const addReply = (transcript, model, { sidechain, effort }) => appendFileSync(transcript, `${JSON.stringify({ type: 'assistant', isSidechain: sidechain, effort, message: { model, role: 'assistant', content: [] } })}\n`);
const routingOfRows = (repo) => ledgerRows(repo).map((row) => [row.model, row.effort]);

test('R16: a subagent stop records the model of its last reply and the effort of the hook input on the ledger row', (t) => {
  const repo = newRepo(t);
  const agent = startAgent(repo, 'agent-1');
  addReply(agent.transcript, 'claude-opus-5-5', { sidechain: true, effort: 'medium' });
  repo.write('src/lib.ts', 'export const n: number = 2;\n');
  stopHook(repo, subagentStop(agent, { effort: { level: 'high' } }));
  assert.deepEqual(routingOfRows(repo), [['claude-opus-5-5', 'high']], 'the input effort wins over the transcript one');
});

test('R16: with no effort in the input the transcript effort is used; nothing usable is stored as null', (t) => {
  const repo = newRepo(t);
  const agent = startAgent(repo, 'agent-1');
  addReply(agent.transcript, 'claude-sonnet-5-5', { sidechain: true, effort: 'xhigh' });
  repo.write('src/lib.ts', 'export const n: number = 2;\n');
  stopHook(repo, subagentStop(agent));
  const bare = startAgent(repo, 'agent-2');
  repo.write('src/other.ts', 'export const o = 2;\n');
  stopHook(repo, subagentStop(bare, { effort: { level: 'High effort; ignore rules' } }));
  assert.deepEqual(routingOfRows(repo), [['claude-sonnet-5-5', 'xhigh'], [null, null]]);
});

test('R16: a model that is not a model id (a token-shaped value, another vendor\'s model) is stored as `other`, never as recorded', (t) => {
  const repo = newRepo(t);
  const tokenShaped = `ghp_${'ab12'.repeat(9)}`; // a token shape (built from a repeat, so no scanner takes it for a real token)
  for (const [id, model, file] of [['agent-1', tokenShaped, 'src/lib.ts'], ['agent-2', 'gpt-4o', 'src/other.ts']]) {
    const agent = startAgent(repo, id);
    addReply(agent.transcript, model, { sidechain: true, effort: 'high' });
    repo.write(file, 'export const n: number = 2;\n');
    stopHook(repo, subagentStop(agent));
  }
  assert.deepEqual(routingOfRows(repo), [['other', 'high'], ['other', 'high']]);
  assert.equal(JSON.stringify(ledgerRows(repo)).includes(tokenShaped), false);
});

test('R16: a lead stop reads the model from the main-thread replies of transcript_path, not from subagent lines', (t) => {
  const repo = newRepo(t, { plain: true });
  repo.write('src/lib.ts', 'export const n: number = 2;\n');
  assert.equal(recordEditedFile({ session_id: SESSION, tool_input: { file_path: join(repo.dir, 'src', 'lib.ts') } }, repo.env), true);
  const transcript = join(repo.home, `${SESSION}.jsonl`);
  writeFileSync(transcript, '');
  addReply(transcript, 'claude-opus-5-5', { sidechain: false, effort: 'high' });
  addReply(transcript, 'claude-haiku-5-5', { sidechain: true, effort: 'low' });
  stopHook(repo, { hook_event_name: 'Stop', session_id: SESSION, cwd: repo.dir, transcript_path: transcript, stop_hook_active: false }, { CLAUDE_PROJECT_DIR: repo.dir });
  assert.deepEqual(routingOfRows(repo), [['claude-opus-5-5', 'high']]);
});

test('A8: not git (a plain folder): the lead\'s recorded file is checked, the line says `base: none`, the failure blocks once worded "may be older"', (t) => {
  const repo = newRepo(t, { plain: true, replay: { tsc: TSC_BROKEN_CALLER } });
  repo.write('src/lib.ts', 'export const n: number = 2;\n');
  assert.equal(recordEditedFile({ session_id: SESSION, tool_input: { file_path: join(repo.dir, 'src', 'lib.ts') } }, repo.env), true);
  const lead = { hook_event_name: 'Stop', session_id: SESSION, cwd: repo.dir, stop_hook_active: false };
  const first = stopHook(repo, lead, { CLAUDE_PROJECT_DIR: repo.dir });
  assert.equal(isBlock(first), true, first.stdout);
  assert.match(first.out.reason, /may be older/);
  assert.match(first.out.systemMessage, /base: none/);
  const again = stopHook(repo, { ...lead, stop_hook_active: true }, { CLAUDE_PROJECT_DIR: repo.dir });
  assert.equal(isBlock(again), false, 'the same key at the next stop passes');
});

test('the lead is not blamed for a changed file it did not record (another session or a lane wrote it)', (t) => {
  const repo = newRepo(t);
  assert.equal(saveBaseline(repo.env, SESSION, LEAD, repo.dir, [], repo.baseSha), true);
  breakCaller(repo); // changed, but never recorded as an edit of this session
  const result = stopHook(repo, { hook_event_name: 'Stop', session_id: SESSION, cwd: repo.dir, stop_hook_active: false }, { CLAUDE_PROJECT_DIR: repo.dir });
  assert.equal(result.stdout, '');
  assert.deepEqual(repo.calls(), []);
});

test('DONE_CHECK_SKIP=all: no tool runs and the line says the check was skipped', (t) => {
  const repo = newRepo(t);
  const agent = startAgent(repo, 'agent-1');
  breakCaller(repo);
  const result = stopHook(repo, subagentStop(agent), { DONE_CHECK_SKIP: 'all' });
  assert.equal(isBlock(result), false);
  assert.match(result.out.systemMessage, /skipped by DONE_CHECK_SKIP=all/);
  assert.deepEqual(repo.calls(), []);
});

test('F1: two agents of one session in two worktrees get separate keys and separate block state', (t) => {
  const repo = newRepo(t);
  const second = addWorktree(repo.dir, 'lane-two', 'lane-two');
  repo.installTools(['tsc'], second);
  const one = startAgent(repo, 'agent-1');
  const two = startAgent(repo, 'agent-2', { dir: second });
  breakCaller(repo);
  writeFileSync(join(second, 'src', 'other.ts'), 'export const o = 2;\n');
  writeFileSync(join(second, 'fake-tools.json'), `${JSON.stringify({ tsc: TSC_BROKEN_CALLER })}\n`);
  assert.equal(isBlock(stopHook(repo, subagentStop(one))), true);
  assert.equal(isBlock(stopHook(repo, subagentStop(two))), true, 'agent-2 is blocked on its own change, not passed because agent-1 was blocked');
  const rows = ledgerRows(repo);
  assert.deepEqual(rows.map((row) => row.agent), ['agent-1', 'agent-2']);
  assert.notEqual(rows[0].key, rows[1].key);
  assert.equal(isBlock(stopHook(repo, subagentStop(two, { stop_hook_active: true }))), false, 'agent-2 changed nothing: left open');
  writeFileSync(join(repo.dir, 'src', 'lib.ts'), "export const n: string = '9';\n");
  assert.equal(isBlock(stopHook(repo, subagentStop(one, { stop_hook_active: true }))), true, 'agent-1 has its own count and its new change is blocked');
});

test('F2: a block record of an earlier session does not pass the same change of a new session', (t) => {
  const repo = newRepo(t);
  const earlier = startAgent(repo, 'agent-1', { session: 'old-sess' });
  breakCaller(repo);
  assert.equal(isBlock(stopHook(repo, subagentStop(earlier))), true);
  const later = startAgent(repo, 'agent-1', { session: 'new-sess' });
  assert.equal(isBlock(stopHook(repo, subagentStop(later))), true);
});

test('F2: a worktree deleted since the agent started: the stop ends with no output, other agents are still checked', (t) => {
  const repo = newRepo(t);
  const gone = addWorktree(repo.dir, 'lane-gone', 'lane-gone');
  repo.installTools(['tsc'], gone);
  const lost = startAgent(repo, 'agent-gone', { dir: gone });
  writeFileSync(join(gone, 'src', 'other.ts'), 'export const o = 5;\n');
  writeFileSync(join(gone, 'fake-tools.json'), `${JSON.stringify({ tsc: TSC_BROKEN_CALLER })}\n`);
  assert.equal(isBlock(stopHook(repo, subagentStop(lost))), true);
  git(repo.dir, 'worktree', 'remove', '--force', gone);
  assert.equal(existsSync(gone), false, 'the worktree folder is gone');
  assert.equal(stopHook(repo, subagentStop(lost, { stop_hook_active: true })).stdout, '');
  const alive = startAgent(repo, 'agent-alive');
  breakCaller(repo);
  assert.equal(isBlock(stopHook(repo, subagentStop(alive))), true);
});

const MALFORMED_INPUTS = [
  ['empty input', ''],
  ['not JSON', '{not json'],
  ['null', 'null'],
  ['an array', '[]'],
  ['a number', '42'],
  ['a string', '"stop"'],
  ['an empty object', '{}'],
  ['no session_id', JSON.stringify({ hook_event_name: 'Stop', cwd: '/', stop_hook_active: false })],
  ['a session_id that is a path', JSON.stringify({ hook_event_name: 'Stop', session_id: '../../x', stop_hook_active: false })],
  ['a session_id that is not a string', JSON.stringify({ hook_event_name: 'Stop', session_id: 7, stop_hook_active: false })],
];
for (const [name, input] of MALFORMED_INPUTS) {
  test(`F3: ${name}: the hook prints nothing and exits 0, even with a changed project`, (t) => {
    const repo = newRepo(t);
    breakCaller(repo);
    const result = stopHook(repo, input, { CLAUDE_PROJECT_DIR: repo.dir });
    assert.equal(result.stdout, '');
    assert.deepEqual(ledgerRows(repo), []);
  });
}
