// Tests for home/hooks/mode.mjs: pure helpers and the per-session guarantee (node:test, no dependencies).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findOwnerPid, isMode, isStale, parseModeArg } from '../home/hooks/mode.mjs';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

test('parseModeArg takes the first word, lowercased', () => {
  assert.equal(parseModeArg('  HIGH now'), 'high');
  assert.equal(parseModeArg(''), '');
  assert.equal(parseModeArg(undefined), '');
});

test('isMode accepts only the three modes', () => {
  assert.ok(isMode('normal') && isMode('medium') && isMode('high'));
  assert.ok(!isMode('bogus') && !isMode(undefined) && !isMode(''));
});

test('isStale flips after 14 days', () => {
  const now = Date.now();
  assert.equal(isStale(now - 13 * MS_PER_DAY, now), false);
  assert.equal(isStale(now - 15 * MS_PER_DAY, now), true);
});

const HOOK = new URL('../home/hooks/mode.mjs', import.meta.url).pathname;

function runHook(home, env, input) {
  return spawnSync('node', [HOOK], { input: JSON.stringify(input), env: { ...process.env, HOME: home, USERPROFILE: home, ...env }, encoding: 'utf8' });
}

test('SessionStart and /mode leave settings.json untouched and record only the session state', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mode-home-'));
  await mkdir(join(home, '.claude'), { recursive: true });
  const settings = join(home, '.claude', 'settings.json');
  const original = '{"a":1,\n"b":[2]}\n';
  await writeFile(settings, original);
  const start = runHook(home, { CLAUDE_MODE: 'high' }, { hook_event_name: 'SessionStart', session_id: 's1', source: 'startup' });
  const switched = runHook(home, { CLAUDE_MODE: 'high' }, { hook_event_name: 'UserPromptExpansion', session_id: 's1', command_name: 'mode', command_args: 'normal' });
  assert.equal(await readFile(settings, 'utf8'), original);
  assert.equal((await readFile(join(home, '.claude', 'state', 'modes', 's1'), 'utf8')).trim(), 'normal');
  assert.match(switched.stdout, /Mode switched to normal \(this session only\)\./);
  assert.doesNotMatch(start.stdout + switched.stdout, /fast/i);
});

test('findOwnerPid walks up to the claude process', () => {
  const tree = { 30: { ppid: 20, command: '/bin/sh' }, 20: { ppid: 10, command: '/Users/x/.local/bin/claude' } };
  assert.equal(findOwnerPid(30, (pid) => tree[pid]), 20);
});

test('findOwnerPid gives up without a claude ancestor or on lookup failure', () => {
  const tree = { 30: { ppid: 20, command: 'sh' }, 20: { ppid: 1, command: 'login' } };
  assert.equal(findOwnerPid(30, (pid) => tree[pid]), undefined);
  assert.equal(findOwnerPid(30, () => undefined), undefined);
});

// The process-keyed state needs a `claude` ancestor (true when the suite runs inside Claude Code).
function hasClaudeAncestor() {
  if (process.platform === 'win32') return false;
  const lookup = (pid) => {
    const out = spawnSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
    const match = /^(\d+)\s+(.+)$/.exec(out);
    return match ? { ppid: Number(match[1]), command: match[2] } : undefined;
  };
  return findOwnerPid(process.pid, lookup) !== undefined;
}

test('a mode set with /mode survives /clear (new session id, same process) but not a new process', { skip: !hasClaudeAncestor() && 'no claude ancestor process' }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'mode-home-'));
  const env = { CLAUDE_MODE: 'medium' };
  runHook(home, env, { hook_event_name: 'UserPromptExpansion', session_id: 'a1', command_name: 'mode', command_args: 'high' });
  const afterClear = runHook(home, env, { hook_event_name: 'SessionStart', session_id: 'a2', source: 'clear' });
  const freshProcess = runHook(home, env, { hook_event_name: 'SessionStart', session_id: 'b1', source: 'startup' });
  const resumed = runHook(home, env, { hook_event_name: 'UserPromptSubmit', session_id: 'a1' });
  assert.match(afterClear.stdout, /^Mode: high/);
  assert.match(freshProcess.stdout, /^Mode: medium/);
  assert.match(resumed.stdout, /Mode: high/);
});


test('a resumed session keeps its saved mode unless launched with an explicit mode', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mode-home-'));
  const start = (env, id, source) => runHook(home, env, { hook_event_name: 'SessionStart', session_id: id, source }).stdout;
  start({ CLAUDE_MODE: 'high' }, 'r1', 'startup');
  assert.match(start({ CLAUDE_MODE: '' }, 'r1', 'resume'), /^Mode: high/);
  assert.match(start({ CLAUDE_MODE: 'normal' }, 'r1', 'resume'), /^Mode: normal/);
  assert.match(start({ CLAUDE_MODE: '' }, 'r1', 'resume'), /^Mode: normal/);
  assert.match(start({ CLAUDE_MODE: '' }, 'unknown', 'resume'), /^Mode: medium/);
});

test('compact keeps the session mode over the launch env', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mode-home-'));
  runHook(home, { CLAUDE_MODE: 'high' }, { hook_event_name: 'UserPromptExpansion', session_id: 'c1', command_name: 'mode', command_args: 'normal' });
  const compacted = runHook(home, { CLAUDE_MODE: 'high' }, { hook_event_name: 'SessionStart', session_id: 'c1', source: 'compact' });
  assert.match(compacted.stdout, /^Mode: normal/);
});

test('/mode reports a failed save instead of claiming the switch', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mode-home-'));
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(join(home, '.claude', 'state'), 'not a directory');
  const out = runHook(home, {}, { hook_event_name: 'UserPromptExpansion', session_id: 'f1', command_name: 'mode', command_args: 'high' });
  assert.match(out.stdout, /Mode NOT switched/);
  assert.equal(out.status, 0);
});

test('an unsafe session_id is never used as a file name', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mode-home-'));
  const out = runHook(home, {}, { hook_event_name: 'UserPromptExpansion', session_id: '../evil', command_name: 'mode', command_args: 'high' });
  assert.match(out.stdout, /Mode NOT switched/);
  await assert.rejects(readFile(join(home, '.claude', 'state', 'evil'), 'utf8'));
  await assert.rejects(readFile(join(home, '.claude', 'state', 'modes', '..', 'evil'), 'utf8'));
});
