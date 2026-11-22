// Tests for home/hooks/lib/agent-pins.mjs: readPin (which file, which lines, the name pattern and size cap) and floorDrops (the order of
// model families and effort levels, unknown values never dropped). HOME points at a temp folder, so no real agent file is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { flooredAgentInput, floorDrops, readPin } from '../home/hooks/lib/agent-pins.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const OPUS_HIGH = '---\nname: worker\nmodel: claude-opus-5-5\neffort: high\n---\nbody\n';

/** A temp HOME and a temp project folder, each with a `.claude/agents` folder; HOME is restored after `body`. */
function withFolders(body) {
  const home = makeTempDir('pins-home-');
  const project = makeTempDir('pins-project-');
  for (const base of [home, project]) mkdirSync(join(base, '.claude', 'agents'), { recursive: true });
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    body({ homeAgents: join(home, '.claude', 'agents'), projectAgents: join(project, '.claude', 'agents'), home, project });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('readPin: the project agent file wins over the personal one, also when it pins nothing', () => {
  withFolders(({ homeAgents, projectAgents, project }) => {
    writeFileSync(join(homeAgents, 'worker.md'), OPUS_HIGH);
    assert.deepEqual(readPin('worker', project), { model: 'claude-opus-5-5', effort: 'high' });
    writeFileSync(join(projectAgents, 'worker.md'), '---\nname: worker\nmodel: sonnet\n---\n');
    assert.deepEqual(readPin('worker', project), { model: 'sonnet', effort: null });
    writeFileSync(join(projectAgents, 'worker.md'), '---\nname: worker\n---\n');
    assert.deepEqual(readPin('worker', project), { model: null, effort: null });
  });
});

test('readPin: CRLF reads as LF; quotes, a trailing comment and a repeated key; deeper lines are not pins', () => {
  withFolders(({ homeAgents, home }) => {
    writeFileSync(join(homeAgents, 'crlf.md'), OPUS_HIGH.replaceAll('\n', '\r\n'));
    assert.deepEqual(readPin('crlf', home), { model: 'claude-opus-5-5', effort: 'high' });
    writeFileSync(join(homeAgents, 'odd.md'), '---\nname: odd\nmodel: "opus" # pinned\neffort: low\neffort: \'max\'\nhooks:\n  model: haiku\n---\n');
    assert.deepEqual(readPin('odd', home), { model: 'opus', effort: 'max' });
  });
});

test('readPin: a missing file, no or empty frontmatter, a folder and a file over 64 KB give no pin', () => {
  withFolders(({ homeAgents, home }) => {
    assert.equal(readPin('missing', home), null);
    writeFileSync(join(homeAgents, 'plain.md'), 'model: haiku\n');
    assert.deepEqual(readPin('plain', home), { model: null, effort: null });
    writeFileSync(join(homeAgents, 'empty.md'), '---\n---\n');
    assert.deepEqual(readPin('empty', home), { model: null, effort: null });
    mkdirSync(join(homeAgents, 'folder.md'));
    assert.equal(readPin('folder', home), null);
    writeFileSync(join(homeAgents, 'huge.md'), OPUS_HIGH + 'x'.repeat(2 * 1024 * 1024));
    assert.equal(readPin('huge', home), null);
  });
});

test('readPin: a type outside the name pattern is refused before any path is joined, and nothing is written', () => {
  withFolders(({ home, project }) => {
    writeFileSync(join(home, 'x.md'), OPUS_HIGH); // where '../../x' would lead from the agents folder
    const before = readdirSync(home, { recursive: true }).sort();
    for (const type of ['../../x', '../x', 'a'.repeat(300), 'work\0er', 'Worker', '-worker', '', undefined, 42]) {
      assert.equal(readPin(type, project), null, String(type));
    }
    assert.deepEqual(readdirSync(home, { recursive: true }).sort(), before);
  });
});

test('floorDrops: a known value below a known pin is dropped; equal, higher, unknown or unpinned values stay', () => {
  const pin = { model: 'claude-opus-5-5', effort: 'high' };
  const none = { dropModel: false, dropEffort: false };
  assert.deepEqual(floorDrops({ model: 'sonnet', effort: 'low' }, pin), { dropModel: true, dropEffort: true });
  assert.deepEqual(floorDrops({ model: 'claude-haiku-5-5', effort: 'medium' }, pin), { dropModel: true, dropEffort: true });
  assert.deepEqual(floorDrops({ model: 'haiku' }, { model: 'sonnet', effort: null }), { dropModel: true, dropEffort: false });
  for (const call of [{ model: 'opus', effort: 'high' }, { model: 'claude-opus-5-5[1m]', effort: 'xhigh' }, { effort: 'max' },
    { model: 'fable', effort: 'ultra' }, { model: 'inherit' }, { model: 'claude-sonnet-5-5\u001b[0m' }, { model: 'sonnet-opus' },
    { effort: 'HIGH' }, { model: 'sonnet'.padEnd(150, 'x') }, { model: 42, effort: null }, {}]) {
    assert.deepEqual(floorDrops(call, pin), none, JSON.stringify(call));
  }
  assert.deepEqual(floorDrops({ model: 'haiku', effort: 'low' }, { model: null, effort: null }), none);
  assert.deepEqual(floorDrops({ model: 'haiku', effort: 'low' }, { model: 'fable', effort: 'ultra' }), none);
});

test('flooredAgentInput: a copy without the dropped keys, the input itself untouched; null when nothing drops', () => {
  withFolders(({ homeAgents, home }) => {
    writeFileSync(join(homeAgents, 'worker.md'), OPUS_HIGH);
    const input = { subagent_type: 'worker', prompt: 'p', model: 'sonnet', effort: 'high' };
    assert.deepEqual(flooredAgentInput(input, home), { subagent_type: 'worker', prompt: 'p', effort: 'high' });
    assert.equal(input.model, 'sonnet');
    assert.equal(flooredAgentInput({ subagent_type: 'worker', prompt: 'p' }, home), null);
    assert.equal(flooredAgentInput({ subagent_type: 'worker', model: 'opus' }, home), null);
    for (const bad of [null, undefined, 'worker', 7]) assert.equal(flooredAgentInput(bad, home), null);
  });
});
