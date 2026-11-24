// Tests for home/hooks/lib/agent-pins.mjs: readPin (the file Claude Code loads: found by `name` in the project folders from the
// session folder up to the git root, the main checkout of a worktree and the personal folder; the name pattern; skipped files) and
// floorDrops (model families and versions, effort levels, unknown values never dropped). HOME is a temp folder: no real agent file is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { flooredAgentInput, floorDrops, pinVerdict, readPin } from '../home/hooks/lib/agent-pins.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

/** An agent file's text: `pins` are the extra frontmatter lines. */
const agentText = (name, pins = 'model: claude-opus-5-5\neffort: high\n') => `---\nname: ${name}\ndescription: works\n${pins}---\nbody\n`;
const OPUS_HIGH = agentText('worker');
const NO_ENV = {}; // no CLAUDE_CONFIG_DIR and no subagent defaults

/** A temp HOME and a temp project folder (a git repository), each with a `.claude/agents` folder; HOME is restored after `body`. */
function withFolders(body) {
  const home = makeTempDir('pins-home-');
  const project = makeTempDir('pins-project-');
  execFileSync('git', ['init', '-q', project]);
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
    assert.deepEqual(readPin('worker', project, NO_ENV), { model: 'claude-opus-5-5', effort: 'high' });
    writeFileSync(join(projectAgents, 'worker.md'), agentText('worker', 'model: sonnet\n'));
    assert.deepEqual(readPin('worker', project, NO_ENV), { model: 'sonnet', effort: null });
    writeFileSync(join(projectAgents, 'worker.md'), agentText('worker', ''));
    assert.deepEqual(readPin('worker', project, NO_ENV), { model: null, effort: null });
  });
});

test('readPin: a project folder above the session folder counts, up to the git root; the deepest one wins (R1)', () => {
  withFolders(({ homeAgents, projectAgents, project }) => {
    writeFileSync(join(homeAgents, 'worker.md'), agentText('worker', 'model: haiku\n'));
    writeFileSync(join(projectAgents, 'worker.md'), agentText('worker', 'model: opus\n'));
    const web = join(project, 'web');
    mkdirSync(join(web, 'src'), { recursive: true });
    assert.deepEqual(readPin('worker', join(web, 'src'), NO_ENV), { model: 'opus', effort: null });
    mkdirSync(join(web, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(web, '.claude', 'agents', 'worker.md'), agentText('worker', 'model: sonnet\n'));
    assert.deepEqual(readPin('worker', join(web, 'src'), NO_ENV), { model: 'sonnet', effort: null });
  });
});

test('readPin: a linked worktree with no agents folder at its root reads the main checkout\'s (R1)', () => {
  withFolders(({ projectAgents, project }) => {
    writeFileSync(join(projectAgents, 'worker.md'), agentText('worker', 'model: opus\n'));
    execFileSync('git', ['-C', project, 'commit', '-q', '--allow-empty', '-m', 'start'], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    const linked = join(makeTempDir('pins-linked-'), 'lane');
    execFileSync('git', ['-C', project, 'worktree', 'add', '-q', '-b', 'lane', linked]);
    assert.deepEqual(readPin('worker', linked, NO_ENV), { model: 'opus', effort: null });
  });
});

test('readPin: an agent is found by its frontmatter name in any .md file, also in a subfolder (R2)', () => {
  withFolders(({ homeAgents, projectAgents, project }) => {
    writeFileSync(join(homeAgents, 'visual-qa.md'), agentText('visual-qa', 'model: sonnet\n'));
    mkdirSync(join(projectAgents, 'team'));
    writeFileSync(join(projectAgents, 'team', 'qa.md'), agentText('visual-qa', 'model: opus\n'));
    writeFileSync(join(projectAgents, 'worker.md'), agentText('other', 'model: haiku\n')); // named `other`: no agent `worker`
    assert.deepEqual(readPin('visual-qa', project, NO_ENV), { model: 'opus', effort: null });
    assert.equal(readPin('worker', project, NO_ENV), null);
  });
});

test('readPin: a file Claude Code skips does not hide the personal pin (R3); an uncertain one gives no pin', () => {
  withFolders(({ homeAgents, projectAgents, project }) => {
    writeFileSync(join(homeAgents, 'worker.md'), OPUS_HIGH);
    const skipped = ['---\ndescription: no name\nmodel: haiku\n---\n', '---\nname: worker\nmodel: haiku\n---\n', 'model: haiku\n',
      '---\nname: worker\ndescription: never closed\nmodel: haiku\n', agentText('worker', 'model: haiku\n') + 'x'.repeat(1048576)];
    for (const text of skipped) {
      writeFileSync(join(projectAgents, 'worker.md'), text);
      assert.deepEqual(readPin('worker', project, NO_ENV), { model: 'claude-opus-5-5', effort: 'high' }, text.slice(0, 40));
    }
    mkdirSync(join(projectAgents, 'folder.md'));
    writeFileSync(join(projectAgents, 'worker.md'), agentText('worker', 'model: haiku\n') + 'x'.repeat(100 * 1024)); // loaded: 100 KB
    assert.deepEqual(readPin('worker', project, NO_ENV), { model: 'haiku', effort: null });
    writeFileSync(join(projectAgents, 'worker.md'), '---\nname: [worker]\ndescription: d\n---\n'); // not plain: may be the agent
    assert.equal(readPin('worker', project, NO_ENV), null);
    writeFileSync(join(projectAgents, 'worker.md'), agentText('worker', 'model: opus\n'));
    writeFileSync(join(projectAgents, 'copy.md'), agentText('worker', 'model: haiku\n')); // two pins for one type: which loads is unknown
    assert.equal(readPin('worker', project, NO_ENV), null);
  });
});

test('readPin: CRLF reads as LF; quotes, a trailing comment and a repeated key; deeper lines are not pins', () => {
  withFolders(({ homeAgents, home }) => {
    writeFileSync(join(homeAgents, 'crlf.md'), agentText('crlf').replaceAll('\n', '\r\n'));
    assert.deepEqual(readPin('crlf', home, NO_ENV), { model: 'claude-opus-5-5', effort: 'high' });
    writeFileSync(join(homeAgents, 'odd.md'), agentText('odd', 'model: "opus" # pinned\neffort: low\neffort: \'max\'\nhooks:\n  model: haiku\n'));
    assert.deepEqual(readPin('odd', home, NO_ENV), { model: 'opus', effort: 'max' });
  });
});

test('readPin: CLAUDE_CONFIG_DIR moves the personal folder', () => {
  withFolders(({ home }) => {
    const config = makeTempDir('pins-config-');
    mkdirSync(join(config, 'agents'));
    writeFileSync(join(config, 'agents', 'worker.md'), OPUS_HIGH);
    assert.equal(readPin('worker', home, NO_ENV), null);
    assert.deepEqual(readPin('worker', home, { CLAUDE_CONFIG_DIR: config }), { model: 'claude-opus-5-5', effort: 'high' });
  });
});

test('readPin: a type outside the name pattern is refused before any path is joined, and nothing is written', () => {
  withFolders(({ home, project }) => {
    writeFileSync(join(home, 'x.md'), OPUS_HIGH); // where '../../x' would lead from the agents folder
    const before = readdirSync(home, { recursive: true }).sort();
    for (const type of ['../../x', '../x', 'a'.repeat(300), 'work\0er', 'Worker', '-worker', '', undefined, 42]) {
      assert.equal(readPin(type, project, NO_ENV), null, String(type));
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

test('floorDrops: inside a family a full id ranks by version; an alias ranks equal to any version (R5)', () => {
  const pin = { model: 'claude-opus-5-5', effort: null };
  for (const lower of ['claude-opus-4-1', 'claude-opus-4-1-20250805', 'claude-opus-4-20250514', 'claude-opus-5-1', 'claude-3-opus-20240229']) {
    assert.equal(floorDrops({ model: lower }, pin).dropModel, true, lower);
  }
  for (const kept of ['claude-opus-5-5', 'claude-opus-5-6', 'claude-opus-6', 'opus', 'claude-opus-5-5[1m]']) {
    assert.equal(floorDrops({ model: kept }, pin).dropModel, false, kept);
  }
  assert.equal(floorDrops({ model: 'claude-opus-4-1' }, { model: 'opus', effort: null }).dropModel, false); // the alias's version is not known
  assert.equal(floorDrops({ model: 'claude-3-5-sonnet-20241022' }, { model: 'claude-sonnet-4-5', effort: null }).dropModel, true);
});

test('flooredAgentInput: a copy without the dropped keys, the input itself untouched; null when nothing drops', () => {
  withFolders(({ homeAgents, home }) => {
    writeFileSync(join(homeAgents, 'worker.md'), OPUS_HIGH);
    const input = { subagent_type: 'worker', prompt: 'p', model: 'sonnet', effort: 'high' };
    assert.deepEqual(flooredAgentInput(input, home, NO_ENV), { subagent_type: 'worker', prompt: 'p', effort: 'high' });
    assert.equal(input.model, 'sonnet');
    assert.equal(flooredAgentInput({ subagent_type: 'worker', prompt: 'p' }, home, NO_ENV), null);
    assert.equal(flooredAgentInput({ subagent_type: 'worker', model: 'opus' }, home, NO_ENV), null);
    for (const bad of [null, undefined, 'worker', 7]) assert.equal(flooredAgentInput(bad, home, NO_ENV), null);
  });
});

test('flooredAgentInput: a file without model or effort is floored at the subagent defaults Claude Code gives it (R4)', () => {
  withFolders(({ homeAgents, projectAgents, project }) => {
    writeFileSync(join(homeAgents, 'worker.md'), OPUS_HIGH);
    writeFileSync(join(projectAgents, 'worker.md'), agentText('worker', ''));
    const env = { CLAUDE_CODE_SUBAGENT_MODEL: 'claude-sonnet-5-5', CLAUDE_CODE_SUBAGENT_EFFORT: 'medium' };
    assert.deepEqual(flooredAgentInput({ subagent_type: 'worker', model: 'haiku', effort: 'low' }, project, env), { subagent_type: 'worker' });
    assert.equal(flooredAgentInput({ subagent_type: 'worker', model: 'sonnet', effort: 'medium' }, project, env), null);
    assert.equal(flooredAgentInput({ subagent_type: 'worker', model: 'haiku' }, project, NO_ENV), null); // no default: the lead's model
    writeFileSync(join(projectAgents, 'worker.md'), agentText('worker', 'model: inherit\n'));
    assert.equal(flooredAgentInput({ subagent_type: 'worker', model: 'haiku' }, project, env), null); // inherit: the lead's, not known
  });
});

test('pinVerdict: found, none (no file, a plugin type, a capitalised built-in) and unsure are told apart; an unreadable file throws', (t) => {
  withFolders(({ homeAgents, projectAgents, project }) => {
    writeFileSync(join(homeAgents, 'worker.md'), OPUS_HIGH);
    assert.deepEqual(pinVerdict('worker', project, NO_ENV), { state: 'found', pin: { model: 'claude-opus-5-5', effort: 'high' } });
    for (const type of ['nobody', 'some-plugin:agent', 'Explore', '../x', undefined]) assert.deepEqual(pinVerdict(type, project, NO_ENV), { state: 'none' }, String(type));
    writeFileSync(join(projectAgents, 'odd.md'), '---\nname: [worker]\ndescription: d\n---\n');
    assert.deepEqual(pinVerdict('worker', project, NO_ENV), { state: 'unsure' });
    assert.equal(readPin('worker', project, NO_ENV), null, 'readPin keeps its answer: no pin');
    if (typeof process.getuid === 'function' && process.getuid() === 0) return t.diagnostic('not run: root reads a mode 000 file');
    writeFileSync(join(projectAgents, 'odd.md'), agentText('worker'));
    chmodSync(join(projectAgents, 'odd.md'), 0);
    try {
      assert.throws(() => pinVerdict('worker', project, NO_ENV), { code: 'EACCES' });
    } finally {
      chmodSync(join(projectAgents, 'odd.md'), 0o600);
    }
  });
});
