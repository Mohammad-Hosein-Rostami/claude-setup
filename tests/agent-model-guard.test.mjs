// Tests for home/hooks/agent-model-guard.mjs: guardedAgentInput table, the stdin/stdout contract of the hook and its pin floor
// (a temp HOME holds the session's mode file, so the real ~/.claude state is never read).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardedAgentInput } from '../home/hooks/agent-model-guard.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/agent-model-guard.mjs', import.meta.url));
const BASE = { description: 'look', prompt: 'find x' };

test('guardedAgentInput: Explore without model gets sonnet, Plan gets opus (the same in every mode)', () => {
  assert.deepEqual(guardedAgentInput({ ...BASE, subagent_type: 'Explore' }), { ...BASE, subagent_type: 'Explore', model: 'sonnet' });
  assert.deepEqual(guardedAgentInput({ ...BASE, subagent_type: 'Plan' }), { ...BASE, subagent_type: 'Plan', model: 'opus' });
});

test('guardedAgentInput: general-purpose and a call with no subagent_type get sonnet', () => {
  assert.deepEqual(guardedAgentInput({ ...BASE }), { ...BASE, model: 'sonnet' });
  assert.deepEqual(guardedAgentInput({ ...BASE, subagent_type: 'general-purpose' }), { ...BASE, subagent_type: 'general-purpose', model: 'sonnet' });
});

test('guardedAgentInput: an explicit model is kept', () => {
  assert.equal(guardedAgentInput({ ...BASE, subagent_type: 'Explore', model: 'haiku' }), null);
  assert.equal(guardedAgentInput({ ...BASE, subagent_type: 'Plan', model: 'fable' }), null);
  assert.equal(guardedAgentInput({ ...BASE, subagent_type: 'Plan', model: 'sonnet' }), null);
  assert.equal(guardedAgentInput({ ...BASE, model: 'opus' }), null);
});

test('guardedAgentInput: an empty model counts as absent (it would inherit the lead)', () => {
  assert.equal(guardedAgentInput({ ...BASE, subagent_type: 'Explore', model: '' }).model, 'sonnet');
  assert.equal(guardedAgentInput({ ...BASE, subagent_type: 'Plan', model: '' }).model, 'opus');
  assert.equal(guardedAgentInput({ ...BASE, model: '' }).model, 'sonnet');
});

test('guardedAgentInput: forks, the repo agents (they pin their own model) and odd input are untouched', () => {
  assert.equal(guardedAgentInput({ ...BASE, subagent_type: 'fork' }), null);
  for (const type of ['lex-scout', 'security-auditor', 'lex', 'tess-review', 'dev', 'toString', 'some-plugin:agent']) {
    assert.equal(guardedAgentInput({ ...BASE, subagent_type: type }), null);
  }
  for (const bad of [undefined, null, 'Explore', 42]) assert.equal(guardedAgentInput(bad), null);
});

// The hook runs in a temp HOME with the session's mode file and no agent files.
function run(mode, stdin) {
  const home = makeTempDir('model-guard-');
  mkdirSync(join(home, '.claude', 'state', 'modes'), { recursive: true });
  writeFileSync(join(home, '.claude', 'state', 'modes', 'sess1'), `${mode}\n`);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CLAUDE_MODE;
  return spawnSync(process.execPath, [HOOK], { input: stdin, encoding: 'utf8', env, cwd: home });
}

test('hook: a Plan call without model gets opus in all five modes; an explicit model wins', () => {
  const plan = (extra) => JSON.stringify({ session_id: 'sess1', tool_input: { ...BASE, subagent_type: 'Plan', ...extra } });
  for (const mode of ['normal', 'medium', 'high', 'extra-high', 'ultra-high']) {
    assert.equal(JSON.parse(run(mode, plan({})).stdout).hookSpecificOutput.updatedInput.model, 'opus', mode);
    assert.equal(run(mode, plan({ model: 'sonnet' })).stdout, '', `${mode}: an explicit model is kept, so nothing is rewritten`);
  }
});

test('hook: ultra-high Explore without model prints an allow decision with the full updated input', () => {
  const toolInput = { ...BASE, subagent_type: 'Explore' };
  const r = run('ultra-high', JSON.stringify({ session_id: 'sess1', tool_name: 'Agent', tool_input: toolInput }));
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...toolInput, model: 'sonnet' } },
  });
});

test('hook: medium mode general-purpose gets sonnet too', () => {
  const toolInput = { ...BASE, subagent_type: 'general-purpose' };
  const r = run('medium', JSON.stringify({ session_id: 'sess1', tool_input: toolInput }));
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.updatedInput.model, 'sonnet');
});

test('hook: a long non-ASCII prompt reaches the agent intact (stdin is decoded once, not chunk by chunk)', () => {
  const toolInput = { ...BASE, subagent_type: 'Explore', prompt: 'سلام دنیا، این یک آزمایش است. '.repeat(10000) }; // about 530 KB, mostly 2-byte characters: many 64 KB stdin chunks
  const r = run('medium', JSON.stringify({ session_id: 'sess1', tool_input: toolInput }));
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.updatedInput.prompt, toolInput.prompt);
});

test('hook: explicit model, a fork, a pinned repo agent and bad JSON exit 0 with no output', () => {
  const explore = { session_id: 'sess1', tool_input: { ...BASE, subagent_type: 'Explore', model: 'haiku' } };
  const asType = (subagent_type) => JSON.stringify({ ...explore, tool_input: { ...BASE, subagent_type } });
  for (const [mode, stdin] of [['ultra-high', JSON.stringify(explore)], ['medium', asType('fork')], ['medium', asType('security-auditor')], ['ultra-high', 'not json']]) {
    const r = run(mode, stdin);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
});

// Pin floor (lib/agent-pins.mjs): the repo's own dev and dev-ui files are copied into a temp HOME, so the test reads
// the pins that ship. No session_id: the launch-record gates stay out of these calls.
const AGENTS = fileURLToPath(new URL('../home/agents/', import.meta.url));

function runWithAgents(toolInput, prepare = () => {}) {
  const home = makeTempDir('pin-floor-');
  const agents = join(home, '.claude', 'agents');
  mkdirSync(agents, { recursive: true });
  for (const name of ['dev', 'dev-ui']) copyFileSync(join(AGENTS, `${name}.md`), join(agents, `${name}.md`));
  prepare(agents);
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SUBAGENT_MODEL: 'claude-sonnet-5-5' };
  delete env.CLAUDE_CONFIG_DIR; // the personal folder is the temp HOME's
  delete env.CLAUDE_CODE_SUBAGENT_EFFORT;
  return spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_input: toolInput }), encoding: 'utf8', env, cwd: home });
}

test('hook: a per-call model or effort below the agent file pin is left out; an equal, unknown or unpinned value passes', () => {
  const lower = runWithAgents({ ...BASE, subagent_type: 'dev', model: 'sonnet' });
  assert.equal(lower.status, 0);
  assert.deepEqual(JSON.parse(lower.stdout).hookSpecificOutput, {
    hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...BASE, subagent_type: 'dev' },
  });
  const effort = JSON.parse(runWithAgents({ ...BASE, subagent_type: 'dev-ui', effort: 'low', prompt: 'MATRIX: none: a one-file copy tweak' }).stdout);
  assert.deepEqual(effort.hookSpecificOutput.updatedInput, { ...BASE, subagent_type: 'dev-ui', prompt: 'MATRIX: none: a one-file copy tweak' });
  for (const kept of [{ subagent_type: 'dev', model: 'opus' }, { subagent_type: 'dev', model: 'inherit' },
    { subagent_type: 'dev', effort: 'max' }, { subagent_type: '../x', model: 'haiku' }, { subagent_type: 'lex-scout', model: 'haiku' }]) {
    const r = runWithAgents({ ...BASE, ...kept });
    assert.equal(r.status, 0, JSON.stringify(kept));
    assert.equal(r.stdout, '', JSON.stringify(kept));
    assert.equal(r.stderr, '', JSON.stringify(kept));
  }
});

const FABLE_REASON = 'Not started: Fable is never used for an agent (the owner chooses it by hand only)';
const deniedReason = (run) => {
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny');
  return out.permissionDecisionReason;
};

test('hook: a per-call Fable model (the alias or any id, any case) is denied every time with a one-line reason to leave model out', () => {
  for (const model of ['fable', 'Fable', 'FABLE', 'claude-fable-5', 'claude-fable-5[1m]', 'us.anthropic.claude-fable-5-v1']) {
    for (const subagent_type of ['dev', 'lex-scout', 'Explore', 'Plan', 'general-purpose', 'some-plugin:agent', undefined]) {
      for (let send = 0; send < 2; send += 1) {
        const reason = deniedReason(runWithAgents({ ...BASE, subagent_type, model }));
        assert.equal(reason, `${FABLE_REASON}: leave \`model\` out of the Agent call (it was \`${model}\`).`, `${subagent_type} ${model} send ${send}`);
        assert.doesNotMatch(reason, /\n/, 'one line');
      }
    }
  }
});

test('hook: an agent file that pins Fable is denied when the call names no model; a call model other than Fable outranks the file', () => {
  const pinFable = (agents) => writeFileSync(join(agents, 'writer.md'), '---\nname: writer\ndescription: test agent\nmodel: claude-fable-5\n---\nbody\n');
  const reason = deniedReason(runWithAgents({ ...BASE, subagent_type: 'writer' }, pinFable));
  assert.equal(reason, `${FABLE_REASON}: the \`writer\` agent file pins \`claude-fable-5\`; change its \`model\` line, and leave \`model\` out of the Agent call.`);
  const outranked = runWithAgents({ ...BASE, subagent_type: 'writer', model: 'opus' }, pinFable);
  assert.deepEqual([outranked.status, outranked.stdout, outranked.stderr], [0, '', ''], 'the call runs on opus');
});

test('hook: the shipped agent files pin no Fable, so a plain call to each runs', () => {
  for (const name of ['dev', 'dev-ui']) {
    const run = runWithAgents({ ...BASE, subagent_type: name, prompt: 'MATRIX: none: a one-file copy tweak' });
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stdout, /Fable/, name);
  }
});

test('hook: a failure inside the pin floor lets the call run unchanged, with a stderr line and no deny', () => {
  const loop = (agents) => {
    rmSync(join(agents, 'dev.md'));
    symlinkSync('dev.md', join(agents, 'dev.md')); // a link to itself: stat throws ELOOP
  };
  const r = runWithAgents({ ...BASE, subagent_type: 'dev', model: 'sonnet' }, loop);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^agent-model-guard: pin floor skipped: /);
});
