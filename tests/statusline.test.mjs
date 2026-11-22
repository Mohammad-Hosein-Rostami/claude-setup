// Tests for home/statusline.mjs: the model name leads the session row, the last row, after its label (node:test, no dependencies).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './temp-dir-helpers.mjs';

const STATUSLINE = fileURLToPath(new URL('../home/statusline.mjs', import.meta.url));

async function render(model) {
  const home = makeTempDir('statusline-home-');
  const input = JSON.stringify({ model, rate_limits: { five_hour: {} } });
  return spawnSync(process.execPath, [STATUSLINE], { input, env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' }, encoding: 'utf8' }).stdout;
}

// Without a session there is no board: `git     loading`, then the session row led by its label and the model's name (spec R18).
const LEAD = (name) => new RegExp(`^git +loading\nsession +${name} · `, 'm');

test('the session block leads with the model\'s own name and no guessed tier label (direction B: `Opus 5.5 high`)', async () => {
  assert.match(await render({ id: 'claude-fable-5-2', display_name: 'Fable 5.2' }), LEAD('Fable 5\\.2'));
  assert.match(await render({ id: 'claude-opus-5-5', display_name: 'Opus 5.5' }), LEAD('Opus 5\\.5'));
  assert.match(await render({ id: 'claude-haiku-5-5', display_name: 'Haiku 5.5' }), LEAD('Haiku 5\\.5'));
  assert.match(await render({ id: 'claude-sonnet-5-5', display_name: 'Sonnet 5.5' }), LEAD('Sonnet 5\\.5'));
  const unknown = await render({ id: 'mystery', display_name: 'Mystery' });
  assert.match(unknown, LEAD('Mystery'));
  assert.doesNotMatch(unknown, /sonnet/i);
});
