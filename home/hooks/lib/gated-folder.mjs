// The folder whose git state a Stop or SubagentStop gate looks at, and the hardened git calls that read it. Shared by commit-gate.mjs and
// git-tidy-gate.mjs.
// Exports: runGit, gitOut, gitSucceeds, gitText (git in a folder, hardened), startFolder(transcriptPath), gatedFolder(input, env),
// worktreeOf(folder).
// Invariants:
// - gatedFolder is the session's own worktree folder: for the main session CLAUDE_PROJECT_DIR, for a subagent the first `cwd` of its
//   transcript (null for an agent that cannot write files). Never the hook input's cwd: a folder the session only cd'd into may be
//   someone else's repo, and its git config is not trusted.
// - git never runs a program the repository names: every call has core.fsmonitor off, core.hooksPath empty and bare-repo discovery off,
//   and the variables that point git at another repository are removed.
// - Nothing here throws: a missing or unreadable input gives null.
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { devNull } from 'node:os';
import { isAbsolute } from 'node:path';
import { agentFileWrites } from './writer-agents.mjs';

const TRANSCRIPT_HEAD_BYTES = 4 * 1024 * 1024; // the first transcript line holds the brief, which can be long
const REPOSITORY_VARIABLES = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'];
// config that would make a read-only git call run a program; given on the command line, so it beats the repository's own config
const HARDENED = ['-c', 'core.fsmonitor=false', '-c', 'safe.bareRepository=explicit', '-c', `core.hooksPath=${devNull}`];
const READ_ONLY_BUILT_INS = new Set(['Explore', 'Plan']);

/** git in `cwd`, hardened, without the variables that point at another repository and without taking optional locks. */
export function runGit(cwd, args) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const name of REPOSITORY_VARIABLES) delete env[name];
  return spawnSync('git', [...HARDENED, ...args], { cwd, encoding: 'utf8', env });
}

export const gitOut = (cwd, args) => {
  const result = runGit(cwd, args);
  return result.status === 0 ? result.stdout : null;
};
export const gitSucceeds = (cwd, args) => runGit(cwd, args).status === 0;
export const gitText = (cwd, args) => (gitOut(cwd, args) ?? '').trim();

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

/** The worktree of `folder`: {top, gitDir, branch}, or null outside a worktree or before the first commit. */
export function worktreeOf(folder) {
  const out = gitOut(folder, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--abbrev-ref', 'HEAD']);
  if (out === null) return null;
  const [top, gitDir, branch] = out.trim().split('\n');
  return top && gitDir && branch ? { top, gitDir, branch } : null;
}
