// PreToolUse(Agent|Task) guard: in extra-high and ultra-high, the built-in Explore and Plan agents (and any Agent
// call without `model`) would inherit the lead model (Opus / Fable) and spend it silently. When an Explore call has
// no `model`, this hook sets `sonnet`; a Plan call without one gets `opus`. Everything else (fork, other agent types,
// an explicit model, other modes, unreadable input) passes through untouched: no output, exit 0.
// Output when it rewrites: {hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",updatedInput}}.
// `updatedInput` replaces the whole input object (per the hooks docs), so the full original input is returned.
// Exports: guardedAgentInput (pure). Invariants: never blocks, never denies; the mode comes from mode.mjs's state lookup.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { SESSION_ID_PATTERN, activeMode, lazyProcessKey } from './mode.mjs';

const GUARDED_MODES = ['extra-high', 'ultra-high'];
const MODEL_FOR_TYPE = { Explore: 'sonnet', Plan: 'opus' };

/**
 * The Agent input with a cheaper model set, when this mode and call need it.
 * @param {string} mode - active setup mode.
 * @param {unknown} toolInput - `tool_input` of the Agent / Task call.
 * @returns {object | null} a copy of the input with `model` added, or null when nothing is to change.
 */
export function guardedAgentInput(mode, toolInput) {
  if (!GUARDED_MODES.includes(mode) || toolInput === null || typeof toolInput !== 'object') return null;
  const model = Object.hasOwn(MODEL_FOR_TYPE, toolInput.subagent_type) ? MODEL_FOR_TYPE[toolInput.subagent_type] : undefined;
  if (!model || (toolInput.model !== undefined && toolInput.model !== '')) return null;
  return { ...toolInput, model };
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return; // not hook JSON: stay silent, never block
  }
  const id = input?.session_id;
  const sessionId = typeof id === 'string' && SESSION_ID_PATTERN.test(id) ? id : undefined;
  const updatedInput = guardedAgentInput(await activeMode(sessionId, lazyProcessKey()), input?.tool_input);
  if (!updatedInput) return;
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput } }));
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`agent-model-guard: ${error.message}\n`);
  }
}
