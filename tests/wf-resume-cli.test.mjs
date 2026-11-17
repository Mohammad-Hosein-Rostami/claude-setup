// Tests for the wf-resume CLI (home/tools/wf-resume/wf-resume.mjs): `call` prints the exact Workflow call with the stored args, `adopt` copies a
// run's journal into another session's folder (the only way a new session can resume it, per the round 5 probe), `list` prints the notice.
// Hermetic: HOME is a temp folder, so the registry and the projects folder are the test's own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchRecord, saveRun } from '../home/tools/wf-resume/lib/registry.mjs';
import { LAUNCHED, launchInput, launchResponse, result, started, world } from './wf-resume-helpers.mjs';

const CLI = fileURLToPath(new URL('../home/tools/wf-resume/wf-resume.mjs', import.meta.url));
const KILLED = [LAUNCHED, started('a1', '4:rebase', 'Rebase'), result('a1'), started('a2', '4:suite', 'Suite')];

const cli = (w, ...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, HOME: w.root, USERPROFILE: w.root, CLAUDE_CONFIG_DIR: '' } });

function seed(w, { session = 'old-1', runId = 'wf_old', args = { row: '4', branch: 'lane/x' } } = {}) {
  const files = w.addRun({ session, runId, lines: KILLED });
  saveRun(w.registryDir, launchRecord(launchInput({ session, runId, args, response: launchResponse(runId, files.scriptPath) }), '2026-11-17T10:00:00.000Z'));
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
