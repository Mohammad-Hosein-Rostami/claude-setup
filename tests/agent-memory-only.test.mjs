// Tests for home/hooks/agent-memory-only.mjs: memory-path check and the deny/allow exit-code contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMemoryPath, isReportsPath, isScratchpadPath } from '../home/hooks/agent-memory-only.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/agent-memory-only.mjs', import.meta.url));
const MEMORY = join(homedir(), '.claude', 'agent-memory');

test('isMemoryPath allows paths inside agent-memory', () => {
  assert.equal(isMemoryPath(join(MEMORY, 'reviewer', 'notes.md'), '/anywhere'), true);
  assert.equal(isMemoryPath('reviewer/notes.md', MEMORY), true);
});

test('isMemoryPath rejects other paths, traversal, prefix lookalikes and bad input', () => {
  assert.equal(isMemoryPath('/etc/passwd', '/anywhere'), false);
  assert.equal(isMemoryPath(join(MEMORY, '..', 'settings.json'), '/anywhere'), false);
  assert.equal(isMemoryPath('../settings.json', MEMORY), false);
  assert.equal(isMemoryPath(`${MEMORY}-evil/x.md`, '/anywhere'), false);
  assert.equal(isMemoryPath(MEMORY, '/anywhere'), false); // the directory itself is not a note
  assert.equal(isMemoryPath('relative.md', resolve('/work')), false);
  for (const bad of [undefined, null, 42, '', {}]) assert.equal(isMemoryPath(bad, '/anywhere'), false);
});

const run = (input) => spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8' });

test('hook allows a memory write silently (exit 0)', () => {
  const r = run(JSON.stringify({ cwd: '/work', tool_input: { file_path: join(MEMORY, 'reviewer', 'n.md') } }));
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
});

test('hook denies other writes and fails closed on unreadable input (exit 2 + reason)', () => {
  for (const input of [JSON.stringify({ cwd: '/work', tool_input: { file_path: '/work/src/a.ts' } }), 'not json', '', '{}']) {
    const r = run(input);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Blocked by agent-memory-only/);
  }
});

// A real temp tree: <root>/claude-<uid>/<project>/<session>/scratchpad, so realpath and symlink checks are exercised.
const UID_DIR = typeof process.getuid === 'function' ? `claude-${process.getuid()}` : 'claude';
const SESSION = 'sess-A';
const scratch = (root, project = 'proj', session = SESSION) => {
  const dir = join(root, UID_DIR, project, session, 'scratchpad');
  mkdirSync(dir, { recursive: true });
  return dir;
};
const newRoot = () => realpathSync(mkdtempSync(join(tmpdir(), 'scratch-root-')));
const allows = (root, file, session = SESSION, userDir = UID_DIR) => isScratchpadPath(file, '/anywhere', session, { roots: [root], userDir });

test('isScratchpadPath allows files in this session scratchpad, new or nested, absolute or relative', () => {
  const root = newRoot();
  const pad = scratch(root);
  assert.equal(allows(root, join(pad, 'lens-1.md')), true);
  assert.equal(allows(root, join(pad, 'sub', 'deeper', 'lens.md')), true);
  assert.equal(isScratchpadPath('lens.md', pad, SESSION, { roots: [root], userDir: UID_DIR }), true);
});

test('isScratchpadPath rejects .. traversal, the directory itself and look-alike directory names', () => {
  const root = newRoot();
  const pad = scratch(root);
  assert.equal(allows(root, pad), false);
  assert.equal(allows(root, join(pad, '..', 'x.md')), false);
  assert.equal(allows(root, join(pad, 'a', '..', '..', 'x.md')), false);
  assert.equal(allows(root, join(root, UID_DIR, 'proj', SESSION, 'scratchpad-evil', 'a.md')), false);
  assert.equal(allows(root, join(root, UID_DIR, SESSION, 'scratchpad', 'a.md')), false); // project level missing
  assert.equal(allows(root, join(root, UID_DIR, 'a', 'b', SESSION, 'scratchpad', 'a.md')), false); // one level too deep
});

test('isScratchpadPath rejects another session and another uid', () => {
  const root = newRoot();
  const other = scratch(root, 'proj', 'sess-B');
  const otherUid = join(root, 'claude-99999999', 'proj', SESSION, 'scratchpad');
  mkdirSync(otherUid, { recursive: true });
  assert.equal(allows(root, join(other, 'a.md')), false);
  assert.equal(allows(root, join(otherUid, 'a.md')), false);
  assert.equal(allows(root, join(scratch(root), 'a.md'), 'sess-B'), false);
  const file = join(scratch(root), 'a.md');
  for (const bad of [null, '', '../x', 'a/b', 42]) assert.equal(allows(root, file, bad), false);
  assert.equal(isScratchpadPath(file, '/anywhere', undefined, { roots: [root], userDir: UID_DIR }), false);
});

test('isScratchpadPath rejects symlinks that leave the scratchpad (file or directory), allows one that stays inside', { skip: process.platform === 'win32' }, () => {
  const root = newRoot();
  const pad = scratch(root);
  const outside = mkdtempSync(join(tmpdir(), 'scratch-outside-'));
  symlinkSync(outside, join(pad, 'dirlink'));
  symlinkSync(join(outside, 'secret'), join(pad, 'filelink'));
  mkdirSync(join(pad, 'real'));
  symlinkSync(join(pad, 'real'), join(pad, 'inside'));
  assert.equal(allows(root, join(pad, 'dirlink', 'new.md')), false);
  assert.equal(allows(root, join(pad, 'filelink')), false);
  assert.equal(allows(root, join(pad, 'inside', 'ok.md')), true);
  // the session directory itself linked out
  const linked = join(root, UID_DIR, 'proj', 'sess-C');
  mkdirSync(join(outside, 'scratchpad'), { recursive: true });
  symlinkSync(outside, linked);
  assert.equal(allows(root, join(linked, 'scratchpad', 'a.md'), 'sess-C'), false);
});

test('isScratchpadPath rejects other temp files, repo paths and bad input', () => {
  const root = newRoot();
  assert.equal(allows(root, join(root, 'other', 'p', SESSION, 'scratchpad', 'a.md')), false);
  assert.equal(allows(root, '/work/src/scratchpad/a.md'), false);
  assert.equal(allows(root, join(homedir(), '.claude', 'settings.json')), false);
  for (const bad of [undefined, null, 42, '', {}]) assert.equal(allows(root, bad), false);
});

test('hook allows a write into the input session scratchpad only', { skip: process.platform === 'win32' }, (t) => {
  const pad = scratch('/tmp', `proj-${process.pid}`, SESSION);
  t.after(() => rmSync(join('/tmp', UID_DIR, `proj-${process.pid}`), { recursive: true, force: true }));
  const ask = (file, sessionId = SESSION) => run(JSON.stringify({ cwd: '/work', session_id: sessionId, tool_input: { file_path: file } }));
  const ok = ask(join(pad, 'lens.md'));
  assert.equal(ok.status, 0);
  assert.equal(ok.stderr, '');
  assert.equal(ask(join(pad, 'lens.md'), 'sess-other').status, 2);
  assert.equal(ask(join(pad, '..', 'x.md')).status, 2);
  assert.equal(ask('/work/src/a.ts').status, 2);
  assert.equal(run(JSON.stringify({ cwd: '/work', tool_input: { file_path: join(pad, 'lens.md') } })).status, 2); // no session id
});

// The reports folder: <home>/Desktop/claude-setup-reports/. A review agent may add a NEW file there, never overwrite one.
const newReportsRoot = () => {
  const root = join(realpathSync(mkdtempSync(join(tmpdir(), 'reports-root-'))), 'claude-setup-reports');
  mkdirSync(join(root, 'round1'), { recursive: true });
  return root;
};

test('isReportsPath allows a new file in the reports folder, nested or relative', () => {
  const root = newReportsRoot();
  assert.equal(isReportsPath(join(root, 'review.md'), '/anywhere', { root }), true);
  assert.equal(isReportsPath(join(root, 'round1', 'new', 'review.md'), '/anywhere', { root }), true);
  assert.equal(isReportsPath('round1/review.md', root, { root }), true);
});

test('isReportsPath refuses an existing file, the folder itself, .. traversal, look-alikes and bad input', () => {
  const root = newReportsRoot();
  writeFileSync(join(root, 'round1', 'old.md'), 'someone else wrote this');
  assert.equal(isReportsPath(join(root, 'round1', 'old.md'), '/anywhere', { root }), false);
  assert.equal(isReportsPath(root, '/anywhere', { root }), false);
  assert.equal(isReportsPath(join(root, '..', 'x.md'), '/anywhere', { root }), false);
  assert.equal(isReportsPath(`${root}-evil/x.md`, '/anywhere', { root }), false);
  assert.equal(isReportsPath('/work/src/a.ts', '/anywhere', { root }), false);
  for (const bad of [undefined, null, 42, '', {}]) assert.equal(isReportsPath(bad, '/anywhere', { root }), false);
});

test('isReportsPath refuses symlinks that leave the folder', { skip: process.platform === 'win32' }, () => {
  const root = newReportsRoot();
  const outside = mkdtempSync(join(tmpdir(), 'reports-outside-'));
  symlinkSync(outside, join(root, 'dirlink'));
  symlinkSync(join(outside, 'new.md'), join(root, 'danglinglink'));
  assert.equal(isReportsPath(join(root, 'dirlink', 'new.md'), '/anywhere', { root }), false);
  assert.equal(isReportsPath(join(root, 'danglinglink'), '/anywhere', { root }), false);
});

test('hook allows a new file under <HOME>/Desktop/claude-setup-reports and refuses an existing one or a repo path', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'fake-home-')));
  const reports = join(home, 'Desktop', 'claude-setup-reports');
  mkdirSync(reports, { recursive: true });
  writeFileSync(join(reports, 'old.md'), 'x');
  const ask = (file) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: '/work', tool_input: { file_path: file } }), encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
  assert.equal(ask(join(reports, 'new.md')).status, 0);
  assert.equal(ask(join(reports, 'old.md')).status, 2);
  assert.equal(ask(join(home, 'Desktop', 'some-repo', 'reports', 'new.md')).status, 2);
});
