// Stop and SubagentStop: blocks a stop once when files this session (for a subagent: this agent) changed are still uncommitted in its
// own git worktree, so a run never ends with edits left lying around (C16). PostToolUse Edit/Write/MultiEdit/NotebookEdit: records the
// changed file (lib/own-edits.mjs). PreToolUse (every tool): the first call of a session or agent takes the dirty baseline
// (lib/dirty-baseline.mjs). Exports: decide(input, env) -> {block: false} | {block: true, reason}, takeBaseline(input, env).
// Invariants:
// - Counted files: (1) recorded ones: each PostToolUse of a file tool adds [agent id ('' for the lead), real path] to
//   ~/.claude/state/commit-gate/edits/<session>.json (lib/own-edits.mjs); (2) files a Bash command made or changed: dirty now and clean,
//   or different, at the baseline of the session or agent taken at its first tool call (path + content hash), in the same worktree.
//   A subagent's stop counts its own files, the lead's stop every file of the session (its agents' too). A file in another agent's
//   record never counts for an agent, dirt from before the first tool call never counts, nor another session's recorded files. Limits:
//   another session or a non-isolated parallel agent changing files through Bash in the same worktree counts as this one's Bash; a
//   record or baseline that failed is lost (fail open: fewer files count). The baseline runs the same hardened git as the stop.
// - Only the session's own worktree is gated: for the main session the one holding CLAUDE_PROJECT_DIR, for a subagent the one
//   holding the folder it started in (the first `cwd` of its transcript). Never the hook input's cwd: a folder the session only
//   cd'd into may be someone else's repo, and its git config is not trusted.
// - git never runs a program the repository names: every call has core.fsmonitor off, core.hooksPath empty and bare-repo discovery
//   off (a package laid out like a bare repo is not a repository here); a worktree whose repo-level config (includes followed)
//   defines a filter is passed without a word, since `git status` would run its clean command. Submodules are not looked into.
// - Blocks at most once per dirty state of each agent: the state is the agent id, the worktree path and the hash of the recorded
//   files' entries in `git status --porcelain=v1 -z`, kept in ~/.claude/state/commit-gate/<session>.json (lib/session-store.mjs). A continued stop
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
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withSessionLock } from './lib/session-lock.mjs';
import { readSessionFile, writeSessionFile } from './lib/session-store.mjs';
import { changedSinceBaseline, hasBaseline, saveBaseline } from './lib/dirty-baseline.mjs';
import { LEAD, isRecordedEntry, realPathOf, recordEditedFile, recordedPaths, statusEntries } from './lib/own-edits.mjs';
import { gatedFolder, gitOut, gitSucceeds, gitText, namesFilterProgram, worktreeOf } from './lib/gated-folder.mjs';

const PASS = Object.freeze({ block: false });
const BASE_BRANCHES = new Set(['main', 'master', 'develop']);
// files git keeps in the worktree's git folder while an operation waits for the user
const IN_PROGRESS_MARKERS = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];
const STATES_KEPT = 50; // dirty states remembered per session; older ones may block once more, which is harmless
const MAX_STORE_BYTES = 16 * 1024;
const MAX_CHAINED_BLOCKS = 2; // blocks given to continued stops in a row, a hard bound on how long a stop can be held
const BRANCH_POSITIONS_CHECKED = 50; // reflog entries searched for the index (as git-tidy's stale-checkout)

const stateDir = (env) => join(env.HOME || env.USERPROFILE || homedir(), '.claude', 'state', 'commit-gate');

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
  const agent = typeof input.agent_id === 'string' ? input.agent_id : LEAD;
  const recorded = recordedPaths(env, input.session_id, agent);
  if (recorded.size === 0 && !hasBaseline(env, input.session_id, agent)) return PASS; // nothing changed by this session or agent: no git call
  const folder = gatedFolder(input, env);
  const tree = folder === null ? null : worktreeOf(folder);
  if (tree === null || IN_PROGRESS_MARKERS.some((marker) => existsSync(join(tree.gitDir, marker))) || namesFilterProgram(tree.top)) return PASS;
  const status = dirtyStatus(tree.top);
  if (status === null || status === '') return PASS;
  const top = realPathOf(tree.top);
  const entries = statusEntries(status, top);
  const others = agent === LEAD ? new Set() : recordedPaths(env, input.session_id, LEAD); // every agent's; own ones are matched first
  const recordedHere = entries.filter((entry) => isRecordedEntry(entry, recorded));
  const unrecorded = entries.filter((entry) => !isRecordedEntry(entry, recorded) && !isRecordedEntry(entry, others));
  const own = [...recordedHere, ...changedSinceBaseline(env, input.session_id, agent, top, unrecorded)].map(({ field }) => field);
  if (own.length === 0) return PASS;
  const state = createHash('sha256').update(`${agent}\0${tree.top}\0${own.join('\0')}`).digest('hex');
  if (!recordOnce(env, input.session_id, { agent, state, continued: input.stop_hook_active === true })) return PASS;
  return { block: true, reason: reasonFor(tree, own.length) };
}

const dirtyStatus = (top) => gitOut(top, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=all']);

/**
 * At the first tool call of the session or agent: stores which files of its worktree are dirty, and how (lib/dirty-baseline.mjs), so a
 * stop can tell files Bash made from dirt that was there before. Later calls only check that a baseline exists.
 * @param {{session_id?: string, agent_id?: string, cwd?: string}} input PreToolUse hook JSON (an agent's cwd is the folder it works in)
 * @param {Record<string, string | undefined>} [env] HOME and CLAUDE_PROJECT_DIR (the lead's worktree)
 */
export function takeBaseline(input, env = process.env) {
  const agent = typeof input?.agent_id === 'string' ? input.agent_id : LEAD;
  if (hasBaseline(env, input?.session_id, agent)) return;
  const folder = agent === LEAD ? env.CLAUDE_PROJECT_DIR : input.cwd;
  const tree = typeof folder === 'string' && isAbsolute(folder) ? worktreeOf(folder) : null;
  if (tree === null || namesFilterProgram(tree.top)) {
    saveBaseline(env, input.session_id, agent, null, []); // nothing to gate here: later calls skip git
    return;
  }
  const top = realPathOf(tree.top);
  const status = dirtyStatus(tree.top);
  if (status !== null) saveBaseline(env, input.session_id, agent, top, statusEntries(status, top));
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const input = JSON.parse(await readStdin());
  if (input?.hook_event_name === 'PostToolUse') {
    recordEditedFile(input);
    return;
  }
  if (input?.hook_event_name === 'PreToolUse') {
    takeBaseline(input);
    return;
  }
  const result = decide(input);
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
