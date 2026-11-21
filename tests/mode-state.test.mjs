// Tests for home/hooks/lib/mode-state.mjs: the state files of the mode hook (a session's mode, the mode last announced to it, the
// compaction counts) and their prune. Security review 1 of lane r9-mode-fix (round 9), S4 and S5: the files were opened by name, so
// a FIFO planted in the state folder hung the hook until Claude Code dropped its output, a link was written through, and the prune
// was unbounded and ended at the first entry it could not handle. No test measures time: the hook runs get a limit only so that a
// hang ends the test instead of the suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, lutimesSync, mkdirSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_BUDGET_MS } from '../home/hooks/mode.mjs';
import { MAX_PRUNED_ENTRIES, STATE_FILE_MAX_BYTES, pruneState, readStateText, removeStateFile, writeStateText } from '../home/hooks/lib/mode-state.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/mode.mjs', import.meta.url));
const POSIX = process.platform !== 'win32';
const posixOnly = { skip: !POSIX && 'links and FIFOs are POSIX only' };
const HANG_LIMIT_MS = 10_000; // a hook that waits on a FIFO never ends by itself: the run is cut here and the test fails
const STALE_MS = 15 * 24 * 60 * 60 * 1000; // one day more than the 14 days a state file is kept
const MS_PER_S = 1000;
const MODE_LINE = 'Mode: high - follow ~/.claude/modes/high.md\n';
const NO_LIMIT = () => 1;
const LATE_CLOCK = ['--import', `data:text/javascript,performance.now=()=>${HOOK_BUDGET_MS}`]; // the hook starts with no budget left
const isFile = (path) => lstatSync(path).isFile();
const fifo = (path) => assert.equal(spawnSync('mkfifo', [path]).status, 0, `mkfifo ${path}`);

/** Makes `count` state files in `dir` that are older than the retention window; returns their names. */
function staleFiles(dir, count, prefix = 'old-') {
  const longAgo = (Date.now() - STALE_MS) / MS_PER_S;
  return Array.from({ length: count }, (_, index) => {
    const name = `${prefix}${index}`;
    writeFileSync(join(dir, name), 'high\n');
    utimesSync(join(dir, name), longAgo, longAgo);
    return name;
  });
}

/** One run of the real hook under a temp HOME, cut at HANG_LIMIT_MS; fails the test when the hook did not end by itself. */
function runHook(home, input, nodeArgs = []) {
  const run = spawnSync(process.execPath, [...nodeArgs, HOOK], { input: JSON.stringify(input), encoding: 'utf8', timeout: HANG_LIMIT_MS, env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_MODE: 'high' } });
  assert.equal(run.error, undefined, `the hook ended by itself (${input.hook_event_name} ${input.session_id})`);
  return run.stdout;
}

test('a state file is read only when it is a regular file of at most STATE_FILE_MAX_BYTES', () => {
  const dir = makeTempDir('mode-state-');
  const write = (name, text) => (writeFileSync(join(dir, name), text), join(dir, name));
  assert.equal(readStateText(write('plain', 'high\n')), 'high\n');
  assert.equal(readStateText(join(dir, 'missing')), undefined);
  assert.equal(readStateText(write('at-the-cap', 'x'.repeat(STATE_FILE_MAX_BYTES))), 'x'.repeat(STATE_FILE_MAX_BYTES));
  assert.equal(readStateText(write('over-the-cap', `high\n${' '.repeat(STATE_FILE_MAX_BYTES)}`)), undefined, 'one that is longer is not read');
  mkdirSync(join(dir, 'folder'));
  assert.equal(readStateText(join(dir, 'folder')), undefined);
  if (!POSIX) return;
  symlinkSync(join(dir, 'plain'), join(dir, 'link'));
  assert.equal(readStateText(join(dir, 'link')), undefined, 'a link is not followed');
});

test('a state file is written under a temp name and renamed: a link or a FIFO in its place is replaced, never written through', posixOnly, () => {
  const dir = join(makeTempDir('mode-state-'), 'state', 'modes'); // made by the first write
  const victim = join(makeTempDir('mode-victim-'), 'victim.txt');
  writeFileSync(victim, 'keep\n');
  writeStateText(dir, 'plain', 'high\n');
  symlinkSync(victim, join(dir, 'link'));
  writeStateText(dir, 'link', 'normal\n');
  assert.equal(readFileSync(victim, 'utf8'), 'keep\n', 'the file the link led to is untouched');
  fifo(join(dir, 'fifo'));
  writeStateText(dir, 'fifo', 'medium\n');
  for (const [name, text] of [['plain', 'high\n'], ['link', 'normal\n'], ['fifo', 'medium\n']]) {
    assert.ok(isFile(join(dir, name)), `${name} is a regular file now`);
    assert.equal(readFileSync(join(dir, name), 'utf8'), text);
  }
  mkdirSync(join(dir, 'folder'));
  assert.throws(() => writeStateText(dir, 'folder', 'high\n'), 'a folder in its place: the write fails and says so');
  assert.deepEqual(readdirSync(dir).sort(), ['fifo', 'folder', 'link', 'plain'], 'no temp file is left, also after a failed write');
});

/** Runs `action` and returns what it wrote to this process's stderr. */
function stderrOf(action) {
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => (lines.push(String(chunk)), true);
  try {
    action();
  } finally {
    process.stderr.write = write;
  }
  return lines.join('');
}

// Review 2, R18 and security review 2, N2: the stderr line was not pinned, and the one folder was listed last on APFS, so a prune
// that stopped quietly at it passed. Folders and stale files are made in turn: in creation order, in its reverse (tmpfs) and in a
// hash order (APFS, ext4) stale files are listed after a folder, which the first assertion checks.
test('the prune goes on past each entry it cannot remove and reports it on stderr, and removes a stale link itself, not what it leads to', posixOnly, () => {
  const FOLDERS = 5;
  const FILES_BETWEEN = 8;
  const dir = makeTempDir('mode-state-');
  const longAgo = (Date.now() - STALE_MS) / MS_PER_S;
  const folders = Array.from({ length: FOLDERS }, (_, index) => {
    staleFiles(dir, FILES_BETWEEN, `old-${index}-`);
    mkdirSync(join(dir, `a-folder-${index}`));
    utimesSync(join(dir, `a-folder-${index}`), longAgo, longAgo);
    return `a-folder-${index}`;
  });
  staleFiles(dir, FILES_BETWEEN, 'old-last-');
  const listed = readdirSync(dir); // the disk's order, as the prune reads it
  assert.ok(listed.slice(listed.findIndex((name) => name.startsWith('a-folder-'))).some((name) => name.startsWith('old-')), 'a stale file is listed after a folder');
  symlinkSync('nowhere', join(dir, 'a-dangling-link'));
  lutimesSync(join(dir, 'a-dangling-link'), longAgo, longAgo);
  writeFileSync(join(dir, 'fresh'), 'high\n');
  symlinkSync(join(dir, 'fresh'), join(dir, 'a-link-to-fresh'));
  lutimesSync(join(dir, 'a-link-to-fresh'), longAgo, longAgo);
  const stderr = stderrOf(() => pruneState(dir, NO_LIMIT));
  assert.deepEqual(readdirSync(dir).sort(), [...folders, 'fresh'], 'every stale file and both stale links are gone');
  for (const folder of folders) assert.match(stderr, new RegExp(`^mode hook: prune failed: .*${folder}`, 'm'), `${folder} is reported`);
});

test('the prune looks at no more than MAX_PRUNED_ENTRIES entries per run and stops when the budget is used up', () => {
  const OVER_THE_CAP = 5;
  const many = makeTempDir('mode-state-');
  staleFiles(many, MAX_PRUNED_ENTRIES + OVER_THE_CAP);
  pruneState(many, NO_LIMIT);
  assert.equal(readdirSync(many).length, OVER_THE_CAP, 'one run');
  pruneState(many, NO_LIMIT);
  assert.equal(readdirSync(many).length, 0, 'the next run takes the rest');
  const TIMED = 10;
  const REMOVALS_IN_TIME = 3;
  const timed = makeTempDir('mode-state-');
  staleFiles(timed, TIMED);
  let asked = 0; // the budget is asked once before the listing and once before each entry
  pruneState(timed, () => REMOVALS_IN_TIME + 1 - (asked += 1) + 1); // time for three entries, then nothing left
  assert.equal(readdirSync(timed).length, TIMED - REMOVALS_IN_TIME);
  pruneState(timed, () => 0);
  assert.equal(readdirSync(timed).length, TIMED - REMOVALS_IN_TIME, 'no time left: nothing is looked at');
  pruneState(join(timed, 'not-there'), NO_LIMIT); // a missing folder: nothing to do, no throw
});

test('a FIFO or a link planted as a state file never hangs the hook and is never written through', posixOnly, () => {
  const home = makeTempDir('mode-state-home-');
  const state = join(home, '.claude', 'state', 'modes');
  mkdirSync(state, { recursive: true });
  const victim = join(home, 'victim.txt');
  writeFileSync(victim, 'keep\n');
  for (const session of ['f1', 'f4']) writeFileSync(join(state, session), 'high\n');
  fifo(join(state, 'f1.announced'));
  assert.equal(runHook(home, { hook_event_name: 'UserPromptSubmit', session_id: 'f1' }), MODE_LINE, 'a FIFO as the announced mode');
  fifo(join(state, 'f2'));
  assert.match(runHook(home, { hook_event_name: 'SessionStart', session_id: 'f2', source: 'startup' }), /^Mode: high/, 'a FIFO as the session mode');
  fifo(join(state, 'f3-a1.compacts'));
  assert.match(runHook(home, { hook_event_name: 'SessionStart', session_id: 'f3', source: 'compact', agent_id: 'a1' }), /^Context was compacted/, 'a FIFO as a compaction count');
  symlinkSync(victim, join(state, 'f4.announced'));
  assert.equal(runHook(home, { hook_event_name: 'UserPromptSubmit', session_id: 'f4' }), MODE_LINE, 'a link as the announced mode');
  assert.equal(readFileSync(victim, 'utf8'), 'keep\n', 'the file the link led to is untouched');
  for (const [name, text] of [['f1.announced', 'high\n'], ['f2', 'high\n'], ['f3-a1.compacts', '1\n'], ['f4.announced', 'high\n']]) {
    assert.ok(isFile(join(state, name)), `${name} was replaced by a regular file`);
    assert.equal(readFileSync(join(state, name), 'utf8'), text);
  }
});

test('removeStateFile removes the name itself: a missing one is silent, a link goes and its target stays, a folder is reported', posixOnly, () => {
  const dir = makeTempDir('mode-state-');
  const victim = join(makeTempDir('mode-victim-'), 'victim.txt');
  writeFileSync(victim, 'keep\n');
  symlinkSync(victim, join(dir, 'link'));
  mkdirSync(join(dir, 'folder'));
  assert.equal(stderrOf(() => removeStateFile(dir, 'missing') ?? removeStateFile(dir, undefined) ?? removeStateFile(dir, 'link')), '');
  assert.equal(readFileSync(victim, 'utf8'), 'keep\n', 'the file the link led to is untouched');
  assert.match(stderrOf(() => removeStateFile(dir, 'folder')), /^mode hook: cannot remove state: .*folder/);
  assert.deepEqual(readdirSync(dir), ['folder']);
});

// Security review 2 of lane r9-mode-fix, S2 (the part left open): a later start of the same session id whose output was lost (it
// ran past the budget) kept the record the earlier start had left, so no prompt of that session said the mode again.
test('a later start of a session removes the old announced record first, so one that runs past the budget leaves the mode line on', () => {
  for (const source of ['compact', 'resume']) {
    const home = makeTempDir('mode-state-home-');
    const announced = join(home, '.claude', 'state', 'modes', 's2.announced');
    runHook(home, { hook_event_name: 'SessionStart', session_id: 's2', source: 'startup' });
    assert.equal(readFileSync(announced, 'utf8'), 'high\n', 'the first start was announced');
    runHook(home, { hook_event_name: 'SessionStart', session_id: 's2', source }, LATE_CLOCK);
    assert.equal(existsSync(announced), false, `the late ${source} start left no record`);
    assert.equal(runHook(home, { hook_event_name: 'UserPromptSubmit', session_id: 's2' }), MODE_LINE, `after a late ${source} start`);
  }
});
