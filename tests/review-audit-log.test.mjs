// Tests for home/tools/review-tier/audit-log.mjs (should-audit, record, resolve, gate, stats) and the audit gate in .githooks/pre-push.
// The CLI runs as a child process on a throw-away git repo; REVIEW_AUDIT_LOG and HOME point into a temp folder, so the real
// ~/.claude/logs/review-audit.jsonl is never touched. Sampling is tested through decideAudit with an injected draw.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLEAN_ENV, commit, git, makeRepo } from './git-tidy-helpers.mjs';
import { AUDIT_ONE_IN, CALIBRATION_LANES, decideAudit } from '../home/tools/review-tier/audit-log.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'home/tools/review-tier/audit-log.mjs');
const { NODE_TEST_CONTEXT: _outerRunner, ...OUTSIDE_A_TEST_RUN } = CLEAN_ENV;
const skipBash = process.platform === 'win32' && 'bash hooks';

/** A temp folder with its own log file; `run(args)` runs the CLI against it and returns { status, stdout, stderr, json() }. */
function makeSandbox() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'audit-log-')));
  const logFile = join(home, 'review-audit.jsonl');
  const env = { ...OUTSIDE_A_TEST_RUN, HOME: home, USERPROFILE: home, REVIEW_AUDIT_LOG: logFile };
  const run = (...args) => {
    const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
    return { ...result, json: () => JSON.parse(result.stdout) };
  };
  const lines = () => readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
  return { home, logFile, env, run, lines };
}

/** `record` one lane: done with `confirmed`, or another state. */
const record = (sandbox, repo, tip, base, state, confirmed) =>
  sandbox.run('record', '--repo', repo, '--tip', tip, '--base', base, '--state', state, ...(confirmed === undefined ? [] : ['--confirmed', String(confirmed)]));

const shouldAudit = (sandbox, ...extra) => sandbox.run('should-audit', '--tip', 'a'.repeat(40), '--json', ...extra);

/** A repo with `count` commits after the base one; returns { repo, base, tips } (tips oldest first). */
function makeHistory(count) {
  const repo = makeRepo();
  const base = git(repo, 'rev-parse', 'HEAD');
  const tips = Array.from({ length: count }, (_, index) => commit(repo, `lane${index}.txt`));
  return { repo, base, tips };
}

test('constants: calibration of 29 lanes and every waived lane audited until the owner decides sampling (D1)', () => {
  assert.equal(CALIBRATION_LANES, 29);
  assert.equal(AUDIT_ONE_IN, 1);
});

test('should-audit on an empty log asks for the audit with reason calibration', () => {
  const sandbox = makeSandbox();
  const result = shouldAudit(sandbox);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.json(), { audit: true, reason: 'calibration', streak: 0 });
});

test('streak counts the newest consecutive done records with confirmed 0', () => {
  const sandbox = makeSandbox();
  const { repo, base, tips } = makeHistory(4);
  for (const tip of tips.slice(0, 3)) record(sandbox, repo, tip, base, 'done', 0);
  assert.equal(shouldAudit(sandbox).json().streak, 3);
  assert.equal(sandbox.run('stats', '--json').json().streak, 3);
});

test('a done record with confirmed findings resets the streak to calibration', () => {
  const sandbox = makeSandbox();
  const { repo, base, tips } = makeHistory(4);
  record(sandbox, repo, tips[0], base, 'done', 0);
  record(sandbox, repo, tips[1], base, 'done', 0);
  record(sandbox, repo, tips[2], base, 'done', 2);
  record(sandbox, repo, tips[3], base, 'done', 0);
  assert.equal(shouldAudit(sandbox).json().streak, 1, 'only the clean record after the miss counts');
});

test('pending, error and sampled-out records neither count nor reset the streak', () => {
  const sandbox = makeSandbox();
  const { repo, base, tips } = makeHistory(4);
  record(sandbox, repo, tips[0], base, 'done', 0);
  record(sandbox, repo, tips[1], base, 'pending');
  record(sandbox, repo, tips[2], base, 'error');
  record(sandbox, repo, tips[3], base, 'sampled-out');
  record(sandbox, repo, tips[1], base, 'done', 0);
  assert.equal(shouldAudit(sandbox).json().streak, 2);
});

test('--escalate on a lane after calibration still asks for the audit with reason escalate', () => {
  assert.deepEqual(decideAudit({ streak: CALIBRATION_LANES, escalate: true, oneIn: 4, draw: () => 3 }), { audit: true, reason: 'escalate', streak: CALIBRATION_LANES });
});

test('decideAudit: below the calibration size every lane is audited, whatever the draw', () => {
  assert.deepEqual(decideAudit({ streak: CALIBRATION_LANES - 1, escalate: false, oneIn: 4, draw: () => 3 }), { audit: true, reason: 'calibration', streak: CALIBRATION_LANES - 1 });
});

test('decideAudit: after calibration a draw of 0 is audited as sample and any other draw is sampled-out', () => {
  const asked = [];
  const draw = (bound) => { asked.push(bound); return asked.length === 1 ? 0 : 2; };
  assert.deepEqual(decideAudit({ streak: CALIBRATION_LANES, escalate: false, oneIn: 4, draw }), { audit: true, reason: 'sample', streak: CALIBRATION_LANES });
  assert.deepEqual(decideAudit({ streak: CALIBRATION_LANES, escalate: false, oneIn: 4, draw }), { audit: false, reason: 'sampled-out', streak: CALIBRATION_LANES });
  assert.deepEqual(asked, [4, 4], 'the draw is made over 1-in-N');
});

test('decideAudit: one in one audits every lane after calibration (the shipped default)', () => {
  const result = decideAudit({ streak: 100, escalate: false, oneIn: AUDIT_ONE_IN, draw: (bound) => bound - 1 });
  assert.equal(result.audit, true);
});

test('record writes one private JSON line with the full shas and the state', () => {
  const sandbox = makeSandbox();
  const { repo, base, tips } = makeHistory(1);
  const result = record(sandbox, repo, tips[0].slice(0, 12), base, 'done', 0);
  assert.equal(result.status, 0, result.stderr);
  const [line] = sandbox.lines();
  const entry = JSON.parse(line);
  assert.equal(entry.tip, tips[0], 'a short sha is stored in full');
  assert.equal(entry.base, base);
  assert.equal(entry.repo, repo);
  assert.equal(entry.state, 'done');
  assert.equal(entry.confirmed, 0);
  assert.equal(statSync(sandbox.logFile).mode & 0o777, 0o600);
});

test('record usage errors exit 2 and write nothing', () => {
  const sandbox = makeSandbox();
  const { repo, base, tips } = makeHistory(1);
  const bad = [
    ['record', '--repo', repo, '--tip', tips[0], '--base', base, '--state', 'done'],
    ['record', '--repo', repo, '--tip', tips[0], '--base', base, '--state', 'pending', '--confirmed', '1'],
    ['record', '--repo', repo, '--tip', tips[0], '--base', base, '--state', 'done', '--confirmed', '-1'],
    ['record', '--repo', repo, '--tip', tips[0], '--base', base, '--state', 'maybe'],
    ['record', '--repo', 'relative/dir', '--tip', tips[0], '--base', base, '--state', 'pending'],
    ['record', '--repo', repo, '--tip', '--evil', '--base', base, '--state', 'pending'],
    ['record', '--repo', repo, '--tip', 'f'.repeat(40), '--base', base, '--state', 'pending'],
    ['record', '--repo', repo, '--tip', tips[0], '--state', 'pending'],
    ['nonsense'],
    [],
  ];
  for (const args of bad) assert.equal(sandbox.run(...args).status, 2, `exit 2 for: ${args.join(' ')}`);
  assert.throws(() => sandbox.lines(), /ENOENT/, 'the log was not created');
});

test('gate: a pending entry on an ancestor of the tip closes the gate (exit 1) and names it', () => {
  const sandbox = makeSandbox();
  const { repo, base, tips } = makeHistory(2);
  record(sandbox, repo, tips[0], base, 'pending');
  const result = sandbox.run('gate', '--repo', repo, '--tip', tips[1]);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, new RegExp(tips[0].slice(0, 8)));
  assert.match(result.stdout + result.stderr, /pending/);
});

test('gate: an entry for the tip itself counts, and HEAD is accepted as the tip', () => {
  const sandbox = makeSandbox();
  const { repo, base, tips } = makeHistory(1);
  record(sandbox, repo, tips[0], base, 'error');
  assert.equal(sandbox.run('gate', '--repo', repo, '--tip', 'HEAD').status, 1);
});

test('gate: an entry whose tip is not an ancestor of the pushed tip is ignored', () => {
  const sandbox = makeSandbox();
  const { repo, base, tips } = makeHistory(2);
  record(sandbox, repo, tips[1], base, 'pending');
  const result = sandbox.run('gate', '--repo', repo, '--tip', tips[0]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('gate: done with confirmed findings closes it, done with none and sampled-out do not', () => {
  const sandbox = makeSandbox();
  const { repo, base, tips } = makeHistory(3);
  record(sandbox, repo, tips[0], base, 'done', 0);
  record(sandbox, repo, tips[1], base, 'sampled-out');
  assert.equal(sandbox.run('gate', '--repo', repo, '--tip', 'HEAD').status, 0);
  record(sandbox, repo, tips[2], base, 'done', 1);
  const closed = sandbox.run('gate', '--repo', repo, '--tip', 'HEAD');
  assert.equal(closed.status, 1);
  assert.match(closed.stdout + closed.stderr, /confirmed 1/);
});

test('gate: only the newest state of a tip counts (pending then done 0 is open)', () => {
  const sandbox = makeSandbox();
  const { repo, base, tips } = makeHistory(1);
  record(sandbox, repo, tips[0], base, 'pending');
  record(sandbox, repo, tips[0], base, 'done', 0);
  assert.equal(sandbox.run('gate', '--repo', repo, '--tip', 'HEAD').status, 0);
});

test('gate: entries of another repo are ignored', () => {
  const sandbox = makeSandbox();
  const here = makeHistory(1);
  const other = makeHistory(1);
  record(sandbox, other.repo, other.tips[0], other.base, 'pending');
  assert.equal(sandbox.run('gate', '--repo', here.repo, '--tip', 'HEAD').status, 0);
});

test('gate on a landed sha: a lane rebased onto a moved base is found by the landed sha it recorded', () => {
  const sandbox = makeSandbox();
  const { repo, base } = makeHistory(0);
  git(repo, 'switch', '-q', '-c', 'lane');
  const reviewedTip = commit(repo, 'lane.txt');
  git(repo, 'switch', '-q', 'main');
  commit(repo, 'other.txt');
  git(repo, 'switch', '-q', 'lane');
  git(repo, 'rebase', '-q', 'main');
  git(repo, 'switch', '-q', 'main');
  git(repo, 'merge', '-q', '--ff-only', 'lane');
  const landed = git(repo, 'rev-parse', 'HEAD');
  assert.notEqual(landed, reviewedTip);
  record(sandbox, repo, reviewedTip, base, 'pending');
  assert.equal(sandbox.run('gate', '--repo', repo, '--tip', 'HEAD').status, 0, 'the reviewed tip is not on main: it cannot be the gate key');
  record(sandbox, repo, landed, base, 'pending');
  assert.equal(sandbox.run('gate', '--repo', repo, '--tip', 'HEAD').status, 1, 'the landed sha closes the gate');
});

test('resolve opens the gate for a confirmed miss and needs the tip to be an ancestor of the fix', () => {
  const sandbox = makeSandbox();
  const { repo, base, tips } = makeHistory(2);
  record(sandbox, repo, tips[0], base, 'done', 3);
  assert.equal(sandbox.run('gate', '--repo', repo, '--tip', 'HEAD').status, 1);
  assert.equal(sandbox.run('resolve', '--repo', repo, '--tip', tips[1], '--fixed-by', tips[0]).status, 2, 'the fix must come after the tip');
  assert.equal(sandbox.run('gate', '--repo', repo, '--tip', 'HEAD').status, 1, 'a refused resolve changes nothing');
  const resolved = sandbox.run('resolve', '--repo', repo, '--tip', tips[0], '--fixed-by', tips[1]);
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.equal(sandbox.run('gate', '--repo', repo, '--tip', 'HEAD').status, 0);
});

test('resolve does not reset the streak: a done miss still breaks it', () => {
  const sandbox = makeSandbox();
  const { repo, base, tips } = makeHistory(2);
  record(sandbox, repo, tips[0], base, 'done', 0);
  record(sandbox, repo, tips[1], base, 'done', 1);
  sandbox.run('resolve', '--repo', repo, '--tip', tips[1], '--fixed-by', tips[1]);
  assert.equal(shouldAudit(sandbox).json().streak, 0);
});

test('a new record after a resolve reopens a pending state (the resolve covered the older state only)', () => {
  const sandbox = makeSandbox();
  const { repo, base, tips } = makeHistory(1);
  record(sandbox, repo, tips[0], base, 'error');
  sandbox.run('resolve', '--repo', repo, '--tip', tips[0], '--fixed-by', tips[0]);
  record(sandbox, repo, tips[0], base, 'pending');
  assert.equal(sandbox.run('gate', '--repo', repo, '--tip', 'HEAD').status, 1);
});

test('gate and resolve usage errors exit 2', () => {
  const sandbox = makeSandbox();
  const { repo, tips } = makeHistory(1);
  assert.equal(sandbox.run('gate', '--repo', repo).status, 2);
  assert.equal(sandbox.run('gate', '--repo', repo, '--tip', '--help').status, 2);
  assert.equal(sandbox.run('gate', '--repo', repo, '--tip', 'f'.repeat(40)).status, 2, 'an unknown commit is a usage error, not an open gate');
  assert.equal(sandbox.run('gate', '--repo', join(repo, 'nope'), '--tip', 'HEAD').status, 2);
  assert.equal(sandbox.run('resolve', '--repo', repo, '--tip', tips[0]).status, 2);
});

test('gate with no log file is open', () => {
  const sandbox = makeSandbox();
  const { repo } = makeHistory(0);
  assert.equal(sandbox.run('gate', '--repo', repo, '--tip', 'HEAD').status, 0);
});

test('gate skips a log line that is not valid JSON instead of failing open on the whole log', () => {
  const sandbox = makeSandbox();
  const { repo, base, tips } = makeHistory(1);
  writeFileSync(sandbox.logFile, 'not json\n');
  record(sandbox, repo, tips[0], base, 'pending');
  assert.equal(sandbox.run('gate', '--repo', repo, '--tip', 'HEAD').status, 1);
});

test('stats counts each tip by its newest state and reports the last miss', () => {
  const sandbox = makeSandbox();
  const { repo, base, tips } = makeHistory(5);
  record(sandbox, repo, tips[0], base, 'done', 0);
  record(sandbox, repo, tips[1], base, 'pending');
  record(sandbox, repo, tips[1], base, 'done', 2);
  record(sandbox, repo, tips[2], base, 'sampled-out');
  record(sandbox, repo, tips[3], base, 'error');
  record(sandbox, repo, tips[4], base, 'pending');
  assert.deepEqual(sandbox.run('stats', '--json').json(), {
    audited: 2, sampledOut: 1, errors: 1, pending: 1, streak: 0, calibration: true, lastMiss: tips[1],
  });
});

test('stats on an empty log is all zero and in calibration', () => {
  const sandbox = makeSandbox();
  assert.deepEqual(sandbox.run('stats', '--json').json(), { audited: 0, sampledOut: 0, errors: 0, pending: 0, streak: 0, calibration: true, lastMiss: null });
  assert.match(sandbox.run('stats').stdout, /calibration/);
});

test('twenty concurrent record calls keep twenty valid lines', async () => {
  const sandbox = makeSandbox();
  const { repo, base, tips } = makeHistory(20);
  const exits = await Promise.all(tips.map((tip) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'record', '--repo', repo, '--tip', tip, '--base', base, '--state', 'pending'], { env: sandbox.env, stdio: 'ignore' });
    child.on('close', resolve);
  })));
  assert.deepEqual(exits, Array(20).fill(0));
  const lines = sandbox.lines();
  assert.equal(lines.length, 20);
  assert.deepEqual(new Set(lines.map((line) => JSON.parse(line).tip)), new Set(tips));
});

test('the CLI works when started through a symlinked folder (the owner layout of ~/.claude)', () => {
  const sandbox = makeSandbox();
  const linked = join(sandbox.home, 'linked-home');
  symlinkSync(join(ROOT, 'home'), linked);
  const result = spawnSync(process.execPath, [join(linked, 'tools/review-tier/audit-log.mjs'), 'should-audit', '--tip', 'a'.repeat(40), '--json'], { encoding: 'utf8', env: sandbox.env });
  assert.deepEqual(JSON.parse(result.stdout), { audit: true, reason: 'calibration', streak: 0 });
});

/** A hook repo: the real .githooks/pre-push, test-pass and audit-log copied in, a trivial passing suite, HOME and the log in temp. */
function makeHookRepo() {
  const sandbox = makeSandbox();
  const repo = makeRepo();
  for (const path of ['.githooks', 'home/tools/test-pass', 'home/tools/review-tier', 'home/tools/git-tidy/lib', 'home/hooks/lib/session-store.mjs']) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    cpSync(join(ROOT, path), join(repo, path), { recursive: true });
  }
  chmodSync(join(repo, '.githooks/pre-push'), 0o755);
  writeFileSync(join(repo, 'tests.mjs'), "import test from 'node:test';\ntest('ok', () => {});\n");
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test tests.mjs' } }));
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'seed');
  const base = git(repo, 'rev-parse', 'HEAD');
  const push = () => spawnSync('bash', ['.githooks/pre-push', 'origin', 'none'], { cwd: repo, encoding: 'utf8', env: sandbox.env });
  return { sandbox, repo, base, push };
}

test('pre-push stops the push while an audit of an ancestor is pending, and lets it through once recorded done', { skip: skipBash }, () => {
  const { sandbox, repo, base, push } = makeHookRepo();
  const landed = commit(repo, 'lane.txt');
  record(sandbox, repo, landed, base, 'pending');
  const closed = push();
  assert.equal(closed.status, 1, closed.stdout + closed.stderr);
  assert.match(closed.stdout + closed.stderr, /pending/);
  record(sandbox, repo, landed, base, 'done', 0);
  const open = push();
  assert.equal(open.status, 0, open.stdout + open.stderr);
});

test('pre-push without audit-log.mjs in the repo behaves as before (gate skipped)', { skip: skipBash }, () => {
  const { repo, push } = makeHookRepo();
  git(repo, 'rm', '-q', '-r', 'home/tools/review-tier');
  git(repo, 'commit', '-q', '-m', 'drop audit-log');
  const result = push();
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
