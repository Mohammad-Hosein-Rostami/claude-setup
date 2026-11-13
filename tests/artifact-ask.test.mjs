// Tests for home/hooks/artifact-ask.mjs: publish and delete ask the owner (permissionDecision "ask", also in bypass
// mode), every other Artifact action and every other tool input passes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decideArtifact } from '../home/hooks/artifact-ask.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/artifact-ask.mjs', import.meta.url));

test('decideArtifact asks for publish (explicit or the default) and delete', () => {
  assert.match(decideArtifact({ file_path: '/x/a.html', icon: 'chart' }), /publish creates a hosted page/);
  assert.match(decideArtifact({ action: 'publish', file_path: '/x/a.html' }), /publish creates/);
  assert.match(decideArtifact({ action: 'publish', url: 'https://claude.ai/artifact/1', file_path: 'a.html' }), /updates https:\/\/claude\.ai\/artifact\/1/);
  assert.match(decideArtifact({ action: 'delete', url: 'https://claude.ai/artifact/1' }), /delete permanently removes/);
  assert.match(decideArtifact({}), /publish/);
});

test('decideArtifact passes read, list, open, pin, unpin, quickstart and bad input', () => {
  for (const action of ['read', 'list', 'open', 'pin', 'unpin', 'quickstart', 'something-new']) assert.equal(decideArtifact({ action }), undefined, action);
  for (const input of [null, undefined, 'publish', 5]) assert.equal(decideArtifact(input), undefined, String(input));
});

const run = (input) => spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8' });

test('hook contract: publish prints an ask decision and exits 0; read is silent; bad JSON is silent', () => {
  const ask = run(JSON.stringify({ tool_name: 'Artifact', tool_input: { action: 'publish', file_path: 'a.html' } }));
  assert.equal(ask.status, 0);
  const out = JSON.parse(ask.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, 'ask');
  for (const input of [JSON.stringify({ tool_input: { action: 'read', url: 'u' } }), 'not json', '', '{}']) {
    const r = run(input);
    assert.equal(r.status, 0, input);
    assert.equal(r.stdout + r.stderr, '', input);
  }
});
