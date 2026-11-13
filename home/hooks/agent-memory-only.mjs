// PreToolUse(Write|Edit|MultiEdit) guard for read-only agents that have `memory: user` (reviewer, security-auditor).
// Memory needs Write/Edit, so those agents cannot simply disallow them; this hook keeps them read-only for everything
// except their own notes. Allows a path only inside ~/.claude/agent-memory/, or inside the session scratchpad
// (<temp>/claude-<uid>/<project>/<session>/scratchpad/), where a workflow lens or a "detail goes in a file" report
// is written. Fails closed: input it cannot read is denied. Deny = exit 2 + reason on stderr.
import { homedir, tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MEMORY_ROOT = resolve(homedir(), '.claude', 'agent-memory') + sep;

const SCRATCHPAD_ROOTS = [...new Set([tmpdir(), '/tmp', '/private/tmp'].map((root) => resolve(root) + sep))];
// claude-<uid>/<project slug>/<session id>/scratchpad/<file>: exactly one level each, then at least one more segment.
const SCRATCHPAD_TAIL = /^claude-[^\\/]+[\\/][^\\/]+[\\/][^\\/]+[\\/]scratchpad[\\/][^\\/]/;

/**
 * Whether a write target is inside the agent memory directory.
 * @param {unknown} filePath - `tool_input.file_path` from the hook JSON.
 * @param {string} cwd - directory relative paths resolve against.
 * @returns {boolean} true only for a string path under ~/.claude/agent-memory/.
 */
export function isMemoryPath(filePath, cwd) {
  return typeof filePath === 'string' && filePath !== '' && resolve(cwd, filePath).startsWith(MEMORY_ROOT);
}

/**
 * Whether a write target is a file inside a session scratchpad under the temp directory.
 * @param {unknown} filePath - `tool_input.file_path` from the hook JSON.
 * @param {string} cwd - directory relative paths resolve against.
 * @returns {boolean} true only for `<temp>/claude-<uid>/<project>/<session>/scratchpad/<file>` after normalising `..`.
 */
export function isScratchpadPath(filePath, cwd) {
  if (typeof filePath !== 'string' || filePath === '') return false;
  const target = resolve(cwd, filePath);
  const root = SCRATCHPAD_ROOTS.find((candidate) => target.startsWith(candidate));
  return root !== undefined && SCRATCHPAD_TAIL.test(target.slice(root.length));
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    input = undefined; // unreadable hook input: falls through to the deny below
  }
  const cwd = typeof input?.cwd === 'string' ? input.cwd : process.cwd();
  const target = input?.tool_input?.file_path;
  if (isMemoryPath(target, cwd) || isScratchpadPath(target, cwd)) return;
  process.stderr.write('Blocked by agent-memory-only: this agent is read-only; it may write only under ~/.claude/agent-memory/ or the session scratchpad\n');
  process.exitCode = 2;
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
