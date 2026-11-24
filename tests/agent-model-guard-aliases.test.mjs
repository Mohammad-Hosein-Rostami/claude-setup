// Tests for the no-Fable gate of home/hooks/agent-model-guard.mjs on the models it cannot see (lib/fable-model-reasons.mjs): the
// aliases Claude Code resolves only at run time (`best`, `default`, `opusplan`, with or without `[1m]`) in the call, in the agent
// file's pin and in CLAUDE_CODE_SUBAGENT_MODEL; CLAUDE_CODE_SUBAGENT_MODEL_FORCE, on only for the values Claude Code reads as on (1,
// true, yes, on, any case, padded), under which CLAUDE_CODE_SUBAGENT_MODEL decides, a Fable or alias call model is still denied and
// the routing adds no `model`; and ANTHROPIC_DEFAULT_*_MODEL naming Fable, which denies every Agent call. Each test has a private
// HOME (agent files, records) and its own session ids; the hook runs as a process with the hook JSON on stdin.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FROM_AGENT } from './agent-call-origin.mjs';
import { agentHomeEnv } from './agent-home-helpers.mjs';
import { hookEnv } from './hook-env.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const GUARD = fileURLToPath(new URL('../home/hooks/agent-model-guard.mjs', import.meta.url));
const HOOK_TIMEOUT_MS = 5000; // settings/base.json gives the hook 5 s
const FORCE = 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE';
const SUBAGENT_MODEL = 'CLAUDE_CODE_SUBAGENT_MODEL';
const SHIPPED_SUBAGENT_MODEL = 'claude-sonnet-5-5'; // settings/base.json's CLAUDE_CODE_SUBAGENT_MODEL
const FABLE_RULE = 'Not started: Fable is never used for an agent (the owner chooses it by hand only)';
const ALIAS_NOTE = 'an alias Claude Code resolves only at run time';
const FORCED_NOTE = `${FORCE} is on`;
const RUN_TIME_ALIASES = ['best', 'Best', ' best ', 'default', 'opusplan', 'best[1m]', 'OPUSPLAN[1M]'];
const FORCE_ON = ['1', 'true', 'yes', 'on', 'TRUE', ' On '];
const NOT_READ_AS_ON = ['anything', 'enabled', '2']; // Claude Code reads only 1, true, yes and on as on
const FORCE_OFF = [undefined, '', '0', 'false', 'no', 'off', ' OFF ', ...NOT_READ_AS_ON];
const ALIAS_TARGET_VARS = ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_MODEL'];
const FABLE_ID = 'claude-fable-1';
const NON_FABLE_ID = 'claude-opus-5-5';
const PADDED_INHERIT = [' inherit', 'inherit ', ' INHERIT '];
const UNSET = undefined;
let counter = 0;

/**
 * A private HOME with the shipped agent files; `agentModel` given: its dev file is replaced by one pinning that model (null: no
 * `model` line). `vars` sets or (undefined) removes env variables on top of the shipped CLAUDE_CODE_SUBAGENT_MODEL.
 */
function guardHome({ agentModel, vars = {} } = {}) {
  const home = makeTempDir('model-alias-home-');
  const shipped = agentHomeEnv(home);
  if (agentModel !== undefined) writeDevFile(home, agentModel);
  const env = hookEnv({ HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: home, ...shipped });
  for (const name of [FORCE, ...ALIAS_TARGET_VARS]) delete env[name]; // the runner's own values never leak in
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return { home, env };
}

function writeDevFile(home, model) {
  const agents = join(home, '.claude', 'agents');
  mkdirSync(agents, { recursive: true });
  const modelLine = model === null ? '' : `model: ${model}\n`;
  writeFileSync(join(agents, 'dev.md'), `---\nname: dev\ndescription: builds\n${modelLine}---\n\nA test dev.\n`);
}

/** Runs one Agent call through the hook (a fresh session each time, so the cap never fills); null when it printed nothing. */
function guard({ home, env }, toolInput, origin = {}) {
  const input = { hook_event_name: 'PreToolUse', session_id: `alias-${process.pid}-${counter++}`, cwd: home, tool_name: 'Agent', tool_input: toolInput, ...origin };
  const run = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(input), encoding: 'utf8', env, timeout: HOOK_TIMEOUT_MS });
  assert.equal(run.error, undefined, 'the hook finished within its timeout');
  assert.equal(run.status, 0, run.stderr);
  return run.stdout === '' ? null : JSON.parse(run.stdout).hookSpecificOutput;
}

// isolation "worktree" keeps the writer isolation gate out of these tests; dev comes from the boss (no agent_id)
const devCall = (extra = {}) => ({ subagent_type: 'dev', description: 'job', prompt: 'build it', isolation: 'worktree', ...extra });
// a general-purpose call from inside a dev: the type the routing adds `sonnet` to
const helperCall = { subagent_type: 'general-purpose', description: 'look', prompt: 'find x' };
const denyReason = (out) => {
  assert.equal(out?.permissionDecision, 'deny', JSON.stringify(out));
  assert.ok(out.permissionDecisionReason.startsWith(FABLE_RULE), out.permissionDecisionReason);
  return out.permissionDecisionReason;
};

test('a call model that is a run-time alias (best, default, opusplan, any case, padded, [1m]) is denied, naming the alias', () => {
  const home = guardHome();
  for (const model of RUN_TIME_ALIASES) {
    const reason = denyReason(guard(home, devCall({ model })));
    assert.ok(reason.includes(ALIAS_NOTE), `${model}: ${reason}`);
    assert.ok(reason.includes(`\`${model}\``), `${model}: the reason quotes the value`);
  }
});

test('a concrete call model (opus, sonnet, haiku, claude-sonnet-5-5) is still allowed', () => {
  const home = guardHome();
  for (const model of ['opus', 'sonnet', 'haiku', SHIPPED_SUBAGENT_MODEL]) {
    assert.notEqual(guard(home, devCall({ model }))?.permissionDecision, 'deny', model);
  }
});

test('a call model of fable, a Fable id or inherit is denied', () => {
  const home = guardHome();
  for (const model of ['fable', 'claude-fable-5', 'inherit']) denyReason(guard(home, devCall({ model })));
});

test('an agent file pinning a run-time alias denies a call with no model, naming the pin', () => {
  for (const pin of ['best', 'opusplan', 'default[1m]']) {
    const reason = denyReason(guard(guardHome({ agentModel: pin }), devCall()));
    assert.ok(reason.includes(`agent file pins \`${pin}\``), `${pin}: ${reason}`);
    assert.ok(reason.includes(ALIAS_NOTE), `${pin}: ${reason}`);
  }
});

test('an agent file with no model line and CLAUDE_CODE_SUBAGENT_MODEL best, default, opusplan or fable is denied', () => {
  for (const value of ['best', 'default', 'opusplan', 'fable']) {
    const reason = denyReason(guard(guardHome({ agentModel: null, vars: { [SUBAGENT_MODEL]: value } }), devCall()));
    assert.ok(reason.includes(`pins no model and ${SUBAGENT_MODEL} is \`${value}\``), `${value}: ${reason}`);
  }
});

test('FORCE on (1, true, yes, on, any case, padded) with CLAUDE_CODE_SUBAGENT_MODEL unset, empty, inherit, fable or best denies a dev call with no model', () => {
  for (const force of FORCE_ON) {
    for (const model of [UNSET, '', 'inherit', 'fable', 'best']) {
      const reason = denyReason(guard(guardHome({ vars: { [FORCE]: force, [SUBAGENT_MODEL]: model } }), devCall()));
      assert.ok(reason.includes(FORCED_NOTE), `force ${force}, model ${model}: ${reason}`);
    }
  }
});

test('FORCE on with CLAUDE_CODE_SUBAGENT_MODEL claude-sonnet-5-5 allows, and the routing adds no model', () => {
  for (const force of FORCE_ON) {
    const home = guardHome({ vars: { [FORCE]: force, [SUBAGENT_MODEL]: SHIPPED_SUBAGENT_MODEL } });
    assert.equal(guard(home, devCall()), null, `force ${force}: the dev call runs as sent`);
    assert.equal(guard(home, helperCall, FROM_AGENT), null, `force ${force}: no updatedInput with a model for general-purpose`);
  }
});

test('FORCE off (unset, empty, 0, false, no, off, padded OFF, and anything, enabled or 2) routes general-purpose to sonnet as before', () => {
  for (const force of FORCE_OFF) {
    const home = guardHome({ vars: { [FORCE]: force, [SUBAGENT_MODEL]: SHIPPED_SUBAGENT_MODEL } });
    const out = guard(home, helperCall, FROM_AGENT);
    assert.deepEqual(out, { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...helperCall, model: 'sonnet' } }, `force ${force}`);
  }
});

test('FORCE anything, enabled or 2 is off: a dev pinned opus runs with CLAUDE_CODE_SUBAGENT_MODEL unset, empty, inherit, fable or best', () => {
  for (const force of NOT_READ_AS_ON) {
    for (const model of [UNSET, '', 'inherit', 'fable', 'best']) {
      const out = guard(guardHome({ agentModel: 'opus', vars: { [FORCE]: force, [SUBAGENT_MODEL]: model } }), devCall());
      assert.notEqual(out?.permissionDecision, 'deny', `force ${force}, model ${model}: the pin decides, ${JSON.stringify(out)}`);
    }
  }
});

test('a call model of fable or best is denied with FORCE off (enabled, 2) and with FORCE on (1), naming the value', () => {
  for (const force of ['enabled', '2', '1']) {
    const home = guardHome({ vars: { [FORCE]: force, [SUBAGENT_MODEL]: SHIPPED_SUBAGENT_MODEL } });
    for (const model of ['fable', 'best']) {
      const reason = denyReason(guard(home, devCall({ model })));
      assert.ok(reason.includes(`\`${model}\``), `force ${force}, model ${model}: ${reason}`);
    }
  }
});

test('FORCE on and a call model of inherit is denied even with a concrete CLAUDE_CODE_SUBAGENT_MODEL', () => {
  const home = guardHome({ vars: { [FORCE]: '1', [SUBAGENT_MODEL]: SHIPPED_SUBAGENT_MODEL } });
  const reason = denyReason(guard(home, devCall({ model: 'inherit' })));
  assert.ok(reason.includes('`model: inherit`'), reason);
});

test('FORCE on ignores an agent file pin of opus or sonnet: CLAUDE_CODE_SUBAGENT_MODEL best denies', () => {
  for (const pin of ['opus', 'sonnet']) {
    const home = guardHome({ agentModel: pin, vars: { [FORCE]: '1', [SUBAGENT_MODEL]: 'best' } });
    const reason = denyReason(guard(home, devCall()));
    assert.ok(reason.includes(`${FORCED_NOTE}, so every agent runs on ${SUBAGENT_MODEL} \`best\``), `${pin}: ${reason}`);
  }
});

test('a padded inherit call model ( inherit, inherit , INHERIT ) is denied as inherit', () => {
  const home = guardHome();
  for (const model of PADDED_INHERIT) {
    const reason = denyReason(guard(home, devCall({ model })));
    assert.ok(reason.includes('`model: inherit`'), `${JSON.stringify(model)}: ${reason}`);
  }
});

test('an ANTHROPIC_DEFAULT_*_MODEL naming Fable denies every Agent call (opus, sonnet, haiku, no model, a helper), naming the variable', () => {
  for (const name of ALIAS_TARGET_VARS) {
    const home = guardHome({ vars: { [name]: FABLE_ID } });
    const calls = { opus: devCall({ model: 'opus' }), sonnet: devCall({ model: 'sonnet' }), haiku: devCall({ model: 'haiku' }), none: devCall() };
    for (const [label, call] of Object.entries(calls)) {
      const reason = denyReason(guard(home, call));
      assert.ok(reason.includes(`${name} points a model alias at \`${FABLE_ID}\``), `${name}, ${label}: ${reason}`);
    }
    assert.ok(denyReason(guard(home, helperCall, FROM_AGENT)).includes(name), `${name}: the general-purpose helper too`);
  }
});

test('an ANTHROPIC_DEFAULT_*_MODEL naming a non-Fable model lets the same calls run', () => {
  for (const name of ALIAS_TARGET_VARS) {
    const home = guardHome({ vars: { [name]: NON_FABLE_ID } });
    for (const model of ['opus', 'sonnet', 'haiku', UNSET]) {
      assert.notEqual(guard(home, devCall(model === UNSET ? {} : { model }))?.permissionDecision, 'deny', `${name}, model ${model}`);
    }
    assert.notEqual(guard(home, helperCall, FROM_AGENT)?.permissionDecision, 'deny', `${name}: the helper`);
  }
});
