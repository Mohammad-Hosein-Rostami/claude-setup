// PreToolUse(Write|Edit|MultiEdit) guard for read-only agents that have `memory: user` (reviewer, security-auditor).
// Memory needs Write/Edit, so those agents cannot simply disallow them; this hook keeps them read-only for everything
// except their own notes. Allows a path only inside ~/.claude/agent-memory/, or inside THIS session's scratchpad:
// <tmp>/claude-<current uid>/<project>/<input.session_id>/scratchpad/<file>, checked after path.resolve and realpath
// (so `..` and symlinks out of it are refused; other sessions' and other users' scratchpads are refused).
// <tmp> is the OS temp dir and /tmp (Claude Code puts the scratchpad under /tmp even where the OS temp dir differs).
// Without a uid (Windows) the user directory is the plain `claude`. Fails closed: input it cannot read is denied.
// Deny = exit 2 + reason on stderr.
import { homedir, tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep, isAbsolute, dirname } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MEMORY_ROOT = resolve(homedir(), '.claude', 'agent-memory') + sep;
const SESSION_ID = /^[\w-]{1,128}$/;
const SCRATCHPAD_DIR = 'scratchpad';
// segments after <tmp>: claude-<uid>, <project>, <session id>, scratchpad, then at least one more (the file)
const SCRATCHPAD_MIN_SEGMENTS = 5;

const existsAsLink = (path) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * The real path of a target that may not exist yet: realpath of its deepest existing ancestor plus the rest.
 * Returns null for a dangling symlink (a write through it would create a file wherever it points).
 */
function realpathLoose(target) {
  const rest = [];
  let current = target;
  for (;;) {
    try {
      return join(realpathSync(current), ...rest);
    } catch {
      if (existsAsLink(current)) return null;
      const parent = dirname(current);
      if (parent === current) return target;
      rest.unshift(basename(current));
      current = parent;
    }
  }
}

const currentUserDir = () => (typeof process.getuid === 'function' ? `claude-${process.getuid()}` : 'claude');

const defaultTempRoots = () => [tmpdir(), '/tmp'];

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
 * Whether a write target is a file inside this session's scratchpad.
 * @param {unknown} filePath - `tool_input.file_path` from the hook JSON.
 * @param {string} cwd - directory relative paths resolve against.
 * @param {unknown} sessionId - `session_id` from the hook JSON; only this session's scratchpad counts.
 * @param {{ roots?: string[], userDir?: string }} [options] - temp roots and `claude-<uid>` directory name (tests).
 * @returns {boolean} true only for `<tmp>/claude-<uid>/<project>/<sessionId>/scratchpad/<file>` after resolve + realpath.
 */
export function isScratchpadPath(filePath, cwd, sessionId, { roots = defaultTempRoots(), userDir = currentUserDir() } = {}) {
  if (typeof filePath !== 'string' || filePath === '' || typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return false;
  const target = realpathLoose(resolve(cwd, filePath));
  if (target === null) return false;
  return roots.some((root) => {
    const rel = relative(realpathLoose(resolve(root)) ?? '', target);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
    const parts = rel.split(sep);
    return parts.length >= SCRATCHPAD_MIN_SEGMENTS && parts[0] === userDir && parts[2] === sessionId && parts[3] === SCRATCHPAD_DIR;
  });
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
  if (isMemoryPath(target, cwd) || isScratchpadPath(target, cwd, input?.session_id)) return;
  process.stderr.write('Blocked by agent-memory-only: this agent is read-only; it may write only under ~/.claude/agent-memory/ or the scratchpad of this session; report files go under the scratchpad folder of this session (named in your brief), never inside a repository\n');
  process.exitCode = 2;
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
