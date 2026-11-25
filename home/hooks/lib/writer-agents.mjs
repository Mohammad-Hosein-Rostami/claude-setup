// Which agent types write files: the board (home/tools/board/lib/agents.mjs) marks an agent as a writer with it, and
// lib/gated-folder.mjs looks at the git state only of an agent that can write.
// Exports: agentFileWrites(type, env), isWritingAgent(type, env).
// Invariants: never throws; an agent file that is missing, not a regular file or unreadable gives no answer (agentFileWrites undefined).
import { readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readPlainFileWith } from './plain-file.mjs';

const AGENT_FILE_BYTES = 64 * 1024;
const AGENT_TYPE = /^[\w-]{1,64}$/; // a name that can be a file name part; plugin agents (`plugin:name`) have no file here
const WRITING_TOOLS = /\b(?:Write|Edit|MultiEdit|NotebookEdit)\b/;
const DEFAULT_TYPE = 'general-purpose'; // what an Agent call with no subagent_type runs
// The agents of home/agents (lex-dev-tess plan): dev, its part builder dev-part, its docs writer dev-docs and its UI and debug forms,
// tess's test writer tess-write and the ship agent max write in their own worktree; lex writes plans, never product code, and the rest only read. Built-in types: general-purpose and claude write,
// Explore and Plan only read.
const WRITER_TYPES = new Set(['dev', 'dev-part', 'dev-docs', 'dev-ui', 'dev-pixel', 'dev-debug', 'tess-write', 'max', 'general-purpose', 'claude']);
const READ_ONLY_TYPES = new Set(['lex', 'lex-scout', 'lex-web', 'pixel-qa', 'dev-run', 'tess', 'tess-review', 'tess-simple', 'tess-edge', 'Explore', 'Plan']);

/** The type an Agent call runs: its subagent_type, or general-purpose when it names none. */
function agentTypeOf(type) {
  return typeof type === 'string' && type !== '' ? type : DEFAULT_TYPE;
}

/**
 * The first `maxBytes` of a regular file as text; null when it is missing, not a regular file or unreadable. A link (an installed or
 * personal agent file) is followed once by realpath; the open itself follows no link and never waits (lib/plain-file.mjs), so a FIFO
 * at the path, or behind a link, even one swapped in after a check, never holds the hook.
 */
function readHead(path, maxBytes) {
  try {
    return readPlainFileWith(realpathSync(path), (fd) => {
      const buffer = Buffer.alloc(maxBytes);
      return buffer.toString('utf8', 0, readSync(fd, buffer, 0, maxBytes, 0));
    });
  } catch {
    return null; // no file means no answer
  }
}

/**
 * Whether the agent file of `type` lets it write: the project's `.claude/agents/<type>.md` wins over the user's.
 * @param {unknown} type the agent type
 * @param {Record<string, string | undefined>} env HOME / USERPROFILE and CLAUDE_PROJECT_DIR
 * @returns {boolean | undefined} true when its `tools:` line names Write/Edit/MultiEdit/NotebookEdit or is missing (all tools), false
 *   when it names none of them or its `disallowedTools:` line names both Write and Edit (road-cap 14a: pixel-qa is no writer),
 *   undefined when there is no such file or the type is no file name
 */
export function agentFileWrites(type, env) {
  if (typeof type !== 'string' || !AGENT_TYPE.test(type)) return undefined;
  const home = env.HOME || env.USERPROFILE || homedir();
  const folders = [env.CLAUDE_PROJECT_DIR, home].filter(Boolean).map((root) => join(root, '.claude', 'agents'));
  const text = folders.map((folder) => readHead(join(folder, `${type}.md`), AGENT_FILE_BYTES)).find((found) => found !== null);
  if (text === undefined) return undefined;
  const denied = text.match(/^disallowedTools:(.*)$/m);
  if (denied && /\bWrite\b/.test(denied[1]) && /\bEdit\b/.test(denied[1])) return false;
  const tools = text.match(/^tools:(.*)$/m);
  return !tools || WRITING_TOOLS.test(tools[1]);
}

/**
 * Whether an Agent call of `type` launches a writing agent: the read-only set never does, the writer set (and no type) always does,
 * any other type only when its agent file lets it write (a fork or a plugin agent with no file does not count).
 * @param {unknown} type tool_input.subagent_type
 * @param {Record<string, string | undefined>} env as for agentFileWrites
 * @returns {boolean}
 */
export function isWritingAgent(type, env) {
  const name = agentTypeOf(type);
  if (READ_ONLY_TYPES.has(name)) return false;
  return WRITER_TYPES.has(name) || agentFileWrites(name, env) === true;
}
