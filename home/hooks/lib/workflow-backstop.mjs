// The workflow backstop of agent-model-guard.mjs: the owner's rule is "everything that runs is a workflow", so a plain Agent call from the lead
// (no `agent_id` in the hook input) gets one piece of advice naming the wf-* skill for its agent type. A workflow spawn never reaches this hook
// (probe P2, Claude Code 2.1.326: Workflow-started agents do not fire PreToolUse(Agent)), so the workflow scripts carry their own checks.
// Exports: workflowBackstop(input, env) -> { deny: false } | { deny: true, reason }, skillFor(type, prompt) -> skill command | null, BACKSTOP_CLASS.
// The caller (agent-model-guard.mjs) turns `deny: true` into a deny-once through lib/bounce-once.mjs adviceOnce: the identical call sent again runs.
// No advice when: the call comes from inside an agent or workflow (`agent_id`); workflows are disabled (CLAUDE_CODE_DISABLE_WORKFLOWS set, or
// `disableWorkflows: true` in ~/.claude/settings.json); the agent is a fork (it inherits the lead on purpose); or the named skill is not installed
// in this home (advice that names a missing skill sends the agent nowhere).
// Invariants: never throws; reads at most two small files (settings.json, the skill's SKILL.md existence); prompt text is only tested, never copied.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const BACKSTOP_CLASS = 'plain agent call';
const MAX_SETTINGS_BYTES = 1024 * 1024; // a settings.json is a few KB; a bigger file is not read
const FORK_TYPE = 'fork';
const DEFAULT_TYPE = 'general-purpose';
const QUICK_SKILL = 'quick';
const WRITER_SKILL = 'wf-build';
const REVIEW_SKILL = 'wf-review';
const DEBUG_SKILL = 'wf-bugfix';
const RESEARCH_SKILL = 'wf-research';
const STEP_SKILL = 'wf-step';
const SKILL_OF_TYPE = new Map([
  ['implementer', WRITER_SKILL], ['ui-implementer', WRITER_SKILL], ['test-writer', WRITER_SKILL],
  ['reviewer', REVIEW_SKILL], ['security-auditor', REVIEW_SKILL],
  ['deep-debugger', DEBUG_SKILL],
  ['scout', QUICK_SKILL], ['Explore', QUICK_SKILL],
]);
const RESEARCH_QUESTION = /\b(research|investigate|compare|survey|find out|sources?|web ?search|literature|state of the art)\b/i;
const OFF_VALUES = new Set(['', '0', 'false']);

const homeOf = (env) => env.HOME || env.USERPROFILE || homedir();

/** @returns {boolean} true when workflows are turned off by the environment or the user's settings.json */
function workflowsDisabled(env) {
  const flag = env.CLAUDE_CODE_DISABLE_WORKFLOWS;
  if (flag !== undefined && !OFF_VALUES.has(flag.trim().toLowerCase())) return true;
  try {
    const path = join(homeOf(env), '.claude', 'settings.json');
    if (statSync(path).size > MAX_SETTINGS_BYTES) return false;
    return JSON.parse(readFileSync(path, 'utf8'))?.disableWorkflows === true;
  } catch {
    return false; // no readable settings: workflows are on by default
  }
}

/**
 * The skill command that covers an Agent call.
 * @param {unknown} type tool_input.subagent_type (missing means general-purpose)
 * @param {string} prompt the call's prompt, tested for a research question only
 * @returns {string | null} the skill name, null for a fork
 */
export function skillFor(type, prompt) {
  const name = typeof type === 'string' && type !== '' ? type : DEFAULT_TYPE;
  if (name === FORK_TYPE) return null;
  if (SKILL_OF_TYPE.has(name)) return SKILL_OF_TYPE.get(name);
  if (name === DEFAULT_TYPE && RESEARCH_QUESTION.test(prompt)) return RESEARCH_SKILL;
  return STEP_SKILL;
}

/**
 * Whether this Agent call should be sent back once with the workflow advice.
 * @param {unknown} input the hook input: tool_input {subagent_type, prompt}, agent_id (inside an agent or workflow only)
 * @param {Record<string, string | undefined>} env process environment (HOME for settings.json and the skills, CLAUDE_CODE_DISABLE_WORKFLOWS)
 * @returns {{ deny: false } | { deny: true, reason: string }}
 */
export function workflowBackstop(input, env) {
  try {
    if (typeof input?.agent_id === 'string' && input.agent_id !== '') return { deny: false };
    const toolInput = input?.tool_input ?? {};
    const skill = skillFor(toolInput.subagent_type, typeof toolInput.prompt === 'string' ? toolInput.prompt : '');
    if (skill === null || workflowsDisabled(env)) return { deny: false };
    if (!existsSync(join(homeOf(env), '.claude', 'skills', skill, 'SKILL.md'))) return { deny: false };
    const command = skill === QUICK_SKILL ? '/quick' : `/${skill}`;
    return {
      deny: true,
      reason: `Agents run inside a workflow (owner rule): use \`${command}\` for this job. If no workflow can do this job, send the same call again and it runs.`,
    };
  } catch {
    return { deny: false }; // a quality hint, not a safety rule: any failure lets the call run
  }
}
