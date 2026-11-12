// Tests for home/hooks/agent-memory-only.mjs: memory-path check and the deny/allow exit-code contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMemoryPath } from '../home/hooks/agent-memory-only.mjs';

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
