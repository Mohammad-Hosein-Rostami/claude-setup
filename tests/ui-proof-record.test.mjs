// Tests for `ui-proof record` (home/tools/ui-proof/lib/record-run.mjs and the CLI command): the record writer that replaced the
// ui-proof-gate hook's PostToolUse half (lead decision 2026-11-24). Every repo is a throw-away cs-test git repo; the proof store and the
// run folders are temp dirs (P8). The record path is tested on the lib with a run's printed output; the CLI is tested end to end on a
// run that stops before its verdict (no browser needed), which must leave no record.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RECORD_KINDS, matrixArg, recordRun } from '../home/tools/ui-proof/lib/record-run.mjs';
import { PROOF_AGENT, findPass, readRecords, storeFile } from '../home/tools/ui-proof/lib/records.mjs';
import { workingUiTree } from '../home/tools/ui-proof/lib/ui-files.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const CLI = fileURLToPath(new URL('../home/tools/ui-proof/ui-proof.mjs', import.meta.url));
const POSIX = process.platform !== 'win32';
process.env.UI_PROOF_STATE_DIR = fs.realpathSync.native(makeTempDir('ui-proof-record-store-'));
const GIT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
};
const KEY = 'app:/ / rest / en @360';

function git(dir, args) {
  const result = spawnSync('git', args, { cwd: dir, env: GIT_ENV, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A repo with one UI file committed twice (two UI trees), so a linked worktree at HEAD~1 has another tree than the main checkout. */
function repo() {
  const dir = fs.realpathSync.native(makeTempDir('ui-proof-record-'));
  git(dir, ['init', '-q', '-b', 'main']);
  for (const look of ['small', 'big']) {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'Button.tsx'), `export default function Button() { return <button className="${look}" />; }\n`);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', look]);
  }
  return dir;
}

/** A finished run folder (ledger.json naming `root`, results.json) and the `result:` line `ui-check run` prints for it. */
function runFolder(root, verdict = 'PASS') {
  const dir = makeTempDir('ui-proof-record-run-');
  const ledger = { states: [{ key: KEY, sha256: 'a'.repeat(64), pixels: 0, rows: 0, scale: 1 }], root, head: null, comparator: 'odiff', renderer: 'chromium',
    captures: [{ key: KEY, file: 'w360.png', sha256: null, findings: [], pageErrors: [] }] };
  fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify(ledger));
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify([{ width: 360, status: verdict }]));
  return { dir, output: `rule: default\nresult: ${verdict} run - 1 state - results ${path.join(dir, 'results.json')}\n` };
}

test('the record kinds are the new agent names: dev-run and pixel-qa; any other kind is refused before anything is read', () => {
  assert.deepEqual([...RECORD_KINDS], ['dev-run', 'pixel-qa']);
  const dir = repo();
  for (const kind of ['visual-qa', 'runner', 'dev-pixel', '', undefined]) {
    assert.throws(() => recordRun({ output: runFolder(dir).output, args: [], cwd: dir, kind }), /unknown record kind/, String(kind));
  }
  assert.deepEqual(readRecords(storeFile(dir)), []);
});

test('a pixel-qa PASS is written from the run\'s own result line and is found by the final-gate check; dev-run is recorded as dev-run', () => {
  const dir = repo();
  const run = runFolder(dir);
  const matrix = path.join(run.dir, 'matrix.json');
  fs.writeFileSync(matrix, '{"rule":"default"}');
  const written = recordRun({ output: run.output, args: ['--matrix', matrix, '--base-url', 'http://localhost:1'], cwd: dir, kind: PROOF_AGENT });
  assert.equal(written.verdict, 'PASS');
  assert.equal(written.agentType, 'pixel-qa');
  assert.match(written.matrixHash, /^[0-9a-f]{64}$/);
  assert.match(written.ledgerSha256, /^[0-9a-f]{64}$/);
  assert.equal(findPass(readRecords(storeFile(dir)), workingUiTree(dir), [PROOF_AGENT])?.id, written.id);
  const fail = recordRun({ output: runFolder(dir, 'FAIL').output, args: [], cwd: dir, kind: 'dev-run' });
  assert.deepEqual([fail.verdict, fail.agentType, fail.matrixHash], ['FAIL', 'dev-run', null]);
  assert.equal(readRecords(storeFile(dir)).length, 2);
});

test('output with no result line (a run that stopped before its verdict) writes nothing', () => {
  const dir = repo();
  assert.equal(recordRun({ output: 'ui-check: --matrix: missing\n', args: [], cwd: dir, kind: 'dev-run' }), null);
  assert.deepEqual(readRecords(storeFile(dir)), []);
});

test('cwd = main checkout, ledger root = a linked worktree: the record\'s uiTree is the worktree\'s; another repo or no root: cwd\'s', () => {
  const dir = repo();
  const worktree = path.join(fs.realpathSync.native(makeTempDir('ui-proof-record-wt-')), 'wt');
  git(dir, ['worktree', 'add', '-q', '-b', 'lane', worktree, 'HEAD~1']);
  assert.notEqual(workingUiTree(worktree), workingUiTree(dir));
  const from = (root) => recordRun({ output: runFolder(root).output, args: [], cwd: dir, kind: 'dev-run' });
  const linked = from(worktree);
  assert.equal(linked.uiTree, workingUiTree(worktree));
  assert.deepEqual(linked.captures, [{ key: KEY, sha256: null, findings: [], pageErrors: [] }]);
  assert.equal(from(repo()).uiTree, workingUiTree(dir));
  assert.equal(from(undefined).uiTree, workingUiTree(dir));
});

test('a FIFO ledger is refused at once and no record is written', { skip: !POSIX && 'no FIFO on Windows' }, () => {
  const dir = repo();
  const run = runFolder(dir);
  fs.rmSync(path.join(run.dir, 'ledger.json'));
  assert.equal(spawnSync('mkfifo', [path.join(run.dir, 'ledger.json')]).status, 0);
  assert.throws(() => recordRun({ output: run.output, args: [], cwd: dir, kind: 'pixel-qa' }), { code: 'ENOTPLAIN' });
  assert.deepEqual(readRecords(storeFile(dir)), []);
});

test('matrixArg reads --matrix <path> and --matrix=<path>', () => {
  assert.equal(matrixArg(['--out', 'o', '--matrix', 'm.json']), 'm.json');
  assert.equal(matrixArg(['--matrix=m.json']), 'm.json');
  assert.equal(matrixArg(['--out', 'o']), null);
});

const cli = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: process.env });

test('ui-proof record: usage errors exit 2; a run that stops before its verdict passes its code through and leaves no record', () => {
  const dir = repo();
  assert.equal(cli(['record', '--as', 'pixel-qa'], dir).status, 2, 'no -- before the run arguments');
  const badKind = cli(['record', '--as', 'visual-qa', '--', '--matrix', 'm.json'], dir);
  assert.equal(badKind.status, 2);
  assert.match(badKind.stderr, /--as must be one of dev-run, pixel-qa/);
  const stopped = cli(['record', '--as', 'dev-run', '--', '--matrix', path.join(dir, 'missing.json')], dir);
  assert.equal(stopped.status, 2, `${stopped.stdout}${stopped.stderr}`);
  assert.match(stopped.stdout, /^ui-proof: no record \(the run printed no result line\)$/m);
  assert.deepEqual(readRecords(storeFile(dir)), []);
});
