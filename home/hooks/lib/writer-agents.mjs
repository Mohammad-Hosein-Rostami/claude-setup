// Which agent types write files, and the checks that read a session's launch record for a writer. The record itself (every agent's
// launch, start and stop, and the cap of agents running at once) lives in lib/agent-launches.mjs; this file keeps the questions about
// writers that commit-gate.mjs, read-only-hold.mjs, copy-branch-brief.mjs, gated-folder.mjs, agent-budget.mjs and the board ask.
// Exports: agentFileWrites(type, env), isWritingAgent(type, env), isReadOnlyBrief(prompt), laneWorktreeOf(prompt, cwd, env), agentTypeOf(type),
// callCounterPath(session, agentId), readOnlyLaunchOpen(session, agentId, type, env), openWritersOf(session, env, now), writersDirOf(env).
// Store: ~/.claude/state/agent-writers/<session>.json (a historic name: it held writer launches only; there is no migration), written
// through lib/agent-launches.mjs. `open` (spec-p3 r9-resume, lib/open-writers.mjs) is the launch record the resume notice reads: written
// before the agent starts, closed only at its SubagentStop, never dropped for idleness, so a writer cut off by an exit or a usage-limit
// stop is still listed in the next session. readOnlyAgents keeps the ids of started read-only launches after their stop, because
// commit-gate's read-only hold runs on the same SubagentStop as the stop record (hooks of one event run in parallel).
// Flags (round 9, r9-writer-gate): `isolated` (launched with isolation "worktree", or a brief whose `worktree:` line names a lane worktree
// laneWorktreeOf accepts and no open record of the session holds, lib/agent-launches.mjs) and `readOnly` (a read-only brief,
// isReadOnlyBrief). The `worktree:` value is the writer's own text, so it is trusted only after `git worktree list` of that folder lists its real path as a linked worktree that is not the lead's folder; git runs
// hardened (lib/gated-folder.mjs runGit) within WORKTREE_DEADLINE_MS, and a git that fails, hangs or is missing means not isolated.
// Invariants: never throws; the read functions answer false or [] for a store that is missing or unusable. callCounterPath and
// agentTypeOf are called by lib/agent-launches.mjs, which imports this file (each file calls the other's functions only after loading).
import { readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { isInside } from './agent-brief.mjs';
import { checkedTempRoot } from './edit-log.mjs';
import { readLaunchRecord } from './agent-launches.mjs';
import { runGit } from './gated-folder.mjs';
import { readPlainFileWith } from './plain-file.mjs';

const SAFE_ID = /^[\w-]{1,128}$/;
const AGENT_FILE_BYTES = 64 * 1024;
const AGENT_TYPE = /^[\w-]{1,64}$/; // a name that can be a file name part; plugin agents (`plugin:name`) have no file here
const WRITING_TOOLS = /\b(?:Write|Edit|MultiEdit|NotebookEdit)\b/;
const DEFAULT_TYPE = 'general-purpose'; // what an Agent call with no subagent_type runs
// A brief line that declares the agent read-only; exact case, at the start of a trimmed line (commit-gate holds the agent to it at its stop)
const READ_ONLY_BRIEF_PREFIXES = ['read-only:', 'scratchpad-only:'];
const WRITER_TYPES = new Set(['implementer', 'ui-implementer', 'general-purpose', 'claude']);
const READ_ONLY_TYPES = new Set(['scout', 'runner', 'Explore', 'Plan', 'architect']);
// A brief line that names the writer's own lane worktree, as `worktree: <absolute path>` (exact case, at the start of a trimmed line)
const WORKTREE_PREFIX = 'worktree:';
// The head of the prompt searched for `worktree:` lines and brief paths: a brief is a few KB, text past this is pasted material
const MAX_SCAN_CHARS = 32 * 1024;
const MAX_WORKTREE_LINES = 3; // a brief names one lane worktree; the cap bounds the git calls of one launch
const MAX_BRIEF_FILES = 3; // brief files a prompt names ("Read <path>.md and follow it"), read for a `worktree:` line
const BRIEF_FILE_BYTES = 64 * 1024; // the head of a named brief file that is read and searched whole (a brief is a few KB)
const MAX_PATH_CHARS = 4096; // PATH_MAX on Linux: a longer value is not looked up
const WORKTREE_GIT_MS = 1000; // one `git worktree list` takes a few ms
const WORKTREE_DEADLINE_MS = 1500; // all lookups of one launch: with the copy-branch gate's 2 s, well under the hook's 5 s timeout
const HOME_PREFIX = /^~(?=[\\/])/; // `~/...`; `~user` is left as it is (and is then no absolute path)
const NETWORK_PATH = /^[\\/]{2}/; // UNC or device path: on Windows a lookup reaches the network or a pipe, so it is never looked up
const SURROUNDING_MARKS = '`\'"()';
const TRAILING_PUNCTUATION = ',.;:';

/** The folder of the launch stores (one `<session>.json` each). */
export function writersDirOf(env) {
  return join(env.HOME || env.USERPROFILE || homedir(), '.claude', 'state', 'agent-writers');
}

/** The type an Agent call runs: its subagent_type, or general-purpose when it names none. */
export function agentTypeOf(type) {
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
 *   when it names none of them or its `disallowedTools:` line names both Write and Edit (road-cap 14a: visual-qa takes no writer slot),
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

/**
 * Whether a brief declares its agent read-only: one of its lines, split on CR LF or LF and trimmed, starts with `read-only:` or
 * `scratchpad-only:` in exactly that case. A mention inside a sentence or another case does not count.
 * @param {unknown} prompt tool_input.prompt (or the brief read back from the agent's transcript)
 * @returns {boolean} false for anything that is not a string
 */
export function isReadOnlyBrief(prompt) {
  if (typeof prompt !== 'string') return false;
  return prompt.split(/\r?\n/).some((line) => READ_ONLY_BRIEF_PREFIXES.some((prefix) => line.trim().startsWith(prefix)));
}

/** The word without quotes, backticks and brackets around it and without trailing sentence punctuation (a loop: linear in its length). */
function unquoted(word) {
  let start = 0;
  let end = word.length;
  while (start < end && SURROUNDING_MARKS.includes(word[start])) start += 1;
  while (end > start && (SURROUNDING_MARKS + TRAILING_PUNCTUATION).includes(word[end - 1])) end -= 1;
  return word.slice(start, end);
}

/** The values of a text's `worktree:` lines, unquoted, in order; the caller bounds the text (MAX_SCAN_CHARS, BRIEF_FILE_BYTES). */
function worktreeValues(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith(WORKTREE_PREFIX))
    .map((line) => unquoted(line.slice(WORKTREE_PREFIX.length).trim()));
}

/** The absolute `.md` paths a prompt names (`~/` is the home folder), at most MAX_BRIEF_FILES; UNC and device paths are left out. */
function namedBriefFiles(prompt, env) {
  const home = env.HOME || env.USERPROFILE || homedir();
  const paths = prompt.slice(0, MAX_SCAN_CHARS).split(/\s+/).map(unquoted)
    .filter((word) => word.endsWith('.md') && word.length <= MAX_PATH_CHARS).map((word) => word.replace(HOME_PREFIX, home))
    .filter((path) => isAbsolute(path) && !NETWORK_PATH.test(path));
  return [...new Set(paths)].slice(0, MAX_BRIEF_FILES);
}

const realOrNull = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return null; // a folder that does not exist is no worktree
  }
};

/**
 * The real path of `value` when git lists it as a linked worktree of its repository and it is none of the lead's folders (the folder
 * or one inside it); null otherwise, for a relative, UNC or missing path, and when git fails or does not answer before `deadline`.
 */
function linkedWorktree(value, leadFolders, deadline) {
  if (value.length > MAX_PATH_CHARS || NETWORK_PATH.test(value) || !isAbsolute(value)) return null;
  const folder = realOrNull(value);
  const remaining = Math.ceil(Math.min(deadline - performance.now(), WORKTREE_GIT_MS)); // whole ms: spawnSync rejects a fraction
  // spawnSync reads a timeout of 0 as "no timeout", so git never starts with nothing left
  if (folder === null || !(remaining > 0) || leadFolders.some((lead) => isInside(lead, folder))) return null;
  const listed = runGit(folder, ['worktree', 'list', '--porcelain', '-z'], remaining);
  if (listed.status !== 0) return null; // also a git killed at the timeout (no status) or one that never started
  const linked = listed.stdout.split('\0').filter((field) => field.startsWith('worktree ')).slice(1); // the first is the main worktree
  return linked.some((field) => realOrNull(field.slice('worktree '.length)) === folder) ? folder : null;
}

/**
 * The lane worktree a writer brief names: the first `worktree: <absolute path>` line, in the prompt (its first MAX_SCAN_CHARS) or in a
 * brief file the prompt names (a regular file, all of its first BRIEF_FILE_BYTES; at most MAX_BRIEF_FILES), that linkedWorktree accepts.
 * A worktree another running writer already holds is refused later, under the launch record's lock (lib/agent-launches.mjs `held`).
 * Why: a lead that made a writer's worktree itself (`git worktree add -b <branch> <path> <base>`) gives the writer its own folder as surely as `isolation: "worktree"`.
 * @param {unknown} prompt tool_input.prompt
 * @param {unknown} cwd the hook input cwd (the lead's folder; else this process's folder)
 * @param {Record<string, string | undefined>} env HOME / USERPROFILE for `~/`, CLAUDE_PROJECT_DIR (also the lead's folder)
 * @returns {string | null} the worktree's real path; null when no line is accepted, at most MAX_WORKTREE_LINES are checked, within
 *   WORKTREE_DEADLINE_MS, and on any failure
 */
export function laneWorktreeOf(prompt, cwd, env) {
  try {
    if (typeof prompt !== 'string') return null;
    const leadFolder = realOrNull(typeof cwd === 'string' ? cwd : process.cwd());
    if (leadFolder === null) return null; // without the lead's folder it cannot be told apart
    const leadFolders = [leadFolder, ...(env.CLAUDE_PROJECT_DIR ? [realOrNull(env.CLAUDE_PROJECT_DIR)] : [])].filter((path) => path !== null);
    const briefs = namedBriefFiles(prompt, env).map((path) => readHead(path, BRIEF_FILE_BYTES) ?? '');
    const values = [prompt.slice(0, MAX_SCAN_CHARS), ...briefs].flatMap(worktreeValues).slice(0, MAX_WORKTREE_LINES);
    const deadline = performance.now() + WORKTREE_DEADLINE_MS;
    for (const value of values) {
      const folder = linkedWorktree(value, leadFolders, deadline);
      if (folder !== null) return folder;
    }
    return null;
  } catch {
    return null; // fail closed: an unchecked line is no isolation
  }
}

/**
 * The file agent-budget.mjs appends one byte to on each tool call of a subagent (its mtime is the agent's last tool call).
 * @returns {string | null} the path; null when an id is not a safe file name part or the hook temp root is refused (lib/edit-log.mjs)
 */
export function callCounterPath(session, agentId) {
  if (!SAFE_ID.test(session ?? '') || !SAFE_ID.test(agentId ?? '')) return null;
  const root = checkedTempRoot();
  return root === null ? null : join(root, 'budget', `${session}--${agentId}`);
}

/**
 * Whether a stopping agent was launched read-only, for commit-gate's hold when the agent's brief cannot be read: a started read-only
 * launch with this agent id (kept after its stop), or a read-only launch of its type that has not ended. Read without the lock (a read).
 * @param {unknown} session hook input session_id
 * @param {unknown} agentId hook input agent_id
 * @param {unknown} type hook input agent_type
 * @param {Record<string, string | undefined>} env HOME / USERPROFILE
 * @returns {boolean} false when there is no such launch or the store cannot be read
 */
export function readOnlyLaunchOpen(session, agentId, type, env) {
  if (typeof agentId !== 'string' || agentId === '') return false;
  const record = readLaunchRecord(session, env, Date.now());
  if (record === null) return false;
  if (record.readOnlyAgents.includes(agentId)) return true;
  return record.launches.some((launch) => launch.readOnly === true && (launch.agent === agentId || launch.type === agentTypeOf(type)));
}

/**
 * The open launch records of a session (no finish recorded yet), oldest first; read without the lock (a read).
 * @param {unknown} session a session id
 * @param {Record<string, string | undefined>} env HOME / USERPROFILE
 * @param {number} now epoch ms
 * @returns {object[]} [] when the store is missing or unreadable
 */
export function openWritersOf(session, env, now) {
  return readLaunchRecord(session, env, now)?.open ?? [];
}
