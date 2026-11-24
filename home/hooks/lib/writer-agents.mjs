// Which agent types write files, and the checks that read a session's launch record for a writer. The record itself (every agent's
// launch, start and stop) lives in lib/agent-launches.mjs; this file keeps the questions about
// writers that agent-model-guard.mjs, copy-branch-brief.mjs, gated-folder.mjs, agent-budget.mjs and the board ask.
// Exports: agentFileWrites(type, env), isWritingAgent(type, env), isReadOnlyBrief(prompt), laneWorktreeOf(prompt, cwd, env) -> {folder, many},
// worktreeValues(text) (pure), worktreeLineAdvice(prompt, env) (the gate's quote of a near-miss line or of many worktrees), agentTypeOf(type),
// callCounterPath(session, agentId), openWritersOf(session, env, now), writersDirOf(env).
// Store: ~/.claude/state/agent-writers/<session>.json (a historic name: it held writer launches only; there is no migration), written
// through lib/agent-launches.mjs. `open` (spec-p3 r9-resume, lib/open-writers.mjs) is the writer launch record the status line's board
// reads: written before the agent starts, closed only at its SubagentStop, never dropped for idleness.
// Flags (round 9, r9-writer-gate): `isolated` (launched with isolation "worktree", or a brief whose `worktree:` field (lib/brief-fields.mjs)
// names a lane worktree laneWorktreeOf accepts and no open record of the session holds, lib/agent-launches.mjs) and `readOnly` (a read-only brief,
// isReadOnlyBrief). The `worktree:` value is the writer's own text, so it is trusted only after `git worktree list` of that folder lists its real path as a linked worktree that is not the lead's folder; git runs
// hardened (lib/gated-folder.mjs runGit) within WORKTREE_DEADLINE_MS, and a git that fails, hangs or is missing means not isolated.
// A brief that names more than one distinct worktree is never isolated by one of them (`many`): a second writer must never enter a
// worktree an open writer works in, and which one such a writer works in is unknown.
// Invariants: never throws; the read functions answer false or [] for a store that is missing or unusable. callCounterPath and
// agentTypeOf are called by lib/agent-launches.mjs, which imports this file (each file calls the other's functions only after loading).
import { readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { BACKTICK, UNPRINTABLE, isInside } from './agent-brief.mjs';
import { namedWorktrees, unquoted, worktreeValues } from './brief-fields.mjs';
import { checkedTempRoot } from './edit-log.mjs';
import { readLaunchRecord } from './agent-launches.mjs';
import { runGit } from './gated-folder.mjs';
import { readPlainFileWith } from './plain-file.mjs';

const SAFE_ID = /^[\w-]{1,128}$/;
const AGENT_FILE_BYTES = 64 * 1024;
const AGENT_TYPE = /^[\w-]{1,64}$/; // a name that can be a file name part; plugin agents (`plugin:name`) have no file here
const WRITING_TOOLS = /\b(?:Write|Edit|MultiEdit|NotebookEdit)\b/;
const DEFAULT_TYPE = 'general-purpose'; // what an Agent call with no subagent_type runs
// A brief line that declares the agent read-only; exact case, at the start of a trimmed line
const READ_ONLY_BRIEF_PREFIXES = ['read-only:', 'scratchpad-only:'];
// The agents of home/agents (lex-dev-tess plan): dev, its part builder dev-part and its UI and debug forms, and tess's test writer
// tess-write, write in their own worktree; lex writes plans, never product code, and the rest only read. Built-in types: general-purpose and claude write,
// Explore and Plan only read.
const WRITER_TYPES = new Set(['dev', 'dev-part', 'dev-ui', 'dev-pixel', 'dev-debug', 'tess-write', 'general-purpose', 'claude']);
const READ_ONLY_TYPES = new Set(['lex', 'lex-scout', 'lex-web', 'pixel-qa', 'dev-run', 'tess', 'tess-review', 'tess-simple', 'tess-edge', 'Explore', 'Plan']);
const NEAR_MISS = /worktree:/i; // a line that meant to name a worktree, quoted (at most MAX_QUOTED_LINE_CHARS) when nothing was taken
const MAX_QUOTED_LINE_CHARS = 160;
const MAX_QUOTED_VALUES = 3; // how many of a brief's worktree values the "name one" advice quotes
// The head of the prompt searched for `worktree:` lines and brief paths: a brief is a few KB, text past this is pasted material
const MAX_SCAN_CHARS = 32 * 1024;
const MAX_BRIEF_FILES = 3; // brief files a prompt names ("Read <path>.md and follow it"), read for a `worktree:` line
const BRIEF_FILE_BYTES = 64 * 1024; // the head of a named brief file that is read and searched whole (a brief is a few KB)
const MAX_PATH_CHARS = 4096; // PATH_MAX on Linux: a longer value is not looked up
const WORKTREE_GIT_MS = 1000; // one `git worktree list` takes a few ms
const WORKTREE_DEADLINE_MS = 1500; // all lookups of one launch: with the copy-branch gate's 2 s, well under the hook's 5 s timeout
const HOME_PREFIX = /^~(?=[\\/])/; // `~/...`; `~user` is left as it is (and is then no absolute path)
const NETWORK_PATH = /^[\\/]{2}/; // UNC or device path: on Windows a lookup reaches the network or a pipe, so it is never looked up

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
 *   when it names none of them or its `disallowedTools:` line names both Write and Edit (road-cap 14a: pixel-qa takes no writer slot),
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

// The field reading lives in lib/brief-fields.mjs; worktreeValues stays exported here for its callers
export { worktreeValues };

/** The absolute `.md` paths a prompt names (`~/` is the home folder), at most MAX_BRIEF_FILES; UNC and device paths are left out. */
function namedBriefFiles(prompt, env) {
  const home = env.HOME || env.USERPROFILE || homedir();
  const paths = prompt.slice(0, MAX_SCAN_CHARS).split(/\s+/).map(unquoted)
    .filter((word) => word.endsWith('.md') && word.length <= MAX_PATH_CHARS).map((word) => word.replace(HOME_PREFIX, home))
    .filter((path) => isAbsolute(path) && !NETWORK_PATH.test(path));
  return [...new Set(paths)].slice(0, MAX_BRIEF_FILES);
}

/** The texts searched for `worktree:` fields: the prompt's first MAX_SCAN_CHARS, then the head of each brief file it names. */
function briefTexts(prompt, env) {
  return [prompt.slice(0, MAX_SCAN_CHARS), ...namedBriefFiles(prompt, env).map((path) => readHead(path, BRIEF_FILE_BYTES) ?? '')];
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

const NO_LANE = Object.freeze({ folder: null, many: false });

/**
 * The lane worktree a writer brief names: its one `worktree: <absolute path>` value (worktreeValues), in the prompt (its first
 * MAX_SCAN_CHARS) or in a brief file the prompt names (a regular file, all of its first BRIEF_FILE_BYTES; at most MAX_BRIEF_FILES), when
 * linkedWorktree accepts it. A brief with two distinct values names many and none is taken: picking one would leave the other lane's
 * writer unheld (a sibling lane named as a field) and let a second writer into it. A worktree another running writer already holds is
 * refused later, under the launch record's lock (lib/agent-launches.mjs `held`).
 * Why: a lead that made a writer's worktree itself (`git worktree add -b <branch> <path> <base>`) gives the writer its own folder as surely as `isolation: "worktree"`.
 * @param {unknown} prompt tool_input.prompt
 * @param {unknown} cwd the hook input cwd (the lead's folder; else this process's folder)
 * @param {Record<string, string | undefined>} env HOME / USERPROFILE for `~/`, CLAUDE_PROJECT_DIR (also the lead's folder)
 * @returns {{folder: string | null, many: boolean}} folder: the worktree's real path, null when no value is accepted (one git call,
 *   within WORKTREE_DEADLINE_MS) and on any failure; many: the brief names more than one worktree (then folder is null)
 */
export function laneWorktreeOf(prompt, cwd, env) {
  try {
    if (typeof prompt !== 'string') return NO_LANE;
    const { values, many } = namedWorktrees(briefTexts(prompt, env));
    if (many) return { folder: null, many: true };
    const leadFolder = realOrNull(typeof cwd === 'string' ? cwd : process.cwd());
    if (leadFolder === null || values.length === 0) return NO_LANE; // without the lead's folder it cannot be told apart
    const leadFolders = [leadFolder, ...(env.CLAUDE_PROJECT_DIR ? [realOrNull(env.CLAUDE_PROJECT_DIR)] : [])].filter((path) => path !== null);
    return { folder: linkedWorktree(values[0], leadFolders, performance.now() + WORKTREE_DEADLINE_MS), many: false };
  } catch {
    return NO_LANE; // fail closed: an unchecked line is no isolation
  }
}

const FOLDER_REFUSED = 'names no worktree this writer can take: git must list it as a linked worktree that is not the lead\'s folder '
  + 'and that no running writer of this session holds.';
const FIELD_NOT_READ = 'was not read: start a line with `worktree: <absolute path>` (or `- worktree:`), or put it after `·` or `|`, or '
  + 'after `;` or `,` in a header line of `KEY: value` fields.';

const NAME_ONE = 'name one worktree, this writer\'s own; a sibling lane\'s folder goes in prose, never as a `worktree:` field.';

/**
 * @returns {string} the line without control, format and separator characters, its backticks turned into `'` (so it cannot close the
 *   code span it is quoted in), cut to MAX_QUOTED_LINE_CHARS (the last one "…")
 */
function quotedLine(line) {
  const printable = line.slice(0, MAX_PATH_CHARS).replace(UNPRINTABLE, '').replace(BACKTICK, "'").trim();
  return printable.length > MAX_QUOTED_LINE_CHARS ? `${printable.slice(0, MAX_QUOTED_LINE_CHARS - 1)}…` : printable;
}

/**
 * The advice line for a writer the isolation gate sends back, quoting what the brief wrote: its worktree values when it names more than
 * one (none was taken), else the first `worktree:` field (its folder was refused: not a linked worktree, the lead's folder, or held by a
 * running writer), else the first line holding `worktree:` in any case (not read as a field). Searched as laneWorktreeOf searches; each
 * quote is cleaned and cut (quotedLine).
 * @param {unknown} prompt tool_input.prompt
 * @param {Record<string, string | undefined>} env HOME / USERPROFILE for `~/` in a named brief file
 * @returns {string} the advice line; '' when no line names a worktree and on any failure
 */
export function worktreeLineAdvice(prompt, env) {
  try {
    if (typeof prompt !== 'string') return '';
    const texts = briefTexts(prompt, env);
    const { fields, values, many } = namedWorktrees(texts);
    if (many) return `The brief has more than one \`worktree:\` field (${values.slice(0, MAX_QUOTED_VALUES).map((value) => `\`${quotedLine(value)}\``).join(', ')}): ${NAME_ONE}`;
    const field = fields[0];
    const line = field?.line ?? texts.flatMap((text) => text.split(/\r?\n/)).find((candidate) => NEAR_MISS.test(candidate));
    if (line === undefined) return '';
    return `The brief line \`${quotedLine(line)}\` ${field === undefined ? FIELD_NOT_READ : FOLDER_REFUSED}`;
  } catch {
    return ''; // the advice still comes, without the quote
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
 * The open launch records of a session (no finish recorded yet), oldest first; read without the lock (a read).
 * @param {unknown} session a session id
 * @param {Record<string, string | undefined>} env HOME / USERPROFILE
 * @param {number} now epoch ms
 * @returns {object[]} [] when the store is missing or unreadable
 */
export function openWritersOf(session, env, now) {
  return readLaunchRecord(session, env, now)?.open ?? [];
}
