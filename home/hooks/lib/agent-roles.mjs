// Which agents write product code, for agent-model-guard.mjs's writer isolation gate and the copy-branch brief gate
// (lib/copy-branch-brief.mjs). The agents of home/agents decide by name: dev, dev-ui, dev-pixel and dev-debug write in their own
// worktree; lex (it writes plans, never product code) and the read-only agents never count. Any other type is a writer when
// lib/writer-agents.mjs isWritingAgent says so (general-purpose, or an agent file whose tools may write).
// Exports: WRITER_ROLES, READ_ONLY_ROLES, isWriterRole(type, env).
// Invariants: never throws (isWritingAgent reads agent files and answers false on any failure); names are compared exactly.
import { agentTypeOf, isWritingAgent } from './writer-agents.mjs';

export const WRITER_ROLES = ['dev', 'dev-ui', 'dev-pixel', 'dev-debug'];
export const READ_ONLY_ROLES = ['lex', 'lex-scout', 'lex-web', 'pixel-qa', 'dev-run', 'tess', 'tess-review'];

/**
 * Whether an Agent call of `type` launches a writer: the roles above decide by name, any other type by its agent file.
 * @param {unknown} type tool_input.subagent_type (none means general-purpose)
 * @param {Record<string, string | undefined>} env HOME / USERPROFILE and CLAUDE_PROJECT_DIR (where the agent files are)
 * @returns {boolean}
 */
export function isWriterRole(type, env) {
  const name = agentTypeOf(type);
  if (WRITER_ROLES.includes(name)) return true;
  return !READ_ONLY_ROLES.includes(name) && isWritingAgent(name, env);
}
