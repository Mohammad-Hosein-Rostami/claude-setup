// Stop and SubagentStop: blocks a stop once when the session's own git worktree has uncommitted work, so a run never ends with
// edits left lying around (C16). Exports: decide(input, env) -> {block: false} | {block: true, reason}, dirtyCount(status).
// Invariants:
// - Only the session's own worktree is gated: for the main session the one holding CLAUDE_PROJECT_DIR, for a subagent the one
//   holding the folder it started in (the first `cwd` of its transcript). Never the hook input's cwd: a folder the session only
//   cd'd into may be someone else's repo, and its git config is not trusted.
// - git never runs a program the repository names: every call has core.fsmonitor off, core.hooksPath empty and bare-repo discovery
//   off (a package laid out like a bare repo is not a repository here); a worktree whose repo-level config (includes followed)
//   defines a filter is passed without a word, since `git status` would run its clean command. Submodules are not looked into.
// - Blocks at most once per dirty state of each agent: the state is the agent id, the worktree path and the hash of
//   `git status --porcelain=v1 -z`, kept in ~/.claude/state/commit-gate/<session>.json (lib/session-store.mjs). A continued stop
//   (stop_hook_active, another gate blocked first) is checked too, but gets at most MAX_CHAINED_BLOCKS blocks in a row, so the gate
//   can never loop. A state that cannot be stored is not blocked.
// - A subagent whose definition cannot write files (built-in Explore and Plan, or an agent file whose `tools:` line has no Write or
//   Edit) is never told to commit: the edits it sees are someone else's.
// - Passes without a word: not a git worktree, a branch with no commit yet, a rebase/merge/cherry-pick/revert in progress, and
//   files git ignores (.gitignore, .git/info/exclude: STATUS.md and other work notes).
// - When the branch was moved under the folder (its index equals an earlier reflog position behind the tip), the staged changes
//   are that gap, not work: the reason gives the sync command instead of "commit them". When the dirty worktree has the base branch
//   (main, master, develop) checked out and other worktrees exist, the reason adds that edits belong in a lane worktree.
// - Any internal error is one stderr line and exit 0: a session is never trapped. A few git calls, well under 300 ms.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { devNull, homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readSessionFile, withSessionLock, writeSessionFile } from './lib/session-store.mjs';

const PASS = Object.freeze({ block: false });
const BASE_BRANCHES = new Set(['main', 'master', 'develop']);
// files git keeps in the worktree's git folder while an operation waits for the user
const IN_PROGRESS_MARKERS = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];
const STATES_KEPT = 50; // dirty states remembered per session; older ones may block once more, which is harmless
const MAX_STORE_BYTES = 16 * 1024;
const MAX_CHAINED_BLOCKS = 2; // blocks given to continued stops in a row, a hard bound on how long a stop can be held
const BRANCH_POSITIONS_CHECKED = 50; // reflog entries searched for the index (as git-tidy's stale-checkout)
const TRANSCRIPT_HEAD_BYTES = 4 * 1024 * 1024; // the first transcript line holds the brief, which can be long
const AGENT_FILE_BYTES = 64 * 1024;
const REPOSITORY_VARIABLES = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'];
// config that would make a read-only git call run a program; given on the command line, so it beats the repository's own config
const HARDENED = ['-c', 'core.fsmonitor=false', '-c', 'safe.bareRepository=explicit', '-c', `core.hooksPath=${devNull}`];
const REPOSITORY_SCOPES = new Set(['local', 'worktree']); // config that comes with the repository, not the owner's own
const RENAME_OR_COPY = /^[RC]|^.[RC]/; // in -z output such an entry is followed by its old path as one more field
const READ_ONLY_BUILT_INS = new Set(['Explore', 'Plan']);
const AGENT_TYPE = /^[\w-]{1,64}$/; // a name that can be a file name part; plugin agents (`plugin:name`) are gated
const WRITING_TOOLS = /\b(?:Write|Edit|MultiEdit|NotebookEdit)\b/;

const stateDir = (env) => join(env.HOME || env.USERPROFILE || homedir(), '.claude', 'state', 'commit-gate');

/** git in `cwd`, hardened, without the variables that point at another repository and without taking optional locks. */
function runGit(cwd, args) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const name of REPOSITORY_VARIABLES) delete env[name];
  return spawnSync('git', [...HARDENED, ...args], { cwd, encoding: 'utf8', env });
}

const gitOut = (cwd, args) => {
  const result = runGit(cwd, args);
  return result.status === 0 ? result.stdout : null;
};
const gitSucceeds = (cwd, args) => runGit(cwd, args).status === 0;
const gitText = (cwd, args) => (gitOut(cwd, args) ?? '').trim();

/**
 * Number of changed paths in `git status --porcelain=v1 -z` output (a rename counts once; an untracked folder counts once).
 * @param {string} status the raw output
 * @returns {number}
 */
export function dirtyCount(status) {
  const fields = status.split('\0').filter((field) => field !== '');
  let count = 0;
  for (let i = 0; i < fields.length; i += 1) {
    count += 1;
    if (RENAME_OR_COPY.test(fields[i])) i += 1;
  }
  return count;
}

/** The first `maxBytes` of a regular file as text; null when it is missing, not a regular file or unreadable. */
function readHead(path, maxBytes) {
  try {
    if (!statSync(path).isFile()) return null;
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      return buffer.toString('utf8', 0, readSync(fd, buffer, 0, maxBytes, 0));
    } finally {
      closeSync(fd);
    }
  } catch {
    return null; // nothing to read means nothing to gate
  }
}

/** The folder an agent started in: the first absolute `cwd` among its transcript's first lines; null when there is none. */
function startFolder(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !isAbsolute(transcriptPath)) return null;
  for (const line of (readHead(transcriptPath, TRANSCRIPT_HEAD_BYTES) ?? '').split('\n')) {
    try {
      const { cwd } = JSON.parse(line);
      if (typeof cwd === 'string' && isAbsolute(cwd)) return cwd;
    } catch {
      // a line cut at the read cap, or not JSON: look at the next one
    }
  }
  return null;
}

/** False for an agent type that cannot write files: a read-only built-in, or an agent file whose `tools:` line names no writer. */
function writesFiles(agentType, env) {
  if (READ_ONLY_BUILT_INS.has(agentType)) return false;
  if (typeof agentType !== 'string' || !AGENT_TYPE.test(agentType)) return true;
  const home = env.HOME || env.USERPROFILE || homedir();
  const folders = [env.CLAUDE_PROJECT_DIR, home].filter(Boolean).map((root) => join(root, '.claude', 'agents')); // project wins
  const text = folders.map((folder) => readHead(join(folder, `${agentType}.md`), AGENT_FILE_BYTES)).find((found) => found !== null);
  const tools = text?.match(/^tools:(.*)$/m);
  return !tools || WRITING_TOOLS.test(tools[1]);
}

/** The folder whose worktree this stop gates, or null: CLAUDE_PROJECT_DIR for the main session, the start folder for a subagent. */
function gatedFolder(input, env) {
  if (typeof input.agent_id === 'string' && input.agent_id !== '') {
    return writesFiles(input.agent_type, env) ? startFolder(input.agent_transcript_path) : null;
  }
  return typeof env.CLAUDE_PROJECT_DIR === 'string' && isAbsolute(env.CLAUDE_PROJECT_DIR) ? env.CLAUDE_PROJECT_DIR : null;
}

/** The worktree of `folder`: {top, gitDir, branch}, or null outside a worktree or before the first commit. */
function worktreeOf(folder) {
  const out = gitOut(folder, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--abbrev-ref', 'HEAD']);
  if (out === null) return null;
  const [top, gitDir, branch] = out.trim().split('\n');
  return top && gitDir && branch ? { top, gitDir, branch } : null;
}

/** True when the repository's own config (includes followed) defines a filter, or cannot be read: status would run it. */
function namesFilterProgram(top) {
  const list = gitOut(top, ['config', '--list', '--name-only', '--show-scope']);
  if (list === null) return true;
  return list.split('\n').some((line) => {
    const [scope, key = ''] = line.split('\t');
    return REPOSITORY_SCOPES.has(scope) && key.toLowerCase().startsWith('filter.');
  });
}

function hasLanes(top) {
  const list = gitOut(top, ['worktree', 'list', '--porcelain']);
  return list !== null && list.split('\n').filter((line) => line.startsWith('worktree ')).length > 1;
}

/** The sync advice when `branch` moved forward under the folder (index = an earlier reflog position behind the tip), else null. */
function staleReason({ top, branch }) {
  if (gitSucceeds(top, ['diff-index', '--cached', '--quiet', 'HEAD'])) return null;
  const tip = gitText(top, ['rev-parse', 'HEAD']);
  const positions = gitText(top, ['rev-list', '--walk-reflogs', `--max-count=${BRANCH_POSITIONS_CHECKED}`, `refs/heads/${branch}`]);
  const indexAt = [...new Set(positions.split('\n'))].filter((hash) => hash !== '' && hash !== tip)
    .find((hash) => gitSucceeds(top, ['diff-index', '--cached', '--quiet', hash]) && gitSucceeds(top, ['merge-base', '--is-ancestor', hash, tip]));
  if (indexAt === undefined) return null;
  const [from, to] = [indexAt, tip].map((hash) => gitText(top, ['rev-parse', '--short', hash]));
  const behind = gitText(top, ['rev-list', '--count', `${indexAt}..${tip}`]);
  return `Branch ${branch} moved to ${to} under ${top} while its index stayed at ${from} (${behind} commits): its staged changes `
    + 'undo landed work, so never commit or stash them. '
    + `Sync the folder: git -C ${top} reset --soft ${from} && git -C ${top} merge --ff-only ${to} (unstaged edits stay; it refuses rather than overwrite one).`;
}

function reasonFor(tree, count) {
  const stale = staleReason(tree);
  if (stale !== null) return stale;
  const { top, branch } = tree;
  const reason = `Uncommitted changes in ${top} (${count} files): commit them as small Conventional Commits `
    + '(`git commit -m ... -- <paths>`), or say in your reply why they must stay uncommitted.';
  if (!BASE_BRANCHES.has(branch) || !hasLanes(top)) return reason;
  return `${reason} This is the base folder (${branch}) and lane worktrees exist: edits belong in a lane worktree, never in the base folder.`;
}

/** Parses the store; a corrupt or odd file reads as empty (this state may then block once more). */
function parseRecord(text) {
  try {
    const record = text === null ? {} : JSON.parse(text);
    const states = Array.isArray(record?.states) ? record.states : [];
    const chained = record?.chained !== null && typeof record?.chained === 'object' ? record.chained : {};
    return { states, chained };
  } catch {
    return { states: [], chained: {} };
  }
}

/** Records `state` for the session; true only when this stop may block (a new state, within the chain bound, and stored). */
function recordOnce(env, session, { agent, state, continued }) {
  const dir = stateDir(env);
  return withSessionLock(dir, session, () => {
    const text = readSessionFile(dir, session, MAX_STORE_BYTES);
    if (text === undefined) return false;
    const { states, chained } = parseRecord(text);
    if (states.includes(state)) return false;
    const inChain = continued ? Number(chained[agent]) || 0 : 0; // a fresh stop that blocks starts a new chain
    if (inChain >= MAX_CHAINED_BLOCKS) return false;
    const record = { states: [...states, state].slice(-STATES_KEPT), chained: { ...chained, [agent]: continued ? inChain + 1 : 0 } };
    return writeSessionFile(dir, session, JSON.stringify(record));
  }) === true;
}

/**
 * The gate decision for one Stop or SubagentStop event.
 * @param {{session_id?: string, agent_id?: string, agent_type?: string, agent_transcript_path?: string, stop_hook_active?: boolean}} input hook JSON
 * @param {Record<string, string | undefined>} [env] HOME (the state folder, user agent files) and CLAUDE_PROJECT_DIR
 * @returns {{block: false} | {block: true, reason: string}}
 */
export function decide(input, env = process.env) {
  if (input === null || typeof input !== 'object') return PASS;
  const folder = gatedFolder(input, env);
  const tree = folder === null ? null : worktreeOf(folder);
  if (tree === null || IN_PROGRESS_MARKERS.some((marker) => existsSync(join(tree.gitDir, marker))) || namesFilterProgram(tree.top)) return PASS;
  const status = gitOut(tree.top, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=all']);
  if (status === null || status === '') return PASS;
  const agent = typeof input.agent_id === 'string' ? input.agent_id : '';
  const state = createHash('sha256').update(`${agent}\0${tree.top}\0${status}`).digest('hex');
  if (!recordOnce(env, input.session_id, { agent, state, continued: input.stop_hook_active === true })) return PASS;
  return { block: true, reason: reasonFor(tree, dirtyCount(status)) };
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const result = decide(JSON.parse(await readStdin()));
  if (result.block) process.stdout.write(`${JSON.stringify({ decision: 'block', reason: result.reason })}\n`);
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`commit-gate: ${error.message}\n`); // never trap a session
  }
}
