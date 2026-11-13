// PreToolUse(Artifact): publishing or deleting an artifact is an outward action, so it always asks the owner, even in
// bypassPermissions mode (a hook "ask" is a prompt, verified on CLI 2.1.323). Read, list, open, pin, unpin and quickstart pass.
// Exports: decideArtifact(toolInput) -> reason | undefined.
// `action` omitted means publish (the tool's default). Fails open: bad input or an unknown action is not asked about.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

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
    ? `Artifact delete permanently removes the artifact${target}; confirm with the owner`
    : `Artifact publish ${target ? `updates${target}` : 'creates a hosted page'}; confirm with the owner`;
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
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
