// Tests for home/hooks/commit-gate.mjs (Stop and SubagentStop): a stop is blocked once per dirty state of the session's own worktree
// (the one holding CLAUDE_PROJECT_DIR; for a subagent, the one holding the folder it started in, read from its transcript), never a
// folder the session only cd'd into. git there never runs a program the repository names (fsmonitor, filters, a bare-repo layout).
// A branch moved under its folder gets the sync command instead of "commit them". Each test builds its own repo in a temp folder
// (git-tidy-helpers.mjs) and gives the hook a private HOME for its state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide } from '../home/hooks/commit-gate.mjs';
import { addWorktree, CLEAN_ENV, commit, git, makeRepo } from './git-tidy-helpers.mjs';
import { fastestMs } from './timing.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/commit-gate.mjs', import.meta.url));
const SPEED_TARGET_MS = 300;
const posixOnly = { skip: process.platform === 'win32' ? 'marker programs are sh scripts' : false };

const dirtyReason = (folder, count) => `Uncommitted changes in ${folder} (${count} files): commit them as small Conventional Commits `
  + '(`git commit -m ... -- <paths>`), or say in your reply why they must stay uncommitted.';
const BASE_SENTENCE = (branch) => ` This is the base folder (${branch}) and lane worktrees exist: edits belong in a lane worktree, never in the base folder.`;

/**
 * A private HOME; stop(project, extra) sends one Stop event of a main session whose project is `project` (cwd too unless extra.cwd)
 * and returns the reason it blocked with, or null. agentStop(start, extra) sends a SubagentStop whose transcript starts in `start`.
 */
function gateSession() {
  const home = mkdtempSync(join(tmpdir(), 'commit-gate-home-'));
  const send = (input, project) => {
    const env = { ...CLEAN_ENV, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: project };
    const { status, stdout, stderr } = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8', env });
    assert.equal(status, 0, stderr);
    assert.equal(stderr, '');
    if (stdout === '') return null;
    const out = JSON.parse(stdout);
    assert.equal(out.decision, 'block');
    return out.reason;
  };
  const stop = (project, extra = {}) => send({ hook_event_name: 'Stop', session_id: 'sess-1', cwd: project, stop_hook_active: false, ...extra }, project);
  const agentStop = (start, extra = {}) => {
    const transcript = join(mkdtempSync(join(tmpdir(), 'commit-gate-agent-')), 'agent.jsonl');
    const first = { type: 'user', message: { role: 'user', content: 'brief naming "cwd":"/elsewhere"' }, cwd: start, agentId: 'a1' };
    writeFileSync(transcript, `${JSON.stringify(first)}\n${JSON.stringify({ type: 'assistant', cwd: '/moved/on' })}\n`);
    const input = { hook_event_name: 'SubagentStop', session_id: 'sess-1', agent_id: 'a1', agent_type: 'implementer', cwd: start, agent_transcript_path: transcript, stop_hook_active: false, ...extra };
    return send(input, extra.project ?? mkdtempSync(join(tmpdir(), 'commit-gate-lead-')));
  };
  return { home, stop, agentStop };
}

/** A sh script that creates `marker` when run (and passes its input through, as a clean filter must). */
function markerScript(folder, name, marker) {
  const path = join(folder, name);
  writeFileSync(path, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
  return path;
}

test('a modified tracked file blocks the stop once; the same state passes the second time; a new state blocks again', () => {
  const { stop } = gateSession();
  const dir = makeRepo();
  writeFileSync(join(dir, 'base.txt'), 'changed');
  assert.equal(stop(dir), dirtyReason(dir, 1));
  assert.equal(stop(dir), null);
  writeFileSync(join(dir, 'new.txt'), 'untracked');
  assert.equal(stop(dir), dirtyReason(dir, 2));
  assert.equal(stop(dir), null);
});

test('staged and untracked files count; a project in a subfolder names the worktree; a subagent is gated in the folder it started in', () => {
  const { stop, agentStop } = gateSession();
  const dir = makeRepo();
  writeFileSync(join(dir, 'staged.txt'), 's');
  git(dir, 'add', 'staged.txt');
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'loose.txt'), 'u');
  assert.equal(stop(join(dir, 'sub')), dirtyReason(dir, 2));
  assert.equal(agentStop(join(dir, 'sub'), { cwd: mkdtempSync(join(tmpdir(), 'cd-elsewhere-')) }), dirtyReason(dir, 2));
});

test('passes: a clean repo, a folder outside git, ignored and .git/info/exclude files, an unfinished merge', () => {
  const { stop } = gateSession();
  assert.equal(stop(makeRepo()), null);
  assert.equal(stop(mkdtempSync(join(tmpdir(), 'not-a-repo-'))), null);
  const ignored = makeRepo();
  writeFileSync(join(ignored, '.gitignore'), 'build/\n');
  commit(ignored, '.gitignore', 'build/\n');
  mkdirSync(join(ignored, 'build'));
  writeFileSync(join(ignored, 'build', 'out.js'), 'x');
  writeFileSync(join(ignored, '.git', 'info', 'exclude'), 'STATUS.md\n');
  writeFileSync(join(ignored, 'STATUS.md'), 'notes');
  assert.equal(stop(ignored), null);
  const merging = makeRepo();
  git(merging, 'checkout', '-q', '-b', 'side');
  commit(merging, 'base.txt', 'side');
  git(merging, 'checkout', '-q', 'main');
  commit(merging, 'base.txt', 'main');
  spawnSync('git', ['merge', 'side'], { cwd: merging, env: CLEAN_ENV }); // conflicts on purpose: the merge stays unfinished
  assert.equal(stop(merging), null);
});

test('stop_hook_active is still checked: a new dirty state on a continued stop blocks, at most twice in a row, and never loops', () => {
  const { stop } = gateSession();
  const dir = makeRepo();
  const continued = { stop_hook_active: true };
  assert.equal(stop(dir), null, 'clean: another gate (typecheck) blocked this stop');
  writeFileSync(join(dir, 'base.txt'), 'changed');
  assert.equal(stop(dir, continued), dirtyReason(dir, 1), 'the fix made after that block is checked');
  assert.equal(stop(dir, continued), null, 'the same state passes');
  writeFileSync(join(dir, 'a.txt'), 'a');
  assert.equal(stop(dir, continued), dirtyReason(dir, 2));
  writeFileSync(join(dir, 'b.txt'), 'b');
  assert.equal(stop(dir, continued), null, 'a third block in one chain of continued stops is never given');
  writeFileSync(join(dir, 'c.txt'), 'c');
  assert.equal(stop(dir), dirtyReason(dir, 4), 'a fresh stop that blocks starts a new chain');
});

test('the base folder (main) dirty while lane worktrees exist: the reason adds that edits belong in a lane; a dirty lane does not', () => {
  const { stop } = gateSession();
  const dir = makeRepo();
  writeFileSync(join(dir, 'base.txt'), 'changed');
  assert.equal(stop(dir), dirtyReason(dir, 1), 'no lanes yet: the plain reason');
  const lane = addWorktree(dir, 'wt-lane', 'lane');
  writeFileSync(join(dir, 'other.txt'), 'x');
  assert.equal(stop(dir), dirtyReason(dir, 2) + BASE_SENTENCE('main'));
  writeFileSync(join(lane, 'lane.txt'), 'x');
  assert.equal(stop(lane), dirtyReason(lane, 1));
});

test('only the session\'s own worktree is gated: a dirty repo the session cd\'d into, or a subagent\'s later cwd, never counts', () => {
  const { stop, agentStop } = gateSession();
  const project = makeRepo();
  const visited = makeRepo();
  for (let i = 0; i < 18; i += 1) writeFileSync(join(visited, `read-only-${i}.txt`), 'x');
  assert.equal(stop(project, { cwd: visited }), null, 'the main session only read the other repo');
  writeFileSync(join(project, 'base.txt'), 'changed');
  assert.equal(stop(project, { cwd: visited }), dirtyReason(project, 1), 'its own project is named, not the cwd');
  assert.equal(agentStop(project, { cwd: visited }), dirtyReason(project, 1), 'a subagent: the folder it started in');
  assert.equal(agentStop(project, { agent_transcript_path: join(project, 'missing.jsonl'), agent_id: 'a2' }), null, 'no transcript: no folder, no gate');
});

test('no program runs: fsmonitor and filters in .git/config, an include, a bare-repo layout and a planted cd folder leave no marker', posixOnly, () => {
  const { stop, agentStop } = gateSession();
  const markers = mkdtempSync(join(tmpdir(), 'commit-gate-markers-'));
  const scripts = mkdtempSync(join(tmpdir(), 'commit-gate-scripts-'));
  const marker = (name) => join(markers, name);

  const monitored = makeRepo();
  git(monitored, 'config', 'core.fsmonitor', markerScript(scripts, 'fsmonitor.sh', marker('fsmonitor')));
  writeFileSync(join(monitored, 'base.txt'), 'changed');
  assert.equal(stop(monitored), dirtyReason(monitored, 1), 'fsmonitor is switched off, the gate still works');

  const filtered = (name, configure) => {
    const dir = makeRepo();
    commit(dir, '.gitattributes', '* filter=x\n');
    configure(dir, `[filter "x"]\n\tclean = ${markerScript(scripts, `${name}.sh`, marker(name))}\n`);
    writeFileSync(join(dir, 'base.txt'), 'base.txt'); // same content, new time: git must run the clean filter to compare
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(dir, 'base.txt'), later, later);
    writeFileSync(join(dir, 'new.txt'), 'x');
    return dir;
  };
  const appendConfig = (dir, text) => writeFileSync(join(dir, '.git', 'config'), readFileSync(join(dir, '.git', 'config'), 'utf8') + text);
  assert.equal(stop(filtered('filter', appendConfig)), null, 'a repo whose config names a filter is passed without a word');
  const included = filtered('include', (dir, text) => {
    writeFileSync(join(dir, '.git', 'extra.cfg'), text);
    appendConfig(dir, '[include]\n\tpath = extra.cfg\n');
  });
  assert.equal(agentStop(included), null, 'a filter hidden behind include.path');

  const bare = join(realpathSync(mkdtempSync(join(tmpdir(), 'commit-gate-bare-'))), 'pkg');
  mkdirSync(join(bare, 'objects'), { recursive: true });
  mkdirSync(join(bare, 'refs', 'heads'), { recursive: true });
  writeFileSync(join(bare, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(bare, 'config'), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = .\n\tfsmonitor = ${markerScript(scripts, 'bare.sh', marker('bare'))}\n`);
  writeFileSync(join(bare, 'loose.txt'), 'x');
  assert.equal(stop(bare), null, 'a folder laid out like a bare repo is not a repository here');
  assert.equal(agentStop(bare, { agent_id: 'a3' }), null);

  const planted = makeRepo();
  git(planted, 'config', 'core.fsmonitor', markerScript(scripts, 'planted.sh', marker('planted')));
  writeFileSync(join(planted, 'base.txt'), 'changed');
  assert.equal(stop(makeRepo(), { cwd: planted }), null, 'git never runs in a folder the session only cd\'d into');

  assert.deepEqual(readdirSync(markers), [], 'no planted program ran');
});

test('a branch moved under its folder: the reason gives the sync command, never "commit them"; the command restores the folder', () => {
  const { stop } = gateSession();
  const dir = makeRepo();
  const old = git(dir, 'rev-parse', '--short', 'HEAD');
  const lane = addWorktree(dir, 'wt-lane', 'lane');
  commit(lane, 'one.txt');
  const tip = commit(lane, 'two.txt');
  git(lane, 'update-ref', 'refs/heads/main', tip);
  writeFileSync(join(dir, 'real-edit.txt'), 'mine'); // a real edit next to the phantom staged changes
  const short = git(dir, 'rev-parse', '--short', tip);
  const sync = `git -C ${dir} reset --soft ${old} && git -C ${dir} merge --ff-only ${short}`;
  assert.equal(stop(dir), `Branch main moved to ${short} under ${dir} while its index stayed at ${old} (2 commits): its staged changes `
    + `undo landed work, so never commit or stash them. Sync the folder: ${sync} (unstaged edits stay; it refuses rather than overwrite one).`);
  git(dir, 'reset', '-q', '--soft', old);
  git(dir, 'merge', '-q', '--ff-only', short);
  assert.equal(git(dir, 'status', '--porcelain'), '?? real-edit.txt', 'landed files back, the real edit kept');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), tip);
});

test('agents: each agent has its own once-per-state record; a read-only agent type is never told to commit', () => {
  const { home, agentStop } = gateSession();
  const dir = makeRepo();
  writeFileSync(join(dir, 'base.txt'), 'changed');
  assert.equal(agentStop(dir, { agent_id: 'reader-1', agent_type: 'Explore' }), null, 'built-in Explore');
  mkdirSync(join(home, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(home, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\ntools: Read, Grep, Glob, Bash\n---\nbody\n');
  writeFileSync(join(home, '.claude', 'agents', 'test-writer.md'), '---\nname: test-writer\ntools: Read, Bash, Write, Edit\n---\n');
  assert.equal(agentStop(dir, { agent_id: 'reader-2', agent_type: 'reviewer' }), null, 'an agent file whose tools cannot write');
  assert.equal(agentStop(dir, { agent_id: 'writer-1', agent_type: 'test-writer' }), dirtyReason(dir, 1));
  assert.equal(agentStop(dir, { agent_id: 'writer-2', agent_type: 'implementer' }), dirtyReason(dir, 1), 'the same state, another agent');
  assert.equal(agentStop(dir, { agent_id: 'writer-2', agent_type: 'implementer' }), null);
});

test(`decides in under ${SPEED_TARGET_MS} ms on a dirty repo with a lane`, () => {
  const dir = makeRepo();
  addWorktree(dir, 'wt-lane', 'lane');
  writeFileSync(join(dir, 'base.txt'), 'changed');
  const home = mkdtempSync(join(tmpdir(), 'commit-gate-home-'));
  const fastest = fastestMs(() => decide({ session_id: `s${Math.random().toString(36).slice(2)}`, cwd: dir }, { HOME: home, CLAUDE_PROJECT_DIR: dir }));
  assert.ok(fastest < SPEED_TARGET_MS, `took ${fastest.toFixed(1)} ms`);
});
