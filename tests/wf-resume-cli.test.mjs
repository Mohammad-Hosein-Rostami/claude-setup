// Tests for the wf-resume CLI (home/tools/wf-resume/wf-resume.mjs): `call` prints the exact Workflow call with the stored args, `adopt` copies a
// run's journal into another session's folder (the only way a new session can resume it, per the round 5 probe), `list` prints the notice,
// `abandon` marks a run the owner gave up so `list` and the start notice stop showing it.
// Hermetic: HOME is a temp folder, so the registry and the projects folder are the test's own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../home/tools/wf-resume/wf-resume.mjs';
import { launchRecord, runsOfSession, saveRun } from '../home/tools/wf-resume/lib/registry.mjs';
import { LAUNCHED, NOW, launchInput, launchResponse, result, started, world } from './wf-resume-helpers.mjs';

const CLI = fileURLToPath(new URL('../home/tools/wf-resume/wf-resume.mjs', import.meta.url));
const KILLED = [LAUNCHED, started('a1', '4:rebase', 'Rebase'), result('a1'), started('a2', '4:suite', 'Suite')];

const cli = (w, ...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, HOME: w.root, USERPROFILE: w.root, CLAUDE_CONFIG_DIR: '' } });

function seed(w, { session = 'old-1', runId = 'wf_old', args = { row: '4', branch: 'lane/x' }, run = {}, at = '2026-11-17T10:00:00.000Z' } = {}) {
  const files = w.addRun({ session, runId, lines: KILLED, ...run });
  saveRun(w.registryDir, launchRecord(launchInput({ session, runId, args, projectsRoot: w.projectsRoot, response: launchResponse(runId, files.scriptPath) }), at));
  return files;
}

test('call prints the Workflow call with the original args; a run with no stored args says where to find them', async () => {
  const w = await world();
  const files = seed(w);
  const out = cli(w, 'call', 'wf_old');
  assert.equal(out.status, 0, out.stderr);
  assert.ok(out.stdout.includes(`Workflow({scriptPath: ${JSON.stringify(files.scriptPath)}, resumeFromRunId: "wf_old", args: {"row":"4","branch":"lane/x"}})`), out.stdout);
  seed(w, { session: 'old-2', runId: 'wf_big', args: { prompt: 'x'.repeat(5000) } });
  const big = cli(w, 'call', 'wf_big');
  assert.match(big.stdout, /args not stored \(digest [0-9a-f]{12}\)/);
  const none = cli(w, 'call', 'wf_none');
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no run wf_none/);
});

test('adopt copies the journal (private) into the new session\'s run folder, prints the call, and a second adopt changes nothing', async () => {
  const w = await world();
  const files = seed(w);
  const into = w.sessionFolder('new-1');
  const first = cli(w, 'adopt', 'wf_old', '--into', into);
  assert.equal(first.status, 0, first.stderr);
  const copy = join(into, 'subagents', 'workflows', 'wf_old', 'journal.jsonl');
  assert.equal(readFileSync(copy, 'utf8'), readFileSync(files.journal, 'utf8'));
  assert.equal(statSync(copy).mode & 0o777, 0o600);
  assert.match(first.stdout, /Workflow\(\{scriptPath: .*resumeFromRunId: "wf_old", args: \{"row":"4"/);
  writeFileSync(copy, `${LAUNCHED}\n`); // the new session already moved on: its journal must not be overwritten
  const second = cli(w, 'adopt', 'wf_old', '--into', into);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /already has a journal/);
  assert.equal(readFileSync(copy, 'utf8'), `${LAUNCHED}\n`);
});

test('adopt into the run\'s own session copies nothing', async () => {
  const w = await world();
  seed(w);
  const out = cli(w, 'adopt', 'wf_old', '--into', w.sessionFolder('old-1'));
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /same session/);
});

test('adopt refuses a folder outside the projects folder, an unknown run and a missing journal', async () => {
  const w = await world();
  seed(w);
  const outside = cli(w, 'adopt', 'wf_old', '--into', join(w.root, 'elsewhere', 'new-1'));
  assert.equal(outside.status, 1);
  assert.match(outside.stderr, /not inside/);
  assert.equal(existsSync(join(w.root, 'elsewhere')), false);
  assert.equal(cli(w, 'adopt', 'wf_nope', '--into', w.sessionFolder('new-1')).status, 1);
  const files = seed(w, { session: 'old-3', runId: 'wf_gone' });
  writeFileSync(files.journal, '');
  const { rmSync } = await import('node:fs');
  rmSync(files.journal);
  const lost = cli(w, 'adopt', 'wf_gone', '--into', w.sessionFolder('new-1'));
  assert.equal(lost.status, 1);
  assert.match(lost.stderr, /no journal/);
});

test('adopt --from reads the journal of a session folder copied from another config dir (an account switch)', async () => {
  const w = await world();
  const files = seed(w);
  const into = w.sessionFolder('new-1');
  const out = cli(w, 'adopt', 'wf_old', '--into', into, '--from', w.sessionFolder('old-1'));
  assert.equal(out.status, 0, out.stderr);
  assert.ok(existsSync(join(into, 'subagents', 'workflows', 'wf_old', 'journal.jsonl')));
  assert.ok(files.journal);
});

test('list prints the notice of the unfinished runs of a cwd, or says there are none', async () => {
  const w = await world();
  seed(w);
  const out = cli(w, 'list', '--cwd', '/work/proj', '--session', 'new-1', '--into', w.sessionFolder('new-1'));
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /<workflow-resume>[\s\S]*wf_old[\s\S]*adopt wf_old --into/);
  const none = cli(w, 'list', '--cwd', '/work/nothing');
  assert.equal(none.status, 0);
  assert.match(none.stdout, /No unfinished workflow runs/);
});

test('a usage mistake exits 2 with the usage text', async () => {
  const w = await world();
  const out = cli(w, 'frobnicate');
  assert.equal(out.status, 2);
  assert.match(out.stderr, /Usage/);
});

test('run through a symlinked folder (as ~/.claude/tools is), the commands still run and print', async () => {
  const w = await world();
  seed(w);
  const link = join(w.root, 'tools-link');
  symlinkSync(fileURLToPath(new URL('../home/tools/wf-resume', import.meta.url)), link);
  const run = (...args) => spawnSync(process.execPath, [join(link, 'wf-resume.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, HOME: w.root, USERPROFILE: w.root, CLAUDE_CONFIG_DIR: '' } });
  const called = run('call', 'wf_old');
  assert.equal(called.status, 0, called.stderr);
  assert.match(called.stdout, /resumeFromRunId: "wf_old"/);
  assert.match(run('list', '--cwd', '/nowhere').stdout, /No unfinished workflow runs/);
  assert.equal(run('call').status, 2, 'a usage mistake still exits 2 through the link');
});

test('adopt finds the journal of a run recorded under another account\'s projects folder', async () => {
  const w = await world();
  const files = w.addRun({ session: 'old-1', runId: 'wf_old', lines: KILLED });
  saveRun(w.registryDir, launchRecord(launchInput({ session: 'old-1', runId: 'wf_old', projectsRoot: w.projectsRoot, response: launchResponse('wf_old', files.scriptPath) }), '2026-11-17T10:00:00.000Z'));
  const second = join(w.root, 'other-account', 'projects', '-Users-me-proj', 'new-1');
  const out = spawnSync(process.execPath, [CLI, 'adopt', 'wf_old', '--into', second], { encoding: 'utf8', env: { ...process.env, HOME: w.root, USERPROFILE: w.root, CLAUDE_CONFIG_DIR: join(w.root, 'other-account') } });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(readFileSync(join(second, 'subagents', 'workflows', 'wf_old', 'journal.jsonl'), 'utf8'), readFileSync(files.journal, 'utf8'));
});

const FAILED_SUMMARY = '{"status":"failed"}';
const LIST_ARGS = ['list', '--cwd', '/work/proj', '--session', 'new-1'];
const registryBytes = (w) => readdirSync(w.registryDir).filter((name) => name.endsWith('.json')).sort().map((name) => `${name}\n${readFileSync(join(w.registryDir, name), 'utf8')}`).join('\n--\n');
const abandonedOf = (w, session, runId) => runsOfSession(w.registryDir, session).find((record) => record.runId === runId)?.abandoned;
const inProcess = (w, argv, nowMs) => runCli(argv, { registryDir: w.registryDir, projectsRoot: w.projectsRoot, estimateStateDir: w.estimateDir, cwd: '/work/proj', nowMs });

test('abandon hides a stopped or failed run from list, keeps call, and a relaunch lists it again', async () => {
  const w = await world();
  seed(w);
  seed(w, { session: 'old-2', runId: 'wf_failed', run: { finished: true, summary: FAILED_SUMMARY } });
  assert.equal(cli(w, 'abandon', 'wf_old').status, 0);
  const failed = cli(w, 'abandon', 'wf_failed');
  assert.equal(failed.status, 0, failed.stderr);
  assert.match(failed.stdout, /^abandoned wf_failed \(1 record\(s\)\); the start notice no longer lists it; relaunching it with Workflow lists it again/);
  assert.match(cli(w, ...LIST_ARGS).stdout, /No unfinished workflow runs/);
  assert.equal(cli(w, 'call', 'wf_old').status, 0, 'a given-up run can still be called');
  const written = registryBytes(w);
  const again = cli(w, 'abandon', 'wf_old');
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /^wf_old already abandoned at \d{4}-\d\d-\d\dT/);
  assert.equal(registryBytes(w), written, 'a repeat writes nothing');
  // The run was relaunched in another session (a second copy of the run id): abandon marks that copy too and keeps the first copy's time.
  const firstTime = abandonedOf(w, 'old-1', 'wf_old');
  seed(w, { session: 'new-2', runId: 'wf_old', at: '2026-11-17T10:30:00.000Z' });
  const second = inProcess(w, ['abandon', 'wf_old'], Date.parse('2026-11-18T00:00:00Z'));
  assert.equal(second.code, 0, second.err);
  assert.equal(abandonedOf(w, 'old-1', 'wf_old'), firstTime, 'a marked record keeps its first time');
  assert.equal(abandonedOf(w, 'new-2', 'wf_old'), '2026-11-18T00:00:00.000Z');
  // A relaunch registers the run again without the mark: it is listed again; the other given-up run stays hidden.
  seed(w, { session: 'new-2', runId: 'wf_old', at: '2026-11-18T01:00:00.000Z' });
  const listed = cli(w, ...LIST_ARGS).stdout;
  assert.match(listed, /wf_old/);
  assert.doesNotMatch(listed, /wf_failed/);
});

test('abandon refuses bad, unknown and live runs, and a registry it cannot lock', async () => {
  const w = await world();
  seed(w);
  seed(w, { session: 'old-2', runId: 'wf_live', run: { ageMin: 5 } });
  const refused = (out, code, pattern) => {
    assert.equal(out.status ?? out.code, code, out.stderr ?? out.err);
    assert.match(out.stderr ?? out.err, pattern);
    assert.equal(registryBytes(w), before, 'a refusal writes nothing');
  };
  const before = registryBytes(w);
  const bad = cli(w, 'abandon', '../x');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /not a run id/);
  assert.ok(!bad.stderr.includes('../x'), 'a rejected id is never echoed');
  assert.equal(registryBytes(w), before);
  refused(cli(w, 'abandon', 'wf_none'), 1, /no run wf_none in the workflow registry/);
  for (const argv of [['abandon'], ['abandon', 'wf_old', 'wf_live'], ['abandon', 'wf_old', '--force', 'x']]) refused(cli(w, ...argv), 2, /Usage/);
  const live = inProcess(w, ['abandon', 'wf_live'], NOW);
  refused(live, 1, /^run wf_live may still be running \(journal written 5 min ago\): check \/workflows/);
  assert.match(inProcess(w, LIST_ARGS, NOW).out, /wf_live/, 'the live run is still listed');
  // A lock another process holds (this test's own pid, a fresh lock) stops the write: nothing is marked.
  const lock = join(w.registryDir, 'old-1.lock');
  writeFileSync(lock, `${process.pid} ${'0'.repeat(32)}`, { mode: 0o600 });
  refused(cli(w, 'abandon', 'wf_old'), 1, /^registry not written/);
});
