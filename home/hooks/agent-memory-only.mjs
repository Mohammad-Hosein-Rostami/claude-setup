// PreToolUse(Write|Edit|MultiEdit) guard for read-only agents that have `memory: user` (reviewer, security-auditor).
// Memory needs Write/Edit, so those agents cannot simply disallow them; this hook keeps them read-only for everything
// except their own notes. Allows a path only inside ~/.claude/agent-memory/, or inside THIS session's scratchpad:
// <tmp>/claude-<current uid>/<project>/<input.session_id>/scratchpad/<file>, checked after path.resolve and realpath
// (so `..` and symlinks out of it are refused; other sessions' and other users' scratchpads are refused).
// <tmp> is the OS temp dir and /tmp (Claude Code puts the scratchpad under /tmp even where the OS temp dir differs).
// Without a uid (Windows) the user directory is the plain `claude`. Fails closed: input it cannot read is denied.
// Reports (round 9, O2): a Write of a NEW file named `review-<words>-<8 hex>.md` or `security-audit-<words>-<8 hex>.md` directly inside
// the folder on the brief's one `REPORTS: <absolute path>` line is allowed too. The brief is the one the lead launched the agent with:
// registered also on PostToolUse(Agent|Task) in settings/base.json, this hook stores `agent id -> that folder` for the session
// (~/.claude/state/agent-reports/<session>.json), and a later PreToolUse inside the agent finds it by its `agent_id`, so the agent cannot
// change it. The folder must exist, must not be $HOME, `/` or an ancestor of either, must lie outside every git repository (no `.git` in
// it or above it, after realpath) and outside ~/.claude. Edit and MultiEdit there, an existing file, a dotfile, a sub-folder, a `..` or
// link escape and an agent with no stored brief stay denied. The agent keeps Bash, which no hook limits: this guard prevents mistakes,
// not a determined write.
// Exports: isMemoryPath, isScratchpadPath, reportsFolderOf(prompt), recordBrief(input, dir), briefReportsFolder(input, dir),
// isNewReportPath(filePath, cwd, folder, toolName).
// Deny = exit 2 + reason on stderr. The PostToolUse run never blocks: a brief it cannot store leaves the reports folder denied.
import { homedir, tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep, isAbsolute, dirname, parse } from 'node:path';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { withSessionLock } from './lib/session-lock.mjs';
import { isSessionId, readSessionFile, writeSessionFile } from './lib/session-store.mjs';

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

const REPORT_NAME = /^(?:review|security-audit)-[a-z0-9-]+-[0-9a-f]{8}\.md$/;
const REPORTS_LINE = /^REPORTS:[ \t]*(\S.*?)[ \t]*$/gm;
const AGENT_ID = /^[A-Za-z0-9][\w-]{0,127}$/; // starts with a letter or digit: never `__proto__`
const MAX_REPORTS_PATH_CHARS = 1024;
const MAX_BRIEF_ENTRIES = 50; // the last 50 launches of a session; 50 x ~1.1 KB stays under the size cap
const MAX_BRIEF_MAP_BYTES = 64 * 1024; // one cap for the writer and the reader of the map
const briefMapDir = (env = process.env) => join(env.HOME || env.USERPROFILE || homedir(), '.claude', 'state', 'agent-reports');

/**
 * The reports folder a brief names: its one `REPORTS: <absolute path>` line. A folder named anywhere else in the brief does not count.
 * @param {unknown} prompt the brief (`tool_input.prompt` of the Agent call)
 * @returns {string | null} the absolute path, or null when the brief has no such line, more than one, or a relative or `~` path
 */
export function reportsFolderOf(prompt) {
  if (typeof prompt !== 'string') return null;
  const paths = [...prompt.matchAll(REPORTS_LINE)].map((line) => line[1]);
  return paths.length === 1 && isAbsolute(paths[0]) && paths[0].length <= MAX_REPORTS_PATH_CHARS ? paths[0] : null;
}

/** The stored `agent id -> reports folder` map of a session, or undefined when it is missing, unreadable or not an object. */
function readBriefMap(dir, session) {
  const text = readSessionFile(dir, session, MAX_BRIEF_MAP_BYTES);
  if (typeof text !== 'string') return undefined;
  try {
    const map = JSON.parse(text);
    return map !== null && typeof map === 'object' && !Array.isArray(map) ? map : undefined;
  } catch {
    return undefined; // a damaged map: every reports write of the session stays denied
  }
}

/**
 * PostToolUse(Agent|Task): stores the launched agent's reports folder under its id, for the session.
 * @param {any} input the hook JSON: `session_id`, `tool_input.prompt`, `tool_response.agentId`
 * @param {string} [dir] the map folder (tests pass a temp one)
 * @returns {boolean} true when stored
 */
export function recordBrief(input, dir = briefMapDir()) {
  const response = input?.tool_response;
  const agentId = [response?.agentId, response?.agent_id].find((id) => typeof id === 'string' && AGENT_ID.test(id));
  const folder = reportsFolderOf(input?.tool_input?.prompt);
  const session = input?.session_id;
  if (agentId === undefined || folder === null || !isSessionId(session)) return false;
  const stored = withSessionLock(dir, session, () => {
    const entries = Object.entries(readBriefMap(dir, session) ?? {}).filter(([id]) => id !== agentId);
    const kept = [...entries, [agentId, folder]].slice(-MAX_BRIEF_ENTRIES);
    return writeSessionFile(dir, session, JSON.stringify(Object.fromEntries(kept)));
  });
  return stored === true;
}

/**
 * PreToolUse inside an agent: the reports folder its launch brief named.
 * @param {any} input the hook JSON: `session_id`, `agent_id`
 * @param {string} [dir] the map folder
 * @returns {string | null} the folder, or null when this agent has no stored brief (fail closed)
 */
export function briefReportsFolder(input, dir = briefMapDir()) {
  const agentId = input?.agent_id;
  if (typeof agentId !== 'string' || !AGENT_ID.test(agentId) || !isSessionId(input?.session_id)) return null;
  const map = readBriefMap(dir, input.session_id);
  return map !== undefined && Object.hasOwn(map, agentId) && typeof map[agentId] === 'string' ? map[agentId] : null;
}

const realOrNull = (path) => {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
};
const isWithin = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** True when the folder or one above it holds a `.git` (a repository or a worktree). */
function insideGitRepo(folder) {
  for (let dir = folder; ; dir = dirname(dir)) {
    try {
      lstatSync(join(dir, '.git'));
      return true;
    } catch {
      if (dirname(dir) === dir) return false; // no `.git` here: look one folder up, until the root
    }
  }
}

/** The real path of a folder that may hold reports, or null: missing, not a folder, home, a root or above them, in a repo, under ~/.claude. */
function reportsFolderReal(folder) {
  const real = realOrNull(folder);
  if (real === null || !statSync(real).isDirectory()) return null;
  const home = realOrNull(homedir()) ?? resolve(homedir());
  const claudeDirs = [resolve(homedir(), '.claude'), realOrNull(resolve(homedir(), '.claude'))].filter((dir) => dir !== null);
  if (real === parse(real).root || isWithin(real, home) || claudeDirs.some((dir) => isWithin(dir, real))) return null;
  return insideGitRepo(real) ? null : real;
}

/**
 * Whether a write is a new report file directly inside the brief's reports folder.
 * @param {unknown} filePath `tool_input.file_path`
 * @param {string} cwd the folder relative paths resolve against
 * @param {string | null} folder the brief's reports folder (briefReportsFolder)
 * @param {unknown} toolName `tool_name`: only Write counts
 * @returns {boolean} true only for a Write of a file that does not exist yet, named like a report, whose real parent is the folder
 */
export function isNewReportPath(filePath, cwd, folder, toolName) {
  if (toolName !== 'Write' || folder === null || typeof filePath !== 'string' || !REPORT_NAME.test(basename(filePath))) return false;
  const target = resolve(cwd, filePath);
  try {
    lstatSync(target);
    return false; // it exists (a file, a folder or a link): never overwritten
  } catch {
    const real = reportsFolderReal(folder);
    return real !== null && realOrNull(dirname(target)) === real;
  }
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
  if (input?.hook_event_name === 'PostToolUse') return void recordOrSay(input);
  const cwd = typeof input?.cwd === 'string' ? input.cwd : process.cwd();
  const target = input?.tool_input?.file_path;
  if (isMemoryPath(target, cwd) || isScratchpadPath(target, cwd, input?.session_id)) return;
  if (reportAllowed(target, cwd, input)) return;
  process.stderr.write(`Blocked by agent-memory-only: ${DENY_TEXT}\n`);
  process.exitCode = 2;
}

const DENY_TEXT = 'this agent is read-only; it may write only under ~/.claude/agent-memory/ or the scratchpad of this session; report files '
  + 'go under the scratchpad folder of this session (named in your brief), never inside a repository, or as a new review-<name>-<8 hex>.md / '
  + 'security-audit-<name>-<8 hex>.md directly in the REPORTS: folder of your brief (outside any repository)';

/** The reports rule, failing closed: any error while reading the map or the folder denies. */
function reportAllowed(target, cwd, input) {
  try {
    return isNewReportPath(target, cwd, briefReportsFolder(input), input?.tool_name);
  } catch {
    return false; // deny: the write is refused, nothing else depends on it
  }
}

/** PostToolUse: record the brief; a failure only leaves that agent's reports denied, so the lead's Agent call is never blocked. */
function recordOrSay(input) {
  try {
    recordBrief(input);
  } catch (error) {
    process.stderr.write(`agent-memory-only: brief not stored (${error instanceof Error ? error.name : typeof error}); its reports stay denied\n`);
  }
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
