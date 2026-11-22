// The folder whose git state a Stop or SubagentStop gate looks at, and the hardened git calls that read it. Shared by commit-gate.mjs and
// git-tidy-gate.mjs.
// Exports: runGit, gitOut, gitSucceeds, gitText (git in a folder, hardened), startFolder(transcriptPath), gatedFolder(input, env),
// worktreeOf(folder, timeoutMs), namesFilterProgram(top), readHead(path, maxBytes), editedWorktrees(session, env, options).
// Invariants:
// - gatedFolder is the session's own worktree folder: for the main session CLAUDE_PROJECT_DIR, for a subagent the first `cwd` of its
//   transcript (null for an agent that cannot write files). Never the hook input's cwd: a folder the session only cd'd into may be
//   someone else's repo, and its git config is not trusted.
// - git never runs a program the repository names: every call has core.fsmonitor off, core.hooksPath empty, log.showSignature off and bare-repo discovery off,
//   and the variables that point git at another repository are removed.
// - editedWorktrees is the worktrees of the files the session itself edited (lib/own-edits.mjs records): the only other folders a lead's
//   gate may look at, for a session started where there is no repo (~). git runs only in the folder of a recorded file, never elsewhere.
//   Each repository counts once however many of its worktrees were edited in (they share one git folder).
// - Finding a worktree is time-bound: a folder whose git state never answers (a stale network mount, a pipe where HEAD should be) is given
//   up on after DISCOVERY_TIMEOUT_MS and counts as no worktree, so a stop is never held by it.
// - Nothing here throws: a missing or unreadable input gives null.
import { spawnSync } from 'node:child_process';
import { existsSync, readSync } from 'node:fs';
import { devNull } from 'node:os';
import { dirname, isAbsolute, sep } from 'node:path';
import { LEAD, recordedPaths } from './own-edits.mjs';
import { readPlainFileWith } from './plain-file.mjs';
import { agentFileWrites } from './writer-agents.mjs';

const TRANSCRIPT_HEAD_BYTES = 4 * 1024 * 1024; // the first transcript line holds the brief, which can be long
const REPOSITORY_VARIABLES = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'];
// config that would make a read-only git call run a program; given on the command line, so it beats the repository's own config
// (log.showSignature runs gpg.program for a signed commit; core.fsmonitor and core.hooksPath name a program directly)
const HARDENED = [
  '-c', 'core.fsmonitor=false', '-c', 'safe.bareRepository=explicit', '-c', `core.hooksPath=${devNull}`, '-c', 'log.showSignature=false',
];
const REPOSITORY_SCOPES = new Set(['local', 'worktree']); // config that comes with the repository, not the owner's own
const MAX_EDITED_WORKTREES = 5; // repos one stop looks at; a session that edited in more is not held up by all of them
const DISCOVERY_TIMEOUT_MS = 3000; // one `rev-parse` that finds a folder's worktree; it normally takes a few ms
const MAX_FOLDERS_PROBED = 30; // folders of recorded files asked for their worktree, newest edit first
const READ_ONLY_BUILT_INS = new Set(['Explore', 'Plan']);

/**
 * git in `cwd`, hardened, without the variables that point at another repository and without taking optional locks.
 * `timeoutMs` (default: none) kills git that has not finished by then; its result then has `error.code === 'ETIMEDOUT'` and no status.
 */
export function runGit(cwd, args, timeoutMs) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const name of REPOSITORY_VARIABLES) delete env[name];
  return spawnSync('git', [...HARDENED, ...args], { cwd, encoding: 'utf8', env, timeout: timeoutMs, killSignal: 'SIGKILL' });
}

export const gitOut = (cwd, args, timeoutMs) => {
  const result = runGit(cwd, args, timeoutMs);
  return result.status === 0 ? result.stdout : null;
};
export const gitSucceeds = (cwd, args) => runGit(cwd, args).status === 0;
export const gitText = (cwd, args) => (gitOut(cwd, args) ?? '').trim();

/**
 * The first `maxBytes` of a regular file as text; null when it is missing, a link, not a regular file or unreadable. Opened without
 * waiting (lib/plain-file.mjs), so a FIFO at the path, even one swapped in after a check, never holds the stop.
 */
export function readHead(path, maxBytes) {
  try {
    return readPlainFileWith(path, (fd) => {
      const buffer = Buffer.alloc(maxBytes);
      return buffer.toString('utf8', 0, readSync(fd, buffer, 0, maxBytes, 0));
    });
  } catch {
    return null; // nothing to read means nothing to gate
  }
}

/** The folder an agent started in: the first absolute `cwd` among its transcript's first lines; null when there is none. */
export function startFolder(transcriptPath) {
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
  return !READ_ONLY_BUILT_INS.has(agentType) && agentFileWrites(agentType, env) !== false;
}

/** The folder whose worktree this stop gates, or null: CLAUDE_PROJECT_DIR for the main session, the start folder for a subagent. */
export function gatedFolder(input, env) {
  if (typeof input.agent_id === 'string' && input.agent_id !== '') {
    return writesFiles(input.agent_type, env) ? startFolder(input.agent_transcript_path) : null;
  }
  return typeof env.CLAUDE_PROJECT_DIR === 'string' && isAbsolute(env.CLAUDE_PROJECT_DIR) ? env.CLAUDE_PROJECT_DIR : null;
}

/**
 * The worktree of `folder`: {top, gitDir, commonDir, branch}, or null outside a worktree, before the first commit, or when git does not
 * answer within `timeoutMs`. `commonDir` is the git folder all worktrees of one repository share.
 */
export function worktreeOf(folder, timeoutMs = DISCOVERY_TIMEOUT_MS) {
  const out = gitOut(folder, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--path-format=absolute', '--git-common-dir', '--abbrev-ref', 'HEAD'], timeoutMs);
  if (out === null) return null;
  const [top, gitDir, commonDir, branch] = out.trim().split('\n');
  return top && gitDir && commonDir && branch ? { top, gitDir, commonDir, branch } : null;
}

/** True when the repository's own config (includes followed) defines a filter, or cannot be read: status would run it. */
export function namesFilterProgram(top) {
  const list = gitOut(top, ['config', '--list', '--name-only', '--show-scope']);
  if (list === null) return true;
  return list.split('\n').some((line) => {
    const [scope, key = ''] = line.split('\t');
    return REPOSITORY_SCOPES.has(scope) && key.toLowerCase().startsWith('filter.');
  });
}

/**
 * The worktrees holding the files this session (the lead and its agents) edited, newest edit first, one per repository.
 * A folder of a file that is already inside a found worktree is not asked again; a file whose folder is gone is skipped.
 * @param {string} session the session id
 * @param {Record<string, string | undefined>} env HOME (the edit records)
 * @param {{deadlineMs?: number, except?: {top: string, commonDir: string} | null}} [options] `deadlineMs`: epoch ms after which no
 *   further folder is asked (the first always is); `except`: a worktree whose repository is already looked at, so it is left out
 * @returns {{top: string, gitDir: string, commonDir: string, branch: string}[]} at most MAX_EDITED_WORKTREES
 */
export function editedWorktrees(session, env, { deadlineMs = Infinity, except = null } = {}) {
  const found = [];
  let probed = 0;
  for (const file of [...recordedPaths(env, session, LEAD)].reverse()) {
    if (found.length >= MAX_EDITED_WORKTREES || probed >= MAX_FOLDERS_PROBED || (probed > 0 && Date.now() >= deadlineMs)) break;
    const folder = dirname(file);
    const looked = except === null ? found : [except, ...found];
    if (looked.some(({ top }) => folder === top || folder.startsWith(top + sep)) || !existsSync(folder)) continue;
    probed += 1;
    const tree = worktreeOf(folder);
    if (tree !== null && !looked.some(({ commonDir }) => commonDir === tree.commonDir)) found.push(tree);
  }
  return found;
}
