// Tests for the hook wiring of settings/base.json: SessionStart covers a fork, and the retired stop-hook cap is gone from env.
// Read-only on the repo. (The blocking hooks are unwired: settings-full-access.test.mjs pins that no PreToolUse hook is left.)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BASE_SETTINGS = fileURLToPath(new URL('../settings/base.json', import.meta.url));
const settings = JSON.parse(readFileSync(BASE_SETTINGS, 'utf8'));
const SESSION_START_MATCHER = 'startup|resume|clear|compact|fork';

const entriesOf = (event) => settings.hooks[event];

test('env no longer sets CLAUDE_CODE_STOP_HOOK_BLOCK_CAP', () => {
  assert.equal(Object.hasOwn(settings.env, 'CLAUDE_CODE_STOP_HOOK_BLOCK_CAP'), false);
});

test(`a SessionStart entry has the matcher ${SESSION_START_MATCHER}`, () => {
  const matchers = entriesOf('SessionStart').map(({ matcher }) => matcher);
  assert.ok(matchers.includes(SESSION_START_MATCHER), JSON.stringify(matchers));
});
