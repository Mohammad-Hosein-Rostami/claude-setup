// Tests for home/statusline.mjs: the model tier label (node:test, no dependencies).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const STATUSLINE = fileURLToPath(new URL('../home/statusline.mjs', import.meta.url));

async function render(model) {
  const home = await mkdtemp(`${tmpdir()}/statusline-home-`);
  const input = JSON.stringify({ model, rate_limits: { five_hour: {} } });
  return spawnSync(process.execPath, [STATUSLINE], { input, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' }).stdout;
}

test('tier label follows the model, with fable and unknown distinct from sonnet', async () => {
  assert.match(await render({ id: 'claude-fable-5-2', display_name: 'Fable 5.2' }), /FABLE.* Fable 5\.2/);
  assert.match(await render({ id: 'claude-opus-5-5', display_name: 'Opus 5.5' }), /OPUS/);
  assert.match(await render({ id: 'claude-haiku-5-5', display_name: 'Haiku 5.5' }), /haiku/);
  assert.match(await render({ id: 'claude-sonnet-5-5', display_name: 'Sonnet 5.5' }), /sonnet/);
  const unknown = await render({ id: 'mystery', display_name: 'Mystery' });
  assert.match(unknown, /\?.* Mystery/);
  assert.doesNotMatch(unknown, /sonnet/);
});
