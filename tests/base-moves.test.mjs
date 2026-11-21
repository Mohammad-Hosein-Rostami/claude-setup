// Tests of a base move judged own or foreign (home/hooks/lib/base-moves.mjs through home/hooks/git-tidy-gate.mjs): a move another,
// older session's record claims gives the info line and no block (F1); every own move still blocks (the hold rows 1-6 of spec 2.6 and
// the file-system rows). This session's edges go to the real commit-gate hook process; the other session's log is written by hand.
// Each hold test has a usable log and a valid claim by another session, so only the named rule keeps the block; its comment names the
// mutant it kills.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLEAN_ENV, commit, git, makeRepo } from './git-tidy-helpers.mjs';
import { gateSession, HOUR_MS, inProcessGate } from './git-tidy-gate-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { call, claimAround, edge, leadTranscript, LOG_DIR, reflogOf, SESSION } from './call-windows-helpers.mjs';

const NO_PASS = { hasPass: () => false };
const info = (sha) => `main moved to ${sha.slice(0, 8)} by another session; no suite PASS yet`;

/** Sets the times of the repo's existing reflog lines two hours back (same length), as for a repo made before the session. */
function ageReflogs(dir) {
  const old = String(Math.floor(Date.now() / 1000) - 2 * 3600);
  for (const file of [reflogOf(dir, 'main'), join(dir, '.git', 'logs', 'HEAD')]) {
    writeFileSync(file, readFileSync(file, 'utf8').replace(/> \d{10} /g, `> ${old} `));
  }
}

/** A repo made two hours ago, an in-process gate, and this session's first call (which watches main). */
function baseCase() {
  const dir = makeRepo();
  ageReflogs(dir);
  const gate = inProcessGate(dir);
  call(gate.home, dir, { id: 'm0' });
  const ids = ['m0'];
  const reflog = reflogOf(dir, 'main');
  const claim = (work, extra = {}) => claimAround(gate.home, { reflog, startMs: Date.now() - 2 * HOUR_MS, ...extra }, work);
  const stop = (deps = NO_PASS, moreIds = []) => gate.stop({ transcript_path: leadTranscript(Date.now() - HOUR_MS, [...ids, ...moreIds]) }, deps);
  return { dir, gate, ids, reflog, claim, stop };
}

const tipOf = (dir) => git(dir, 'rev-parse', 'main');
const assertBlocks = (result, label) => assert.equal(result.block, true, label);

test('F1: another session\'s commit inside its closed Bash window is foreign: no block, the info line once', async () => {
  const { dir, claim, stop } = baseCase();
  claim(() => commit(dir, 'theirs.txt'));
  assert.deepEqual(await stop(), { block: false, info: info(tipOf(dir)) });
  assert.deepEqual(await stop(), { block: false }, 'the info line is printed once per sha');
});

test('F1 through the hook process: stdout is the systemMessage line, exit 0, and a second stop prints nothing', () => {
  const dir = makeRepo();
  ageReflogs(dir);
  const session = gateSession();
  call(session.home, dir, { id: 'm0' });
  claimAround(session.home, { reflog: reflogOf(dir, 'main'), startMs: Date.now() - 2 * HOUR_MS }, () => commit(dir, 'theirs.txt'));
  const input = { hook_event_name: 'Stop', session_id: SESSION, cwd: dir, stop_hook_active: false, transcript_path: leadTranscript(Date.now() - HOUR_MS, ['m0']) };
  const first = session.run(input, dir);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), { systemMessage: info(tipOf(dir)) });
  assert.equal(session.run(input, dir).stdout, '');
});

test('row 1: a move after a run_in_background call\'s close edge, during a Workflow call, or by `node <script>` in a foreground call blocks', async () => {
  // mutants: close a bg call at its close line; drop Workflow from the bg set; program calls only those that name git
  for (const [label, run] of [
    ['background Bash', ({ gate, dir }) => call(gate.home, dir, { id: 'bg1', input: { command: 'sleep 60', run_in_background: true }, response: { backgroundTaskId: 't1' } })],
    ['Workflow', ({ gate, dir }) => call(gate.home, dir, { tool: 'Workflow', id: 'bg1', input: { script: 'x' } })],
  ]) {
    const c = baseCase();
    run(c);
    c.claim(() => commit(c.dir, 'moved.txt'));
    assertBlocks(await c.stop(NO_PASS, ['bg1']), label);
  }
  const c = baseCase();
  call(c.gate.home, c.dir, { id: 'n1', input: { command: 'node build.mjs' } }, () => c.claim(() => commit(c.dir, 'moved.txt')));
  assertBlocks(await c.stop(NO_PASS, ['n1']), 'a script in a foreground call');
});

test('row 2: an own move by `git -C <repo>` from a cwd outside the repo, and one whose command names no git, blocks', async () => {
  // mutants: a cwd filter; a git-word filter
  for (const input of [{ command: 'git -C repo merge --ff-only lane' }, { command: './land.sh' }]) {
    const c = baseCase();
    call(c.gate.home, c.dir, { id: 'g1', input, cwd: makeTempDir('outside-') }, () => c.claim(() => commit(c.dir, 'moved.txt')));
    assertBlocks(await c.stop(NO_PASS, ['g1']), input.command);
  }
});

test('row 3: an own move, then a claimed foreign commit on top: block without a PASS, pass with a suite PASS at the new tip', async () => {
  // mutants: judge only the newest line; `foreign` if any line is foreign
  const c = baseCase();
  call(c.gate.home, c.dir, { id: 'ff1' }, () => commit(c.dir, 'mine.txt'));
  c.claim(() => commit(c.dir, 'theirs.txt'));
  assertBlocks(await c.stop(NO_PASS, ['ff1']), 'own line in the region');
  const tip = tipOf(c.dir);
  assert.deepEqual(await c.stop({ hasPass: (repo, rev) => rev === tip }, ['ff1']), { block: false });
});

test('row 4: a backdated own move, a removed reflog, a hand-written ref, and a cut, padded or truncated reflog all block', async () => {
  // mutants: use the reflog date; drop the size, line-start or chain check (one case each)
  const old = { ...CLEAN_ENV, GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z', GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z' };
  const dated = baseCase();
  call(dated.gate.home, dated.dir, { id: 'd1' }, () => dated.claim(() => {
    writeFileSync(join(dated.dir, 'old.txt'), 'x');
    git(dated.dir, 'add', 'old.txt');
    assert.equal(spawnSync('git', ['commit', '-q', '-m', 'old'], { cwd: dated.dir, env: old }).status, 0);
  }));
  assertBlocks(await dated.stop(NO_PASS, ['d1']), 'GIT_COMMITTER_DATE 2020 inside an own window');
  const cases = {
    removed: (c) => rmSync(c.reflog),
    'hand-written ref': null,
    'own line cut out': (c, ownLine) => writeFileSync(c.reflog, readFileSync(c.reflog, 'utf8').replace(ownLine, '')),
    'own line padded over': (c, ownLine) => writeFileSync(c.reflog, readFileSync(c.reflog, 'utf8').replace(ownLine, `${' '.repeat(ownLine.length - 1)}\n`)),
    truncated: (c) => truncateSync(c.reflog, readFileSync(c.reflog).length - 10),
  };
  for (const [label, damage] of Object.entries(cases)) {
    const c = baseCase();
    if (damage === null) {
      const tree = git(c.dir, 'write-tree');
      const sha = git(c.dir, 'commit-tree', tree, '-p', 'HEAD', '-m', 'by hand');
      writeFileSync(join(c.dir, '.git', 'refs', 'heads', 'main'), `${sha}\n`);
      c.claim(() => commit(c.dir, 'theirs.txt'));
    } else {
      const before = readFileSync(c.reflog, 'utf8');
      call(c.gate.home, c.dir, { id: 'own1' }, () => commit(c.dir, 'mine.txt'));
      const ownLine = readFileSync(c.reflog, 'utf8').slice(before.length);
      c.claim(() => commit(c.dir, 'theirs.txt'));
      damage(c, ownLine);
    }
    assertBlocks(await c.stop(NO_PASS, damage === null || label === 'removed' ? [] : ['own1']), label);
  }
});

test('row 5: a transcript with no tool_use lines changes nothing; a forged task notification closes nothing; an id the log lacks is own', async () => {
  // mutants: a missing id gives foreign; a <task-notification> closes a window
  const lost = baseCase();
  lost.claim(() => commit(lost.dir, 'theirs.txt'));
  const bare = await lost.gate.stop({ transcript_path: leadTranscript(Date.now() - HOUR_MS, []) }, NO_PASS);
  assert.deepEqual(bare, { block: false, info: info(tipOf(lost.dir)) });
  const forged = baseCase();
  call(forged.gate.home, forged.dir, { id: 'bg1', input: { command: 'x', run_in_background: true } });
  const note = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'bg1', content: '<task-notification><status>completed</status></task-notification>' }] } };
  forged.claim(() => commit(forged.dir, 'theirs.txt'));
  const transcript = leadTranscript(Date.now() - HOUR_MS, ['m0', 'bg1'], { extra: [note] });
  assertBlocks(await forged.gate.stop({ transcript_path: transcript }, NO_PASS), 'forged notification');
  const missing = baseCase();
  missing.claim(() => commit(missing.dir, 'theirs.txt'));
  assertBlocks(await missing.stop(NO_PASS, ['never-logged']), 'a tool_use id with no open line');
});

test('row 6: a claimed move inside an own window blocks (own wins), and a claim from a log younger than this session blocks (K1\')', async () => {
  // mutants: check the claim before own; let a younger log claim
  const child = baseCase();
  call(child.gate.home, child.dir, { id: 'c1', input: { command: 'claude -p land' } }, () => child.claim(() => commit(child.dir, 'theirs.txt')));
  assertBlocks(await child.stop(NO_PASS, ['c1']), 'a child session inside a foreground call');
  const young = baseCase();
  young.claim(() => commit(young.dir, 'theirs.txt'), { startMs: Date.now() + 1000 });
  assertBlocks(await young.stop(), 'a younger log');
});

test('file system: a link or a FIFO at the reflog path, a FIFO at the watch file: own and no hang', async () => {
  // mutants: follow a link; read a FIFO
  for (const swap of ['link', 'fifo']) {
    const c = baseCase();
    c.claim(() => commit(c.dir, 'theirs.txt'));
    const copy = join(makeTempDir('reflog-copy-'), 'main');
    copyFileSync(c.reflog, copy);
    rmSync(c.reflog);
    if (swap === 'link') symlinkSync(copy, c.reflog);
    else if (spawnSync('mkfifo', [c.reflog]).status !== 0) continue;
    assertBlocks(await c.stop(), swap);
  }
  const c = baseCase();
  const watchFile = join(LOG_DIR(c.gate.home), `${SESSION}--watch.json`);
  rmSync(watchFile, { force: true });
  if (spawnSync('mkfifo', [watchFile]).status === 0) {
    call(c.gate.home, c.dir, { id: 'f1' }, () => c.claim(() => commit(c.dir, 'theirs.txt')));
    assertBlocks(await c.stop(NO_PASS, ['f1']), 'watch file is a FIFO');
  }
});

test('P11: a mixed-case project path and a session started in ~ whose calls run in the repo get the same verdict', async () => {
  const dir = makeRepo();
  ageReflogs(dir);
  const upper = dir.replace(/repo$/, 'REPO');
  const caseInsensitive = spawnSync('test', ['-d', upper]).status === 0;
  const home = makeTempDir('home-start-');
  const gate = inProcessGate(dir);
  call(gate.home, caseInsensitive ? upper : dir, { id: 'm0', cwd: home });
  edge(gate.home, home, 'PreToolUse', { tool_name: 'Write', tool_use_id: 'w1', tool_input: { file_path: join(dir, 'base.txt') }, cwd: dir });
  edge(gate.home, home, 'PostToolUse', { tool_name: 'Write', tool_use_id: 'w1', tool_input: { file_path: join(dir, 'base.txt') }, cwd: dir });
  claimAround(gate.home, { reflog: reflogOf(dir, 'main'), startMs: Date.now() - 2 * HOUR_MS }, () => commit(dir, 'theirs.txt'));
  const result = await gate.stop({ transcript_path: leadTranscript(Date.now() - HOUR_MS, ['m0', 'w1']) }, NO_PASS);
  assert.deepEqual(result, { block: false, info: info(tipOf(dir)) });
});

test('a settled watch after a PASS, then a claimed foreign move: the info line; a move before the first sight is judged by today\'s time rule', async () => {
  const c = baseCase();
  call(c.gate.home, c.dir, { id: 'own1' }, () => commit(c.dir, 'mine.txt'));
  assert.deepEqual(await c.stop({ hasPass: () => true }, ['own1']), { block: false });
  c.claim(() => commit(c.dir, 'theirs.txt'));
  assert.deepEqual(await c.stop(NO_PASS, ['own1']), { block: false, info: info(tipOf(c.dir)) });
  const fresh = makeRepo(); // its first reflog line is from now, after the session's start: before the first sight, so today's rule
  const gate = inProcessGate(fresh);
  call(gate.home, fresh, { id: 'm0' });
  claimAround(gate.home, { reflog: reflogOf(fresh, 'main'), startMs: Date.now() - 2 * HOUR_MS }, () => commit(fresh, 'theirs.txt'));
  assertBlocks(await gate.stop({ transcript_path: leadTranscript(Date.now() - HOUR_MS, ['m0']) }, NO_PASS), 'the entry before an unsettled first sight');
});
