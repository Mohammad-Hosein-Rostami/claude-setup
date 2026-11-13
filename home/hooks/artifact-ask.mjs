// PreToolUse(Artifact): publishing or deleting an artifact is an outward action, so it asks the owner with a timed dialog
// (lib/timed-ask.mjs: Allow by default, auto-allow after 180 s, Deny only on a click), falling back to the CLI's own ask
// (a prompt even in bypassPermissions mode, verified on CLI 2.1.323) when there is no GUI. Read, list, open, pin, unpin and
// quickstart pass.
// Exports: decideArtifact(toolInput) -> reason | undefined.
// `action` omitted means publish (the tool's default). Fails open: bad input or an unknown action is not asked about.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { askOwner } from './lib/timed-ask.mjs';

const OUTWARD_ACTIONS = new Set(['publish', 'delete']);

/**
 * @param {unknown} toolInput the Artifact tool input
 * @returns {string | undefined} prompt text when the call publishes or deletes, else undefined
 */
export function decideArtifact(toolInput) {
  if (toolInput === null || typeof toolInput !== 'object') return undefined;
  const action = toolInput.action ?? 'publish';
  if (!OUTWARD_ACTIONS.has(action)) return undefined;
  const target = typeof toolInput.url === 'string' ? ` ${toolInput.url}` : '';
  return action === 'delete'
    ? `Artifact delete permanently removes the artifact${target}`
    : `Artifact publish ${target ? `updates${target}` : 'creates a hosted page'}`;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return; // not hook JSON: nothing to ask about
  }
  const reason = decideArtifact(input?.tool_input);
  if (reason === undefined) return;
  const { action = 'publish', url } = input.tool_input;
  process.stdout.write(askOwner({ hook: 'artifact-ask', tool: 'Artifact', reason, command: `${action}${typeof url === 'string' ? ` ${url}` : ''}`, cwd: input.cwd, sessionId: input.session_id, agentId: input.agent_id }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
