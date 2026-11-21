// Tests of home/hooks/commit-gate.mjs with the call-window log: a file or a branch move another, older session's record claims is not
// this session's change (F2, F3); new files over 5 MB that the brief does not list block a stop (F4, K7); the settings run the gate on
// every PostToolUse, PostToolUseFailure and PostToolBatch (F5); a Read records no edit (F6). The hold tests (rows 7, 8, 11 and the
// scope rows) each have a usable log and a valid claim, so only the named rule keeps the block; comments name the mutant each kills.
// Own windows are aged by AGE_MS where a test needs a file outside them (no sleeps: the `at` values move, not the clock).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordedPaths } from '../home/hooks/lib/own-edits.mjs';
import { addWorktree, commit, git, makeRepo } from './git-tidy-helpers.mjs';
import { HOUR_MS, linkStatus } from './git-tidy-gate-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { agentTranscript, call, claimAround, edges, hookRun, leadTranscript, logPath, readLog, reflogOf, SESSION, stopEvent, writeLog } from './call-windows-helpers.mjs';

const AGE_MS = 20 * 60_000; // past the 600 s hook tail an own window keeps after its edge when no settings name a timeout (K4')
const SIX_MB = 6 * 1024 * 1024;
const dirty = (dir, n) => new RegExp(`^Uncommitted changes in ${dir.replace(/[/.]/g, '\\$&')} \\(${n} files\\)`);
const sizeReason = (path) => `New files over 5 MB that your brief does not list: ${JSON.stringify(path)} (6.0 MB): take them out of the change and of your commits, or ask for the path to be listed.`;

/** This session's first lead call in a fresh repo (baseline, watches); `stop` and `agentStop` run the real hook and return the reason or null. */
function session() {
  const dir = makeRepo();
  const home = makeTempDir('commit-gate-own-home-');
  const ids = ['m0'];
  call(home, dir, { id: 'm0' });
  const reasonOf = (result) => {
    assert.equal(result.status, 0, result.stderr);
    return result.stdout === '' ? null : JSON.parse(result.stdout).reason;
  };
  const stop = (extra = {}) => reasonOf(hookRun(home, stopEvent(dir, { transcript: leadTranscript(Date.now() - HOUR_MS, ids), ...extra }), dir));
  const agentStop = (agent, brief, agentIds) => reasonOf(hookRun(home, stopEvent(dir, { agent, transcript: agentTranscript(dir, brief, agentIds) }), makeTempDir('lead-')));
  /** Moves every `at` of this session's log and its baselines' takenMs back by AGE_MS. */
  const age = () => {
    writeLog(home, SESSION, readLog(home).map((line) => ({ ...line, at: line.at - AGE_MS })));
    const baseDir = join(home, '.claude', 'state', 'commit-gate', 'baseline');
    for (const name of spawnSync('ls', [baseDir], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)) {
      const record = JSON.parse(readFileSync(join(baseDir, name), 'utf8'));
      writeFileSync(join(baseDir, name), JSON.stringify({ ...record, takenMs: record.takenMs - AGE_MS }));
    }
  };
  const claim = (work, extra = {}) => claimAround(home, { top: dir, startMs: Date.now() - 2 * HOUR_MS, ...extra }, work);
  return { dir, home, ids, stop, agentStop, age, claim };
}

test('F2: a file another session\'s Bash call wrote after the baseline is not counted; a recorded edit beside it counts 1', () => {
  const s = session();
  s.age();
  s.claim(() => writeFileSync(join(s.dir, 'theirs.txt'), 'x'));
  assert.equal(s.stop(), null);
  call(s.home, s.dir, { tool: 'Write', id: 'w1', input: { file_path: join(s.dir, 'mine.txt') } }, () => writeFileSync(join(s.dir, 'mine.txt'), 'y'));
  s.ids.push('w1');
  assert.match(s.stop(), dirty(s.dir, 1));
});

test('F3: the checked-out branch moved under the folder by another session\'s claimed move, no own entry: no block', () => {
  const s = session();
  const lane = addWorktree(s.dir, 'wt-lane', 'lane');
  claimAround(s.home, { reflog: reflogOf(s.dir, 'main'), startMs: Date.now() - 2 * HOUR_MS }, () => {
    git(lane, 'update-ref', 'refs/heads/main', commit(lane, 'landed.txt'));
  });
  assert.equal(s.stop(), null);
});

test('row 8: the session\'s own move leaves the folder stale with no own file: the sync advice; gap files are in no count', () => {
  // mutants: count gap entries; drop the advice with no own entry
  const s = session();
  const lane = addWorktree(s.dir, 'wt-lane', 'lane');
  call(s.home, s.dir, { id: 'u1' }, () => claimAround(s.home, { reflog: reflogOf(s.dir, 'main'), startMs: Date.now() - 2 * HOUR_MS }, () => {
    git(lane, 'update-ref', 'refs/heads/main', commit(lane, 'landed.txt'));
  }));
  s.ids.push('u1');
  const reason = s.stop();
  assert.match(reason, /^Branch main moved to \w+ under .* \(1 commits\)/);
  assert.doesNotMatch(reason, /Uncommitted/);
});

test('row 7: rm of a tracked file, git mv, a file an own window wrote with an old mtime, a bg call\'s late write and an unclaimed file block', () => {
  // mutants: let D/R entries through; mtime for ctime; no claim needed; close a bg call at its close line
  const removed = session();
  commit(removed.dir, 'tracked.txt');
  removed.age();
  removed.claim(() => rmSync(join(removed.dir, 'tracked.txt')));
  assert.match(removed.stop(), dirty(removed.dir, 1), 'rm');
  const moved = session();
  commit(moved.dir, 'tracked.txt');
  moved.age();
  moved.claim(() => git(moved.dir, 'mv', 'tracked.txt', 'renamed.txt'));
  assert.match(moved.stop(), dirty(moved.dir, 1), 'git mv');
  const touched = session();
  const baseFile = join(touched.home, '.claude', 'state', 'commit-gate', 'baseline', `${SESSION}--lead.json`);
  const base = JSON.parse(readFileSync(baseFile, 'utf8'));
  writeFileSync(baseFile, JSON.stringify({ ...base, takenMs: base.takenMs - AGE_MS }));
  const claimAt = Date.now() - 30_000;
  writeLog(touched.home, 'other-session', [edges.folder(touched.dir, claimAt - HOUR_MS), edges.open('o', claimAt, []), edges.close('o', claimAt + 10_000, [])]);
  call(touched.home, touched.dir, { id: 't1' }, () => {
    writeFileSync(join(touched.dir, 'old.txt'), 'x');
    utimesSync(join(touched.dir, 'old.txt'), new Date(claimAt + 5000), new Date(claimAt + 5000));
  });
  touched.ids.push('t1');
  assert.match(touched.stop(), dirty(touched.dir, 1), 'touch -d inside an own window');
  const late = session();
  call(late.home, late.dir, { id: 'bg1', input: { command: 'gen', run_in_background: true } });
  late.ids.push('bg1');
  late.claim(() => writeFileSync(join(late.dir, 'late.txt'), 'x'));
  assert.match(late.stop({ tasks: [{ type: 'shell' }] }), dirty(late.dir, 1), 'a bg call writes after its close edge');
  const unclaimed = session();
  unclaimed.age();
  writeFileSync(join(unclaimed.dir, 'nobody.txt'), 'x');
  assert.match(unclaimed.stop(), dirty(unclaimed.dir, 1), 'outside every window, no claim');
});

test('K2\' and K1\': a file claimed only by a session that never watched this worktree, or by a younger session, blocks; one that watched it passes', () => {
  // mutants: any program window of any session claims; a younger log claims
  const s = session();
  s.age();
  claimAround(s.home, { top: makeTempDir('another-project-'), startMs: Date.now() - 2 * HOUR_MS }, () => writeFileSync(join(s.dir, 'a.txt'), 'x'));
  assert.match(s.stop(), dirty(s.dir, 1), 'never watched this worktree');
  const young = session();
  young.age();
  young.claim(() => writeFileSync(join(young.dir, 'a.txt'), 'x'), { startMs: Date.now() + 1000 });
  assert.match(young.stop(), dirty(young.dir, 1), 'a younger session');
});

test('K4\': a moved command that writes after its close, a quiet line of type local_bash, a file written during the stop-hook window block', () => {
  // mutants: ignore timedOutAfterMs; let a raw discriminant close a bg window; drop the stop-hook window
  const moved = session();
  call(moved.home, moved.dir, { id: 'mv1', input: { command: 'long', timeout: 1000 }, response: { timedOutAfterMs: 1000 } });
  moved.ids.push('mv1');
  moved.claim(() => writeFileSync(join(moved.dir, 'late.txt'), 'x'));
  assert.match(moved.stop(), dirty(moved.dir, 1), 'timed-out command');
  const raw = session();
  call(raw.home, raw.dir, { id: 'bg1', input: { command: 'x', run_in_background: true } });
  raw.ids.push('bg1');
  hookRun(raw.home, stopEvent(raw.dir, { tasks: [{ type: 'local_bash' }] }), raw.dir);
  raw.claim(() => writeFileSync(join(raw.dir, 'late.txt'), 'x'));
  assert.match(raw.stop(), dirty(raw.dir, 1), 'local_bash closes nothing');
  const hooked = session();
  hooked.age();
  writeLog(hooked.home, SESSION, [...readLog(hooked.home), edges.quiet([], Date.now() - 1000, [])]);
  hooked.claim(() => writeFileSync(join(hooked.dir, 'by-a-stop-hook.txt'), 'x'));
  assert.match(hooked.stop(), dirty(hooked.dir, 1), 'during the stop-hook window');
});

test('scope: a sibling agent\'s claimed Bash-made file does not count at an agent\'s stop and counts at the lead\'s; a denied call closes by batch and by quiet', () => {
  // mutants: let a subagent read all windows
  const s = session();
  call(s.home, s.dir, { id: 'a0', agent: 'a1' });
  s.age();
  const at = Date.now();
  writeLog(s.home, SESSION, [...readLog(s.home), edges.open('sib', at - 5, [], { agent: 'a2' }), edges.close('sib', at + 1000, [], { agent: 'a2' })]);
  writeFileSync(join(s.dir, 'sibling.txt'), 'x');
  assert.equal(s.agentStop('a1', 'brief', ['a0']), null, 'another agent\'s closed window claims it');
  assert.match(s.stop(), dirty(s.dir, 1), 'the lead owns every agent\'s windows');
  const denied = session();
  const t = Date.now() - 2 * AGE_MS;
  writeLog(denied.home, SESSION, [...readLog(denied.home).map((line) => ({ ...line, at: line.at - 3 * AGE_MS })), edges.open('d1', t, []), edges.batch(['d1'], t + 10, []), edges.open('d2', t + 20, []), edges.quiet([], t + 30, [])]);
  denied.ids.push('d1', 'd2');
  denied.claim(() => writeFileSync(join(denied.dir, 'theirs.txt'), 'x'));
  assert.equal(denied.stop(), null, 'both denied calls closed, so the claimed file is foreign');
});

test('F4: an agent adds and commits a 6 MB file its brief does not name: its stop and the lead\'s stop block and name the path', () => {
  const s = session();
  call(s.home, s.dir, { id: 'a0', agent: 'a1' }, () => {
    writeFileSync(join(s.dir, 'big.bin'), Buffer.alloc(SIX_MB, 1));
    git(s.dir, 'add', 'big.bin');
    git(s.dir, 'commit', '-q', '-m', 'add big');
  });
  assert.equal(s.agentStop('a1', 'implement the lane', ['a0']), sizeReason('big.bin'));
  assert.equal(s.stop(), sizeReason('big.bin'));
});

test('K7: a listed 6 MB file passes both stops; one from before the baseline never counts; one named in an open row passes the lead', () => {
  const listed = session();
  call(listed.home, listed.dir, { id: 'a0', agent: 'a1' }, () => commit(listed.dir, 'big.bin', Buffer.alloc(SIX_MB, 1)));
  assert.equal(listed.agentStop('a1', 'add big.bin as the fixture', ['a0']), null);
  assert.equal(listed.stop(), null, 'the agent\'s listed record reaches the lead');
  const dir = makeRepo();
  commit(dir, 'old-big.bin', Buffer.alloc(SIX_MB, 1));
  const home = makeTempDir('commit-gate-own-home-');
  call(home, dir, { id: 'm0' });
  assert.equal(hookRun(home, stopEvent(dir, { transcript: leadTranscript(Date.now() - HOUR_MS, ['m0']) }), dir).stdout, '');
  const row = session();
  writeFileSync(join(row.dir, '.git', 'info', 'exclude'), 'STATUS.md\n');
  linkStatus({ home: row.home }, row.dir, [['r1', 'vendor big.bin into the repo']]);
  call(row.home, row.dir, { id: 'c1' }, () => commit(row.dir, 'big.bin', Buffer.alloc(SIX_MB, 1)));
  row.ids.push('c1');
  assert.equal(row.stop(), null);
});

test('row 11: a 6 MB file made by Bash and left untracked blocks; the same file claimed by another session does not; K1\' a younger session\'s 6 MB commit counts', () => {
  // mutants: skip untracked files; ignore the claim in the size count; let a younger log claim the branch move
  const own = session();
  call(own.home, own.dir, { id: 'b1' }, () => writeFileSync(join(own.dir, 'blob.bin'), Buffer.alloc(SIX_MB, 1)));
  own.ids.push('b1');
  assert.match(own.stop(), dirty(own.dir, 1));
  assert.equal(own.stop(), sizeReason('blob.bin'), 'the next stop names the size');
  const theirs = session();
  theirs.age();
  theirs.claim(() => writeFileSync(join(theirs.dir, 'blob.bin'), Buffer.alloc(SIX_MB, 1)));
  assert.equal(theirs.stop(), null);
  const young = session();
  claimAround(young.home, { reflog: reflogOf(young.dir, 'main'), startMs: Date.now() + 1000 }, () => commit(young.dir, 'big.bin', Buffer.alloc(SIX_MB, 1)));
  assert.equal(young.stop(), sizeReason('big.bin'));
});

test('F5: settings and the merge output of each OS file run commit-gate on PostToolUse with no matcher, on PostToolUseFailure and on PostToolBatch', () => {
  const settings = fileURLToPath(new URL('../settings/', import.meta.url));
  const filter = fileURLToPath(new URL('../scripts/merge-settings.jq', import.meta.url));
  const docs = [JSON.parse(readFileSync(join(settings, 'base.json'), 'utf8'))];
  if (spawnSync('jq', ['--version']).status === 0) {
    for (const os of ['macos', 'linux', 'windows']) {
      const merged = spawnSync('jq', ['-s', '-f', filter, join(settings, 'base.json'), join(settings, `${os}.json`)], { encoding: 'utf8' });
      assert.equal(merged.status, 0, merged.stderr);
      docs.push(JSON.parse(merged.stdout));
    }
  }
  for (const doc of docs) {
    for (const event of ['PostToolUse', 'PostToolUseFailure', 'PostToolBatch']) {
      const groups = (doc.hooks[event] ?? []).filter(({ hooks }) => hooks.some(({ command }) => command.includes('/hooks/commit-gate.mjs')));
      assert.equal(groups.length, 1, event);
      assert.equal(groups[0].matcher, undefined, `${event} has no matcher`);
      const entry = groups[0].hooks.find(({ command }) => command.includes('/hooks/commit-gate.mjs'));
      assert.deepEqual([entry.timeout, entry.onFailure], [5, undefined]);
    }
  }
});

test('F6: a PostToolUse of Read with a file_path records no edit; a PostToolUse of Write still does', () => {
  const home = makeTempDir('commit-gate-own-home-');
  const env = { HOME: home, USERPROFILE: home };
  for (const tool_name of ['Read', 'Write']) {
    hookRun(home, { hook_event_name: 'PostToolUse', session_id: SESSION, tool_name, tool_use_id: tool_name, tool_input: { file_path: `/tmp/${tool_name}.txt` } });
  }
  assert.deepEqual([...recordedPaths(env, SESSION, '')].map((path) => path.split('/').at(-1)), ['Write.txt']);
  assert.ok(readLog(home).length >= 1 && logPath(home).endsWith('.jsonl'));
});
