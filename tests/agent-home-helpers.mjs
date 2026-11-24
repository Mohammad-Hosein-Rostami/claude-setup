// The agent files a guard test's temp HOME needs, so agent-model-guard.mjs's no-Fable gate (it fails closed: a type with no agent
// file it reads is denied) sees the pins that ship. Exports: agentHomeEnv(home).
// Invariant: read-only on the repo; writes only below the given temp HOME.
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHIPPED_AGENTS = fileURLToPath(new URL('../home/agents/', import.meta.url));
const BASE_SETTINGS = fileURLToPath(new URL('../settings/base.json', import.meta.url));
const AGENT_FILE_SUFFIX = '.md';

/**
 * Copies the shipped agent files (home/agents/*.md) into `<home>/.claude/agents`.
 * @param {string} home a temp HOME of the test
 * @returns {Record<string, string>} the env the guard reads them with: CLAUDE_CONFIG_DIR (that folder, never the runner's own) and
 *   CLAUDE_CODE_SUBAGENT_MODEL as settings/base.json sets it (the model of an agent file with no `model` line)
 */
export function agentHomeEnv(home) {
  const agents = join(home, '.claude', 'agents');
  mkdirSync(agents, { recursive: true });
  for (const name of readdirSync(SHIPPED_AGENTS).filter((file) => file.endsWith(AGENT_FILE_SUFFIX))) {
    copyFileSync(join(SHIPPED_AGENTS, name), join(agents, name));
  }
  const { env } = JSON.parse(readFileSync(BASE_SETTINGS, 'utf8'));
  return { CLAUDE_CONFIG_DIR: join(home, '.claude'), CLAUDE_CODE_SUBAGENT_MODEL: env.CLAUDE_CODE_SUBAGENT_MODEL };
}
