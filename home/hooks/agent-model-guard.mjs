// PreToolUse(Agent|Task) guard: an Agent call with no `model` would inherit the lead model (Opus / Fable) and spend it
// silently. In every mode, an unpinned call to a built-in type that pins no model itself (general-purpose, a call with
// no subagent_type, Explore and the other built-ins) gets `sonnet`. In extra-high and ultra-high a Plan call without
// one gets `opus`. Forks (subagent_type "fork", they inherit the lead on purpose), the repo's own agents (their files
// pin a model; a per-call model would override it), plugin agents, an explicit model, and unreadable input pass
// through untouched: no output, exit 0.
// Env interaction: settings/base.json sets CLAUDE_CODE_SUBAGENT_MODEL=claude-sonnet-5-5. See docs/catalog.md for how
// Claude Code ranks that variable against the per-call `model` this hook sets.
// Output when it rewrites: {hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",updatedInput}}.
// `updatedInput` replaces the whole input object (per the hooks docs), so the full original input is returned.
// Exports: guardedAgentInput (pure). Invariants: never blocks, never denies; the mode comes from mode.mjs's state lookup.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { SESSION_ID_PATTERN, activeMode, lazyProcessKey } from './mode.mjs';

const PLAN_MODES = ['extra-high', 'ultra-high'];
const FORK_TYPE = 'fork';
const DEFAULT_MODEL = 'sonnet';
// Built-in agent types that pin no model; an omitted subagent_type means general-purpose.
const UNPINNED_BUILTIN_TYPES = ['general-purpose', 'Explore', 'claude', 'claude-code-guide', 'statusline-setup'];

/**
 * The Agent input with a cheaper model set, when this mode and call need it.
 * @param {string} mode - active setup mode.
 * @param {unknown} toolInput - `tool_input` of the Agent / Task call.
 * @returns {object | null} a copy of the input with `model` added, or null when nothing is to change.
 */
export function guardedAgentInput(mode, toolInput) {
  if (toolInput === null || typeof toolInput !== 'object') return null;
  if (toolInput.model !== undefined && toolInput.model !== '') return null;
  const type = toolInput.subagent_type;
  if (type === FORK_TYPE) return null;
  if (type === 'Plan') return PLAN_MODES.includes(mode) ? { ...toolInput, model: 'opus' } : null;
  const unpinned = type === undefined || type === '' || UNPINNED_BUILTIN_TYPES.includes(type);
  return unpinned ? { ...toolInput, model: DEFAULT_MODEL } : null;
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
